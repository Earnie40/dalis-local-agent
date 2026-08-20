import type { OutgoingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CARRIED_HEADERS } from '../apps/server/src/routes/chat';

/**
 * reply.raw.writeHead() writes only the headers handed to it — anything set by
 * a Fastify hook (CORS above all) is discarded unless carried over explicitly.
 * The browser then rejects a response that arrived with status 200, which is
 * exactly the failure this guards against.
 */
function buildSseHeaders(hookHeaders: Record<string, string>): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };

  for (const name of CARRIED_HEADERS) {
    const value = hookHeaders[name];
    if (typeof value === 'string') headers[name] = value;
  }

  return headers;
}

describe('SSE response headers', () => {
  it('carries hook-set CORS headers onto the raw response', () => {
    const headers = buildSseHeaders({
      'access-control-allow-origin': 'http://localhost:5173',
      vary: 'Origin',
    });

    expect(headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(headers.vary).toBe('Origin');
  });

  it('carries every CORS header the browser needs for a cross-origin POST', () => {
    expect(CARRIED_HEADERS).toContain('access-control-allow-origin');
    expect(CARRIED_HEADERS).toContain('access-control-allow-headers');
    expect(CARRIED_HEADERS).toContain('access-control-allow-methods');
  });

  it('does not drag unrelated headers onto the response', () => {
    const headers = buildSseHeaders({ 'content-length': '42', etag: 'W/"abc"' });

    expect(headers['content-length']).toBeUndefined();
    expect(headers.etag).toBeUndefined();
  });

  it('keeps the SSE content type regardless of what a hook set', () => {
    const headers = buildSseHeaders({ 'Content-Type': 'application/json' });
    expect(headers['Content-Type']).toBe('text/event-stream');
  });

  it('disables buffering so chunks reach the client as they are produced', () => {
    const headers = buildSseHeaders({});
    expect(headers['Cache-Control']).toContain('no-transform');
    expect(headers['X-Accel-Buffering']).toBe('no');
  });
});
