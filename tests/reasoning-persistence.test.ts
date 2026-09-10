import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReasoningState } from '../packages/agent-core/src/reasoning-controller';

const storage = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../packages/context/src/index.ts', () => ({
  loadWorkingState: vi.fn(async () => structuredClone(storage.state)),
  saveWorkingState: vi.fn(async (state: Record<string, unknown>) => { storage.state = structuredClone(state); }),
}));
vi.mock('../packages/memory/src/index.ts', () => ({ rememberFailure: vi.fn(async () => undefined) }));

import { RunStateTracker } from '../apps/server/src/run-state-tracker';
import { ResumedRunStateTracker } from '../apps/server/src/resumed-run-state-tracker';
import { checkAcceptanceCompletion } from '../apps/server/src/acceptance-criteria';
import { buildCompletionManifest } from '../apps/server/src/completion-manifest';

const goal = 'Observe my active identifier and configuration';
function state(): ReasoningState {
  return {
    version: 1, goal, successCondition: 'Both facts observed',
    requiredEvidence: ['identifier', 'configuration'].map(id => ({ id, requestClause: goal, output: id,
      successCondition: `Observe ${id}`, scope: 'user_specific', kind: 'fact', allowedProvenance: ['local_machine'] })),
    hypotheses: [], unknowns: ['configuration'], observations: [], revisions: [],
    environment: { platform: 'win32', shell: 'cmd.exe', arch: 'x64' },
    budget: { turnsRemaining: 5, toolCallsRemaining: 5, reserveTurns: 2, controlRequests: 4, maxControlRequests: 20 },
    evidence: [{ id: 'e1', observationId: 'o1', requirementId: 'identifier', claim: 'mock identifier', quote: 'mock identifier',
      source: { id: 's1', locator: 'authorized local adapter', provenance: 'local_machine', effect: 'read' },
      mode: 'observation', confidence: 1, accepted: true }],
  };
}

beforeEach(() => {
  storage.state = { threadId: 'reasoning-run', objective: goal, inspectedFiles: ['docs/example.md'],
    validationState: { acceptanceCriteria: [{ id: 'legacy', status: 'proven' }], 'tests.run': { success: true } } };
});

describe('persisted reasoning acceptance', () => {
  it('does not prove every criterion from a successful listing or test suite', async () => {
    const checked = await checkAcceptanceCompletion('reasoning-run', goal);
    expect(checked.ok).toBe(false);
    expect(checked.criteria.every(c => c.status === 'pending')).toBe(true);
    const manifest = await buildCompletionManifest({ threadId: 'reasoning-run', objective: goal });
    expect(manifest.completionEligible).toBe(false);
    expect(manifest.requirements.find(r => r.id === 'acceptance')?.status).toBe('pending');
  });

  it.each(['fresh', 'resumed'])('persists source-qualified state on %s runs and preserves partial progress', async mode => {
    const tracker = mode === 'fresh' ? new RunStateTracker('reasoning-run', goal) : new ResumedRunStateTracker('reasoning-run');
    await tracker.record({ type: 'reasoning_state', turn: 2, reasoningState: state() });
    expect((storage.state.validationState as Record<string, unknown>).reasoning).toEqual(state());
    const checked = await checkAcceptanceCompletion('reasoning-run', goal);
    expect(checked.ok).toBe(false);
    expect(checked.criteria.map(c => c.status)).toEqual(['proven', 'pending']);
    expect(checked.criteria[0].evidence).toEqual(['e1']);
  });

  it('passes both acceptance and the manifest only after every output is evidenced and verified', async () => {
    const reasoning = state();
    reasoning.evidence.push({ ...reasoning.evidence[0], id: 'e2', observationId: 'o2', requirementId: 'configuration', claim: 'mock configuration' });
    reasoning.verification = { complete: true, explanation: 'Both observed outputs reported', coveredRequirementIds: ['identifier', 'configuration'],
      unsupportedClaims: [], uncoveredOutputs: [], implementationClaims: [], citations: [
        { requirementId: 'identifier', evidenceIds: ['e1'], answerExcerpt: 'mock identifier' },
        { requirementId: 'configuration', evidenceIds: ['e2'], answerExcerpt: 'mock configuration' },
      ] };
    const checked = await checkAcceptanceCompletion('reasoning-run', goal, reasoning);
    expect(checked.ok).toBe(true);
    expect(checked.criteria.map(c => c.evidence)).toEqual([['e1'], ['e2']]);
    const manifest = await buildCompletionManifest({ threadId: 'reasoning-run', objective: goal });
    expect(manifest.requirements.find(r => r.id === 'acceptance')?.status).toBe('passed');
    expect(manifest.completionEligible).toBe(true);
    expect((await checkAcceptanceCompletion('reasoning-run', 'A different original goal')).ok).toBe(false);
  });

  it('rejects a persisted complete flag whose citations do not bind to accepted evidence', async () => {
    const reasoning = state();
    reasoning.evidence.push({ ...reasoning.evidence[0], id: 'e2', observationId: 'o2', requirementId: 'configuration' });
    reasoning.verification = { complete: true, explanation: 'Forged record', coveredRequirementIds: ['identifier', 'configuration'],
      unsupportedClaims: [], uncoveredOutputs: [], implementationClaims: [], citations: [
        { requirementId: 'identifier', evidenceIds: ['missing'], answerExcerpt: 'claimed identifier' },
        { requirementId: 'configuration', evidenceIds: ['e2'], answerExcerpt: 'configuration' },
      ] };
    expect((await checkAcceptanceCompletion('reasoning-run', goal, reasoning)).ok).toBe(false);
  });
});
