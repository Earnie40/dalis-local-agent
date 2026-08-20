import { describe, expect, it } from 'vitest';
import { getWorkerRole, WORKER_ROLE_IDS, WORKER_ROLES } from '../packages/agents/src/roles';

describe('worker roles', () => {
  it('has a unique id for every registered role, and WORKER_ROLE_IDS matches WORKER_ROLES exactly', () => {
    expect(new Set(WORKER_ROLE_IDS).size).toBe(WORKER_ROLE_IDS.length);
    expect([...WORKER_ROLE_IDS].sort()).toEqual(Object.keys(WORKER_ROLES).sort());
  });

  it('includes the core delegation roles required by the multi-agent orchestration layer', () => {
    // These are the minimum roles every workflow (repo mapping, debugging, editing,
    // review, and test authorship) depends on. Additional specialist roles (e.g.
    // security-reviewer, variant-hunter, ci-fixer) may be added without breaking this.
    for (const id of ['repo-explorer', 'debugger', 'coder', 'reviewer', 'test-engineer']) {
      expect(WORKER_ROLE_IDS).toContain(id);
    }
  });

  it('gives every role complete, well-formed metadata', () => {
    for (const [id, role] of Object.entries(WORKER_ROLES)) {
      expect(role.id).toBe(id);
      expect(typeof role.alias).toBe('string');
      expect(role.alias.length).toBeGreaterThan(0);
      expect(typeof role.canEditFiles).toBe('boolean');
      expect(typeof role.systemPrompt).toBe('string');
      expect(role.systemPrompt.length).toBeGreaterThan(0);
      if (role.tools) {
        expect(role.tools.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks every read-only-tooled role non-editing and every editing role without a curated read-only tool list', () => {
    // canEditFiles is the authoritative read-only/writable signal (roles.ts is
    // explicit that this configuration only narrows, never grants, runtime
    // permissions). A role that can edit files relies on the full permissioned
    // executor rather than a curated inspection-only tool subset.
    for (const role of Object.values(WORKER_ROLES)) {
      if (role.canEditFiles) {
        expect(role.tools).toBeUndefined();
      } else if (role.tools) {
        expect(role.tools).not.toContain('filesystem.write');
        expect(role.tools).not.toContain('filesystem.edit');
      }
    }
  });

  it('requires evidence in every role prompt', () => {
    for (const role of Object.values(WORKER_ROLES)) {
      expect(role.systemPrompt.toLowerCase()).toMatch(/cite|evidence|exit code/);
    }
  });

  it('bounds every role with a turn limit', () => {
    for (const role of Object.values(WORKER_ROLES)) {
      expect(role.maxTurns).toBeGreaterThan(0);
      expect(role.maxTurns).toBeLessThanOrEqual(20);
    }
  });

  it('routes every role to an agent-capable alias', () => {
    // 'fast' and 'research' are advisory-class and would be refused by the loop.
    for (const role of Object.values(WORKER_ROLES)) {
      expect(['coder', 'reasoner', 'reviewer', 'structured_agent']).toContain(role.alias);
    }
  });

  it('returns undefined for an unknown role rather than a default', () => {
    expect(getWorkerRole('nope')).toBeUndefined();
    expect(getWorkerRole('coder')?.id).toBe('coder');
  });
});
