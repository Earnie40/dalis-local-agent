import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAINING_BUDGET,
  checkResourceGate,
  formatResourceDecision,
  type ResourceSnapshot,
} from '@dacai-local-agent/model-registry';

const GB = 1024 ** 3;

const healthy: ResourceSnapshot = {
  freeRamBytes: 16 * GB,
  freeDiskBytes: 200 * GB,
  freeVramBytes: 24 * GB,
  totalVramBytes: 24 * GB,
  gpuAvailable: true,
  residentModels: [],
  measuredAt: '2026-08-20T00:00:00.000Z',
};

describe('training resource gate', () => {
  it('permits a run when every measured resource is sufficient', () => {
    const decision = checkResourceGate(DEFAULT_TRAINING_BUDGET, healthy);
    expect(decision.permitted).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('blocks when free disk cannot be measured', () => {
    // Unknown is not "enough". A run that fills the disk takes the workstation
    // with it, so an unmeasured resource is treated as unavailable.
    const decision = checkResourceGate(DEFAULT_TRAINING_BUDGET, { ...healthy, freeDiskBytes: undefined });
    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/could not be measured/);
  });

  it('blocks when RAM headroom is below the budget', () => {
    const decision = checkResourceGate(DEFAULT_TRAINING_BUDGET, { ...healthy, freeRamBytes: 1 * GB });
    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/Free RAM/);
  });

  it('blocks when disk is below what the run may need', () => {
    const decision = checkResourceGate(DEFAULT_TRAINING_BUDGET, { ...healthy, freeDiskBytes: 1 * GB });
    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/Free disk/);
  });

  it('refuses a GPU run when VRAM could not be measured', () => {
    const budget = { ...DEFAULT_TRAINING_BUDGET, requireGpu: true };
    const decision = checkResourceGate(budget, { ...healthy, freeVramBytes: undefined });

    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/refused rather than discovered by crashing/);
  });

  it('refuses a GPU run when no GPU is in use', () => {
    const budget = { ...DEFAULT_TRAINING_BUDGET, requireGpu: true };
    const decision = checkResourceGate(budget, { ...healthy, gpuAvailable: false });

    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/GPU was required/);
  });

  it('refuses a GPU run while inference models still hold VRAM', () => {
    const budget = { ...DEFAULT_TRAINING_BUDGET, requireGpu: true };
    const decision = checkResourceGate(budget, {
      ...healthy,
      residentModels: [{ name: 'qwen3:8b', sizeBytes: 6 * GB, onGpu: true }],
    });

    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/Unload them before training/);
  });

  it('refuses a budget with no time ceiling', () => {
    const decision = checkResourceGate({ ...DEFAULT_TRAINING_BUDGET, maxDurationMs: 0 }, healthy);
    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/unbounded run/);
  });

  it('reports every failing condition, not only the first', () => {
    const decision = checkResourceGate(
      { ...DEFAULT_TRAINING_BUDGET, requireGpu: true },
      { ...healthy, freeRamBytes: 1 * GB, freeDiskBytes: 1 * GB, gpuAvailable: false, freeVramBytes: undefined },
    );
    expect(decision.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('explains a denial with what was measured', () => {
    const decision = checkResourceGate(DEFAULT_TRAINING_BUDGET, { ...healthy, freeRamBytes: 1 * GB });
    const rendered = formatResourceDecision(decision);

    expect(rendered).toContain('RESOURCE GATE: BLOCKED');
    expect(rendered).toContain('free RAM');
    expect(rendered).toContain('BLOCKED:');
  });
});
