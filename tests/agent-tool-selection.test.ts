import { describe, expect, it } from 'vitest';
import { selectAgentTools } from '../apps/server/src/agent-tool-selection';
import { isImageGenerationRequest } from '../apps/server/src/routes/agent';

const tools = [
  { name: 'filesystem.read' },
  { name: 'filesystem.edit' },
  { name: 'git.run' },
  { name: 'shell.run' },
  { name: 'cad.execute' },
];

describe('agent tool selection', () => {
  it('recognizes direct image requests without depending on a model tool call', () => {
    expect(isImageGenerationRequest('Draw a cinematic portrait of an astronaut')).toBe(true);
    expect(isImageGenerationRequest('Improve this repository documentation')).toBe(false);
    expect(isImageGenerationRequest('Use the selected tool', ['image.generate'])).toBe(true);
  });

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

  it('retains the shell snapshot dependency for an explicitly selected CAD mutation', () => {
    expect(selectAgentTools(tools, ['cad.execute']).map((tool) => tool.name)).toEqual([
      'shell.run',
      'cad.execute',
    ]);
  });
});
