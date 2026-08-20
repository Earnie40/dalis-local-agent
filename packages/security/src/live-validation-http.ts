import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { redactDeep } from './redaction.js';
import type {
  LiveActionContext,
  LiveActionDriver,
  LiveActionRequest,
  LiveArtifact,
  LiveEnvironmentObservation,
} from './live-validation-types.js';

export interface HttpLiveActionSpec {
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface LiveEnvironmentEvidenceCollector {
  /** Collects real Tomahawk1 telemetry/detection/response evidence after the service action. */
  collect(
    request: LiveActionRequest,
    serviceResponse: { statusCode: number; headers: IncomingHttpHeaders; body: string },
    context: LiveActionContext,
  ): Promise<LiveArtifact[]>;
}

function validateSpec(spec: HttpLiveActionSpec): void {
  if (!/^[A-Z]+$/.test(spec.method.toUpperCase())) throw new Error('HTTP live action method is invalid.');
  if (!Number.isSafeInteger(spec.maxResponseBytes) || spec.maxResponseBytes <= 0) {
    throw new Error('HTTP live action requires a positive maxResponseBytes limit.');
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new Error('HTTP live action requires a positive timeoutMs limit.');
  }
}

/**
 * Real HTTP(S) driver with DNS pinning. The socket connects only to the address
 * already approved by the safety controller; redirects are observed, not followed.
 */
export function createHttpLiveActionDriver(
  spec: HttpLiveActionSpec,
  evidenceCollector?: LiveEnvironmentEvidenceCollector,
): LiveActionDriver {
  validateSpec(spec);

  return async (actionRequest, context): Promise<LiveEnvironmentObservation> => {
    const targetUrl = new URL(actionRequest.target);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('HTTP live driver requires an HTTP(S) target.');
    const pinnedAddress = context.authorization.addresses[0];
    const family = isIP(pinnedAddress);
    if (!family) throw new Error('Safety controller did not provide a resolved address.');

    const body = typeof spec.body === 'string' ? Buffer.from(spec.body) : spec.body ? Buffer.from(spec.body) : undefined;
    const bytesSent = body?.byteLength ?? 0;
    if (bytesSent > 0) await context.reportNetworkUsage(bytesSent);

    const response = await new Promise<{
      statusCode: number;
      headers: IncomingHttpHeaders;
      body: string;
      bytesReceived: number;
    }>((resolve, reject) => {
      const transport = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
      let unregisterSession: () => void = () => undefined;
      let settled = false;
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        unregisterSession();
        reject(error);
      };

      const req = transport(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || undefined,
          method: spec.method.toUpperCase(),
          path: spec.path ?? `${targetUrl.pathname}${targetUrl.search}`,
          headers: spec.headers,
          signal: context.signal,
          servername: targetUrl.hostname,
          lookup: (_hostname, options, callback) => {
            if (typeof options === 'object' && options.all) {
              (callback as unknown as (error: null, records: Array<{ address: string; family: number }>) => void)(
                null,
                [{ address: pinnedAddress, family }],
              );
              return;
            }
            callback(null, pinnedAddress, family);
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytesReceived = 0;
          res.on('data', (chunk: Buffer | string) => {
            res.pause();
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytesReceived += value.byteLength;
            if (bytesReceived > spec.maxResponseBytes) {
              req.destroy(new Error('Live service response exceeded maxResponseBytes.'));
              return;
            }
            chunks.push(value);
            void context
              .reportNetworkUsage(value.byteLength)
              .then(() => res.resume())
              .catch((error) => req.destroy(error as Error));
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            unregisterSession();
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
              bytesReceived,
            });
          });
          res.on('error', finishReject);
        },
      );
      unregisterSession = context.registerOutboundSession(() => {
        req.destroy(new Error('Live validation stopped.'));
      });
      req.setTimeout(spec.timeoutMs, () => req.destroy(new Error('Live service request timed out.')));
      req.on('error', finishReject);
      if (body) req.write(body);
      req.end();
    });

    const sanitizedResponse = redactDeep({
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    });
    const artifacts: LiveArtifact[] = [
      {
        kind: 'service-response',
        source: 'LIVE_ENVIRONMENT',
        observedAt: new Date(),
        data: sanitizedResponse,
      },
    ];
    if (evidenceCollector) {
      const collected = await evidenceCollector.collect(actionRequest, response, context);
      artifacts.push(...collected);
    }

    return {
      source: 'LIVE_ENVIRONMENT',
      observedAt: new Date(),
      observedResult: sanitizedResponse,
      artifacts,
      contactedTargets: [actionRequest.target],
      bytesSent,
      bytesReceived: response.bytesReceived,
    };
  };
}
