import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_RUN_BUDGETS, type AppConfig } from '../packages/shared/src/config';
import { phaseForAuditTool, resolveAgentRunMode } from '../apps/server/src/agent-run-mode';

const config = {
  limits: { maxAgentTurns: 120, runBudgets: DEFAULT_AGENT_RUN_BUDGETS },
} as AppConfig;

describe('agent run modes', () => {
  it('uses a small interactive budget by default', () => {
    expect(resolveAgentRunMode({ prompt: 'What is this file?', config }).budget.maxTurns).toBe(16);
  });

  it('uses coding and audit budgets appropriate to the requested work', () => {
    expect(resolveAgentRunMode({ prompt: 'Fix the failing test', role: 'coding', config }).budget.maxTurns).toBe(40);
    const audit = resolveAgentRunMode({ prompt: 'Perform a repository-wide architecture gap analysis', config });
    expect(audit.mode).toBe('repository_audit');
    expect(audit.budget).toMatchObject({ maxTurns: 80, synthesisReserveTurns: 20 });
  });

  it('supports deep-research mode and explicit safe overrides', () => {
    const deep = resolveAgentRunMode({ requestedMode: 'deep_research', prompt: 'research', config });
    expect(deep.budget.maxTurns).toBe(100);
    const override = resolveAgentRunMode({ requestedMode: 'repository_audit', prompt: 'audit', maxTurns: 72, config });
    expect(override.budget.maxTurns).toBe(72);
  });

  it('maps repository intelligence to visible audit phases', () => {
    expect(phaseForAuditTool('code.architecture.context')).toBe('Repository inventory');
    expect(phaseForAuditTool('code.symbol.search')).toBe('Locate implementations');
    expect(phaseForAuditTool('filesystem.read')).toBe('Gather evidence');
    expect(phaseForAuditTool('tests.run')).toBe('Verification');
  });
});
