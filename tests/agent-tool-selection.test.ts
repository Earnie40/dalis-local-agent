import { describe, expect, it } from 'vitest';
import { selectAgentTools } from '../apps/server/src/agent-tool-selection';
import {
  classifyDirectMediaRequest,
  isImageEditRequest,
  isImageGenerationRequest,
  verifiedGeneratedArtifact,
} from '../apps/server/src/routes/agent';

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

  it('routes animation and video prompts to video before overlapping image intent', () => {
    expect(classifyDirectMediaRequest('Animate this uploaded image into a cinematic clip')).toBe('video');
    expect(classifyDirectMediaRequest('Generate a short video of ocean waves')).toBe('video');
    expect(classifyDirectMediaRequest('Generate an image of ocean waves')).toBe('image');
  });

  it('recognizes uploaded-image edits that must carry a sourcePath', () => {
    expect(isImageEditRequest('Edit this image to make the sky dramatic')).toBe(true);
    expect(isImageEditRequest('Retouch the uploaded portrait')).toBe(true);
    expect(isImageEditRequest('Make her hair blonde', { hasImageAttachment: true })).toBe(true);
    expect(isImageEditRequest('Generate an image of a dramatic sky')).toBe(false);
  });

  it('accepts completion only for matching tool-layer path and hash evidence', () => {
    const hash = 'a'.repeat(64);
    const result = {
      success: true,
      output: '{}',
      evidence: [{ kind: 'artifact_hash', summary: 'verified', detail: { path: 'generated/new.png', sha256: hash, format: 'png', bytes: 8 } }],
    };
    expect(verifiedGeneratedArtifact(result, 'generated/new.png', 'png')).toEqual({
      path: 'generated/new.png', sha256: hash, bytes: 8,
    });
    expect(verifiedGeneratedArtifact(result, 'output/preexisting.png', 'png')).toBeUndefined();
    expect(verifiedGeneratedArtifact({ success: true, output: '{}' }, 'generated/new.png', 'png')).toBeUndefined();
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
