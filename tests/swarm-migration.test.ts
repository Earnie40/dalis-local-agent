import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI swarm persistence migration', () => {
  it('keeps swarm coordination attached to ordinary durable tasks', () => {
    const sql = readFileSync('packages/shared/src/db/migrations/029_agent_swarms.sql', 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_swarms');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_swarm_members');
    expect(sql).toContain('REFERENCES tasks (id)');
    expect(sql).toContain('coordinator_task_id');
    expect(sql).toContain('sealed_at');
    expect(sql).toContain('engagement_id');
    expect(sql).not.toMatch(/GRANT\s+/i);
  });

  it('has an idempotent forward migration for live development databases', () => {
    const sql = readFileSync('packages/shared/src/db/migrations/030_agent_swarm_security_context.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS engagement_id');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sealed_at');
    expect(sql).toContain('DROP INDEX IF EXISTS agent_swarms_synthesis_idx');
  });
});
