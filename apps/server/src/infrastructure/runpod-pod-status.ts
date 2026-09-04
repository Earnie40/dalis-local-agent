import type { RunpodPodPresence, RunpodPodSummary } from '@dacai-local-agent/providers';

/**
 * Pod inventory from the RunPod control plane.
 *
 * This exists only to explain a negative reachability result: whether the
 * account has no pod at all, has one that is merely stopped and can be
 * resumed, or has a RUNNING pod whose inference service is down. Routing is
 * still decided by whether the endpoint answers -- a pod can report RUNNING
 * while Ollama is not serving behind it.
 *
 * The REST pod resource is not used here for the same reason as in
 * runpod-discovery.ts: only GraphQL reports the fields consistently.
 */

const RUNPOD_GRAPHQL_URL = 'https://api.runpod.io/graphql';

const POD_QUERY = `query {
  myself {
    clientBalance
    pods {
      id
      name
      desiredStatus
      costPerHr
      machine { gpuDisplayName }
    }
  }
}`;

interface GraphqlPod {
  id?: unknown;
  name?: unknown;
  desiredStatus?: unknown;
  costPerHr?: unknown;
  machine?: { gpuDisplayName?: unknown } | null;
}

export function normalizePods(pods: GraphqlPod[]): RunpodPodSummary[] {
  const summaries: RunpodPodSummary[] = [];
  for (const pod of pods) {
    if (typeof pod.id !== 'string' || !pod.id) continue;
    const cost = Number(pod.costPerHr);
    summaries.push({
      id: pod.id,
      name: typeof pod.name === 'string' ? pod.name : undefined,
      status: typeof pod.desiredStatus === 'string' ? pod.desiredStatus : 'UNKNOWN',
      costPerHr: Number.isFinite(cost) ? cost : undefined,
      gpu: typeof pod.machine?.gpuDisplayName === 'string' ? pod.machine.gpuDisplayName : undefined,
    });
  }
  // A RUNNING pod is the one the operator cares about first.
  return summaries.sort((left, right) => Number(right.status === 'RUNNING') - Number(left.status === 'RUNNING'));
}

export interface PodPresenceOptions {
  apiKey?: string;
  podId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Undefined means "could not ask" (no API key, network failure) and must not be
 * read as "no pods exist" -- an unfunded account and an unreachable API look
 * the same from here, and only one of them is the operator's problem.
 */
export async function resolveRunpodPodPresence(
  options: PodPresenceOptions = {},
): Promise<RunpodPodPresence | undefined> {
  const apiKey = (options.apiKey ?? process.env.RUNPOD_API_KEY)?.trim();
  if (!apiKey) return undefined;

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${RUNPOD_GRAPHQL_URL}?api_key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: POD_QUERY }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as {
      data?: { myself?: { clientBalance?: unknown; pods?: GraphqlPod[] | null } | null };
    };
    const account = payload.data?.myself;
    const pods = account?.pods;
    // GraphQL can return HTTP 200 with an `errors` payload. Treat missing pod
    // data as an unavailable control plane, not as proof that the account has
    // no pods.
    if (!Array.isArray(pods)) return undefined;
    const balance = Number(account?.clientBalance);
    return {
      pods: normalizePods(pods),
      preferredPodId: (options.podId ?? process.env.RUNPOD_ID)?.trim() || undefined,
      clientBalanceUsd: Number.isFinite(balance) ? balance : undefined,
      funded: Number.isFinite(balance) ? balance > 0 : undefined,
    };
  } catch {
    return undefined;
  }
}
