import type { ProviderInstance } from '@dacai-local-agent/shared';

/**
 * Is the RunPod GPU usable for inference *right now*?
 *
 * "Configured" and "usable" are different questions, and only the second one
 * can decide routing: RunPod pods are stopped, restarted on new hosts, and
 * replaced, so a pod that is funded and RUNNING can still have no Ollama
 * serving behind the tunnel. The probe therefore answers with the endpoint
 * itself and treats the RunPod control plane purely as an explanation for a
 * negative result -- which pod exists, and whether it is merely stopped.
 *
 * The answer is cached for a short interval so that preferring the GPU does not
 * add a round trip to every model resolution, and so a stopped pod is not
 * re-queried once per request.
 */

export type GpuUnavailableReason =
  | 'not-configured'
  | 'account-unfunded'
  | 'no-pod'
  | 'pod-not-running'
  | 'endpoint-unreachable';

export interface RunpodPodSummary {
  id: string;
  name?: string;
  /** RunPod desiredStatus: RUNNING, EXITED, TERMINATED, ... */
  status: string;
  costPerHr?: number;
  gpu?: string;
}

export interface RunpodPodPresence {
  /** Every pod on the account, including stopped ones. */
  pods: RunpodPodSummary[];
  /** The pod pinned by RUNPOD_ID, when it still exists. */
  preferredPodId?: string;
  /** Prepaid RunPod credit balance, when the control plane exposes it. */
  clientBalanceUsd?: number;
  /** Whether the account has positive prepaid credit. Undefined means unknown. */
  funded?: boolean;
}

/** Injected by the server so this package never talks to the RunPod API itself. */
export type PodPresenceResolver = () => Promise<RunpodPodPresence | undefined>;

export interface GpuAvailability {
  /** The GPU inference endpoint answered within the probe timeout. */
  usable: boolean;
  instanceId: string;
  /** Models the pod currently serves. Empty when it is unreachable. */
  models: string[];
  reason?: GpuUnavailableReason;
  /** One sentence, safe to show the operator verbatim. Never contains credentials. */
  detail: string;
  pod?: RunpodPodSummary;
  account?: {
    balanceUsd?: number;
    funded?: boolean;
    pods: Array<Pick<RunpodPodSummary, 'id' | 'name' | 'status' | 'costPerHr' | 'gpu'>>;
  };
  checkedAt: string;
}

export interface GpuAvailabilityProbeOptions {
  instance?: ProviderInstance;
  /** How long a result is reused before the endpoint is probed again. */
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  podPresence?: PodPresenceResolver;
  /**
   * Restores a configured inference path after a failed endpoint probe.
   *
   * The server uses this to rediscover a running pod, restore its SSH tunnel,
   * and start an already-provisioned Ollama service. It must not create or
   * start a stopped billable pod.
   */
  recoverEndpoint?: () => Promise<void>;
  now?: () => number;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: unknown; model?: unknown }>;
}

export class GpuAvailabilityProbe {
  private cached?: GpuAvailability;
  private cachedAt = 0;
  private inflight?: Promise<GpuAvailability>;

  constructor(private readonly options: GpuAvailabilityProbeOptions = {}) {}

  /** Latest known answer without probing. Undefined until the first evaluate(). */
  lastKnown(): GpuAvailability | undefined {
    return this.cached;
  }

  async evaluate(force = false): Promise<GpuAvailability> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 30_000;
    if (!force && this.cached && now - this.cachedAt < ttl) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.probe()
      .then((availability) => {
        this.cached = availability;
        this.cachedAt = (this.options.now ?? Date.now)();
        return availability;
      })
      .finally(() => {
        this.inflight = undefined;
      });

