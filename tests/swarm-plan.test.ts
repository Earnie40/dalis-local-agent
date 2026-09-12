import { describe, expect, it } from 'vitest';
import { createSwarmSynthesisObjective, planSwarmMembers, SwarmPlanError } from '../apps/server/src/swarm-plan';
import type { SwarmRecord } from '../packages/orchestrator/src/swarm-store';

describe('AI swarm planning', () => {
  it('builds bounded, distinct specialist assignments around the exact parent objective', () => {
    const objective = 'Audit the payment retry flow';
    const members = planSwarmMembers(objective, 'balanced', 4);
    expect(members).toHaveLength(4);
    expect(new Set(members.map((member) => member.role)).size).toBe(4);
    for (const member of members) {
      expect(member.objective).toContain(`Parent objective: ${objective}`);
      expect(member.objective).toContain('Return concise findings, evidence, uncertainty, and any blocker');
    }
  });

  it('rejects an empty objective and worker counts outside 2-6', () => {
    expect(() => planSwarmMembers('', 'balanced', 3)).toThrow(SwarmPlanError);
    expect(() => planSwarmMembers('x', 'balanced', 1)).toThrow(/2 through 6/);
    expect(() => planSwarmMembers('x', 'balanced', 7)).toThrow(/2 through 6/);
  });

  it('builds six persona-free offensive and defensive capability lanes', () => {
    const offense = planSwarmMembers('Assess authorized access', 'offensive-security', 6);
    const defense = planSwarmMembers('Defend protected access', 'defensive-security', 6);
    expect(offense).toHaveLength(6);
    expect(defense).toHaveLength(6);
    expect(offense.map((member) => member.objective).join('\n')).toContain('authorized level of access');
    expect(defense.map((member) => member.objective).join('\n')).toContain('defensive controls');
    expect([...offense, ...defense].map((member) => member.objective).join('\n')).not.toMatch(/biography|persona name/i);
  });

  it('creates an evidence-preserving coordinator prompt without inventing missing results', () => {
    const swarm = {
      id: 'swarm_1',
      workspaceId: 'ws_1',
      objective: 'Reach a supported conclusion',
      strategy: 'review',
      status: 'ready',
      progress: { total: 2, terminal: 2, completed: 1, failed: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
      members: [
        {
          taskId: 'task_1', role: 'reviewer', objective: 'Review it', ordinal: 0,
          status: 'completed', result: 'Observed evidence A', evidence: [], errors: [],
          model: 'm', providerInstanceId: 'p', createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          taskId: 'task_2', role: 'debugger', objective: 'Challenge it', ordinal: 1,
          status: 'failed', evidence: [], errors: [{ message: 'provider failed' }],
          model: 'm', providerInstanceId: 'p', createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    } satisfies SwarmRecord;
    const prompt = createSwarmSynthesisObjective(swarm);
    expect(prompt).toContain('Observed evidence A');
    expect(prompt).toContain('(no result)');
    expect(prompt).toContain('provider failed');
    expect(prompt).toContain('Do not claim work or validation that no worker actually completed.');
  });
});
