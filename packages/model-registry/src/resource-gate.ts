import { freemem, totalmem } from 'node:os';

/**
 * Resource gate for training runs.
 *
 * A fine-tune that exhausts VRAM or fills the disk does not fail politely — it
 * takes the machine down with it, and on a local-first platform that machine is
 * also the user's workstation. This gate is checked *before* a run starts.
 *
 * It is fail-closed in the specific way that matters: an unknown resource is
 * treated as unavailable, never as sufficient. "I could not measure VRAM" must
 * block a GPU run, because the alternative is discovering the answer by
 * crashing.
 */

export interface ResourceBudget {
  /** Maximum VRAM the run may occupy. */
  maxVramBytes: number;
  /** Wall-clock ceiling; a run without one can hold the machine indefinitely. */
  maxDurationMs: number;
  /** Disk needed for checkpoints and the merged adapter. */
  maxDiskBytes: number;
  /** Headroom left free for the rest of the system. */
  minFreeRamBytes: number;
  /** When true, a run may not fall back to CPU. */
  requireGpu: boolean;
}

export interface ResourceSnapshot {
  /** Undefined means "could not be measured", which is not the same as zero. */
  totalVramBytes?: number;
  freeVramBytes?: number;
  freeRamBytes: number;
  freeDiskBytes?: number;
  gpuAvailable: boolean;
  /** Models currently resident in the inference server, which hold VRAM. */
  residentModels: { name: string; sizeBytes: number; onGpu: boolean }[];
  measuredAt: string;
}

export interface ResourceDecision {
  permitted: boolean;
  reasons: string[];
  /** What was actually measured, so a denial is explainable. */
  snapshot: ResourceSnapshot;
}

export const DEFAULT_TRAINING_BUDGET: ResourceBudget = {
  maxVramBytes: 8 * 1024 ** 3,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxDiskBytes: 20 * 1024 ** 3,
  minFreeRamBytes: 4 * 1024 ** 3,
  requireGpu: false,
};

const GB = 1024 ** 3;
const gb = (bytes: number | undefined) =>
  bytes === undefined ? 'unknown' : `${(bytes / GB).toFixed(1)} GiB`;

/**
 * Reads live resource state. Ollama's /api/ps reports which models are resident
 * and how much of each sits in VRAM, which is the number that actually predicts
 * whether a training run will fit alongside current inference.
 */
export async function probeResources(
  options: { ollamaBaseUrl?: string; freeDiskBytes?: number; signal?: AbortSignal } = {},
): Promise<ResourceSnapshot> {
  const baseUrl = (options.ollamaBaseUrl ?? process.env.OLLAMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

  let residentModels: ResourceSnapshot['residentModels'] = [];
  let gpuAvailable = false;
  let totalVramBytes: number | undefined;
  let freeVramBytes: number | undefined;

  try {
    const response = await fetch(`${baseUrl}/api/ps`, { signal: options.signal });
    if (response.ok) {
      const payload = (await response.json()) as {
        models?: { name?: string; size?: number; size_vram?: number }[];
      };
      residentModels = (payload.models ?? []).map((m) => ({
        name: m.name ?? '(unnamed)',
        sizeBytes: m.size ?? 0,
        onGpu: (m.size_vram ?? 0) > 0,
      }));
      gpuAvailable = residentModels.some((m) => m.onGpu);
    }
  } catch {
    // Inference server unreachable. VRAM stays undefined rather than being
    // guessed at, which the gate treats as unmeasured.
  }

  // Ollama does not report total or free VRAM, only per-model usage. Reporting
  // a derived figure would be inventing a measurement, so both stay undefined
  // unless a real source provides them.
  void totalVramBytes;
  void freeVramBytes;

  return {
    totalVramBytes,
    freeVramBytes,
    freeRamBytes: freemem(),
    freeDiskBytes: options.freeDiskBytes,
    gpuAvailable,
    residentModels,
    measuredAt: new Date().toISOString(),
  };
}

export function checkResourceGate(
  budget: ResourceBudget,
  snapshot: ResourceSnapshot,
): ResourceDecision {
  const reasons: string[] = [];

  if (budget.maxDurationMs <= 0) {
    reasons.push('Budget declares no positive time ceiling; an unbounded run is not permitted.');
  }

  if (snapshot.freeRamBytes < budget.minFreeRamBytes) {
    reasons.push(
      `Free RAM ${gb(snapshot.freeRamBytes)} is below the required headroom ${gb(budget.minFreeRamBytes)} (total ${gb(totalmem())}).`,
    );
  }

  if (snapshot.freeDiskBytes === undefined) {
    reasons.push('Free disk space could not be measured; a run that fills the disk is not permitted.');
  } else if (snapshot.freeDiskBytes < budget.maxDiskBytes) {
    reasons.push(
      `Free disk ${gb(snapshot.freeDiskBytes)} is below the ${gb(budget.maxDiskBytes)} the run may need.`,
    );
  }

  if (budget.requireGpu) {
    if (!snapshot.gpuAvailable) {
      reasons.push('A GPU was required but none was observed in use by the inference server.');
    }
    if (snapshot.freeVramBytes === undefined) {
      reasons.push('Free VRAM could not be measured; a GPU run is refused rather than discovered by crashing.');
    } else if (snapshot.freeVramBytes < budget.maxVramBytes) {
      reasons.push(
        `Free VRAM ${gb(snapshot.freeVramBytes)} is below the ${gb(budget.maxVramBytes)} budget.`,
      );
    }
  }

  const residentOnGpu = snapshot.residentModels.filter((m) => m.onGpu);
  if (budget.requireGpu && residentOnGpu.length) {
    reasons.push(
      `Inference models currently hold VRAM: ${residentOnGpu.map((m) => `${m.name} (${gb(m.sizeBytes)})`).join(', ')}. Unload them before training.`,
    );
  }

  return { permitted: reasons.length === 0, reasons, snapshot };
}

/** Convenience: probe and check in one call. */
export async function evaluateResourceGate(
  budget: ResourceBudget = DEFAULT_TRAINING_BUDGET,
  options: Parameters<typeof probeResources>[0] = {},
): Promise<ResourceDecision> {
  return checkResourceGate(budget, await probeResources(options));
}

export function formatResourceDecision(decision: ResourceDecision): string {
  const lines = [
    decision.permitted ? 'RESOURCE GATE: PASS' : 'RESOURCE GATE: BLOCKED',
    `  free RAM   ${gb(decision.snapshot.freeRamBytes)}`,
    `  free disk  ${gb(decision.snapshot.freeDiskBytes)}`,
    `  free VRAM  ${gb(decision.snapshot.freeVramBytes)}`,
    `  GPU in use ${decision.snapshot.gpuAvailable}`,
    `  resident   ${decision.snapshot.residentModels.length ? decision.snapshot.residentModels.map((m) => m.name).join(', ') : '(none)'}`,
  ];
  for (const reason of decision.reasons) lines.push(`  BLOCKED: ${reason}`);
  return lines.join('\n');
}