    return this.inflight;
  }

  private async probe(): Promise<GpuAvailability> {
    const instance = this.options.instance;
    const instanceId = instance?.id ?? 'remote_gpu_ollama';
    const checkedAt = new Date((this.options.now ?? Date.now)()).toISOString();

    if (!instance?.enabled || !instance.baseUrl) {
      return {
        usable: false,
        instanceId,
        models: [],
        reason: 'not-configured',
        detail:
          'No GPU pod is configured for inference. Set RUNPOD_API_KEY, RUNPOD_CONNECTION, or OLLAMA_REMOTE_BASE_URL to enable GPU discovery.',
        checkedAt,
      };
    }

    // Account funding is checked before touching the inference endpoint. A
    // zero/negative prepaid balance is an explicit local-fallback condition;
    // do not spend a request against a pod RunPod will stop or reject.
    const presence = this.options.podPresence ? await this.presence() : undefined;
    const account = presence
      ? {
          balanceUsd: presence.clientBalanceUsd,
          funded: presence.funded,
          pods: presence.pods.map(({ id, name, status, costPerHr, gpu }) => ({ id, name, status, costPerHr, gpu })),
        }
      : undefined;
    if (presence?.funded === false) {
      return {
        usable: false,
        instanceId,
        models: [],
        reason: 'account-unfunded',
        detail:
          `RunPod account balance is ${presence.clientBalanceUsd?.toFixed(2) ?? 'zero'} USD; ` +
          'GPU work is disabled and inference stays local until the account is funded.',
        account,
        checkedAt,
      };
    }

    let models = await this.fetchModels(instance);
    if (!models && this.options.recoverEndpoint) {
      // Do not turn an availability check into a pod-start action. Recovery is
      // only appropriate for a pod the control plane already reports RUNNING;
      // when the control plane itself is unavailable, the injected recovery
      // hook may still restore a stale tunnel using the configured connection.
      const mayRecover =
        !presence || presence.pods.some((pod) => pod.status === 'RUNNING');
      if (mayRecover) {
        try {
          await this.options.recoverEndpoint();
        } catch {
          // The normal negative availability result below carries the safe,
          // operator-facing explanation. Never leak SSH or provider errors.
        }
        models = await this.fetchModels(instance);
      }
    }
    if (models) {
      return {
        usable: true,
        instanceId,
        models,
        detail:
          models.length > 0
            ? `GPU pod inference is reachable on "${instanceId}" serving ${models.length} model(s).`
            : `GPU pod inference is reachable on "${instanceId}" but no model is installed on the pod yet.`,
        pod: await this.preferredPod(),
          account,
        checkedAt,
      };
    }

    return { ...(await this.explainUnreachable(instanceId)), checkedAt };
  }

  private async fetchModels(instance: ProviderInstance): Promise<string[] | undefined> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `${instance.baseUrl?.replace(/\/+$/, '')}/api/tags`;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_500),
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as OllamaTagsResponse;
      return (payload.models ?? [])
        .map((entry) => (typeof entry.name === 'string' ? entry.name : entry.model))
        .filter((name): name is string => typeof name === 'string');
    } catch {
      return undefined;
    }
  }

  private async presence(): Promise<RunpodPodPresence | undefined> {
    if (!this.options.podPresence) return undefined;
    try {
      return await this.options.podPresence();
    } catch {
      return undefined;
    }
  }

  private async preferredPod(): Promise<RunpodPodSummary | undefined> {
    const presence = await this.presence();
    if (!presence) return undefined;
    return (
      presence.pods.find((pod) => pod.id === presence.preferredPodId) ??
      presence.pods.find((pod) => pod.status === 'RUNNING')
    );
  }

  /**
   * The endpoint did not answer. The RunPod control plane distinguishes the
   * cases the operator can act on -- no pod at all, a stopped pod that can be
   * resumed, or a running pod whose tunnel or Ollama service is down.
   */
  private async explainUnreachable(instanceId: string): Promise<Omit<GpuAvailability, 'checkedAt'>> {
    const presence = await this.presence();
    const account = presence
      ? {
          balanceUsd: presence.clientBalanceUsd,
          funded: presence.funded,
          pods: presence.pods.map(({ id, name, status, costPerHr, gpu }) => ({ id, name, status, costPerHr, gpu })),
        }
      : undefined;

    if (presence?.funded === false) {
      return {
        usable: false,
        instanceId,
        models: [],
        reason: 'account-unfunded',
        detail:
          `RunPod account balance is ${presence.clientBalanceUsd?.toFixed(2) ?? 'zero'} USD; ` +
          'GPU work is disabled and inference stays local until the account is funded.',
        account,
      };
    }

    if (presence && presence.pods.length === 0) {
      return {
        usable: false,
        instanceId,
        models: [],
        reason: 'no-pod',
        detail: 'No RunPod pod exists on this account, so GPU inference is unavailable and work stays local.',
        account,
      };
    }

    const running = presence?.pods.filter((pod) => pod.status === 'RUNNING') ?? [];
    if (presence && running.length === 0) {
      const stopped = presence.pods[0];
      return {
        usable: false,
        instanceId,
        models: [],
        reason: 'pod-not-running',
        pod: stopped,
        detail:
          `RunPod pod "${stopped.name ?? stopped.id}" exists but is ${stopped.status}; ` +
          'start it to move inference onto the GPU. Work stays local until then.',
        account,
      };
    }

    const pod = running[0];
    return {
      usable: false,
      instanceId,
      models: [],
      reason: 'endpoint-unreachable',
      pod,
      detail: pod
        ? `RunPod pod "${pod.name ?? pod.id}" is RUNNING but its inference endpoint did not answer ` +
          '(SSH tunnel down, or Ollama is not serving on the pod). Work stays local until it responds.'
        : `GPU inference endpoint "${instanceId}" did not answer; work stays local until it responds.`,
      account,
    };
  }
}

/** Ollama reports `qwen3:8b`; a request for `qwen3` must still count as installed. */
export function podServesModel(availability: GpuAvailability, model: string): boolean {
  if (!availability.usable) return false;
  const wanted = model.trim().toLowerCase();
  if (!wanted) return false;
  return availability.models.some((installed) => {
    const name = installed.trim().toLowerCase();
    return name === wanted || name === `${wanted}:latest` || name.split(':')[0] === wanted;
  });
}
