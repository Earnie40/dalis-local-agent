export interface RunpodSshEndpoint {
  podId: string;
  name: string;
  host: string;
  port: number;
}

interface GraphqlPort {
  ip?: unknown;
  isIpPublic?: unknown;
  privatePort?: unknown;
  publicPort?: unknown;
  type?: unknown;
}

interface GraphqlPod {
  id?: unknown;
  name?: unknown;
  desiredStatus?: unknown;
  runtime?: { ports?: GraphqlPort[] | null } | null;
}

const RUNPOD_GRAPHQL_URL = 'https://api.runpod.io/graphql';

const POD_QUERY = `query {
  myself {
    pods {
      id
      name
      desiredStatus
      runtime { ports { ip isIpPublic privatePort publicPort type } }
    }
  }
}`;

/**
 * RunPod reassigns the public SSH host and port every time a pod starts, so a
 * connection string captured earlier goes stale silently.
 *
 * The REST pod resource is not usable for this: its `portMappings` reports a
 * single entry for container port 22 which can be the UDP mapping, and
 * connecting there is refused in a way that looks like a dead pod. Only the
 * GraphQL runtime exposes the port's protocol, so the TCP row is selected
 * explicitly here.
 */
export function selectSshEndpoint(pods: GraphqlPod[]): RunpodSshEndpoint[] {
  const endpoints: RunpodSshEndpoint[] = [];

  for (const pod of pods) {
    if (typeof pod.id !== 'string' || pod.desiredStatus !== 'RUNNING') continue;
    for (const port of pod.runtime?.ports ?? []) {
      if (Number(port.privatePort) !== 22) continue;
      if (String(port.type).toLowerCase() !== 'tcp') continue;
      if (port.isIpPublic !== true) continue;
      const publicPort = Number(port.publicPort);
      if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) continue;
      if (typeof port.ip !== 'string' || !port.ip) continue;
      endpoints.push({
        podId: pod.id,
        name: typeof pod.name === 'string' ? pod.name : pod.id,
        host: port.ip,
        port: publicPort,
      });
      break;
    }
  }

  return endpoints;
}

export interface DiscoverOptions {
  apiKey?: string;
  /** Preferred pod. When it is not running, the sole running pod is used instead. */
  podId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Resolve the SSH endpoint of a running pod, or undefined when none qualifies. */
export async function discoverRunpodSshEndpoint(
  options: DiscoverOptions = {},
): Promise<RunpodSshEndpoint | undefined> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return undefined;

  const fetchImpl = options.fetchImpl ?? fetch;
  let payload: { data?: { myself?: { pods?: GraphqlPod[] | null } | null } };

  try {
    const response = await fetchImpl(`${RUNPOD_GRAPHQL_URL}?api_key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: POD_QUERY }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (!response.ok) return undefined;
    payload = (await response.json()) as typeof payload;
  } catch {
    return undefined;
  }

  const endpoints = selectSshEndpoint(payload.data?.myself?.pods ?? []);
  if (endpoints.length === 0) return undefined;
  return endpoints.find((endpoint) => endpoint.podId === options.podId) ?? endpoints[0];
}

/** Render an endpoint as the `ssh` command form that RUNPOD_CONNECTION accepts. */
export function formatRunpodConnection(endpoint: RunpodSshEndpoint, identityFile?: string): string {
  const base = `ssh root@${endpoint.host} -p ${endpoint.port}`;
  return identityFile ? `${base} -i ${identityFile}` : base;
}
