import { describe, expect, it } from 'vitest';
import { selectAgentTools } from '../apps/server/src/agent-tool-selection';

const tools = [
  { name: 'filesystem.read' },
  { name: 'filesystem.edit' },
  { name: 'git.run' },
  { name: 'shell.run' },
];

describe('agent tool selection', () => {
  it('keeps authorized shell.run available to transactional filesystem mutations', () => {
    expect(selectAgentTools(tools, ['filesystem.read', 'filesystem.edit', 'git.run']).map((tool) => tool.name)).toEqual([
      'filesystem.read',
      'filesystem.edit',
      'git.run',
      'shell.run',
    ]);
  });

  it('does not add shell.run for read-only requested tools', () => {
    expect(selectAgentTools(tools, ['filesystem.read', 'git.run']).map((tool) => tool.name)).toEqual([
      'filesystem.read',
      'git.run',
    ]);
  });
});
