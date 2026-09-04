import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentArtifactError, readAgentArtifact } from '../apps/server/src/agent-artifacts';
import { agentArtifactUrl, extractAgentArtifacts } from '../apps/web/src/agent-artifacts';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('agent artifact previews', () => {
  it('serves a previewable artifact contained by the workspace', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dacai-artifact-'));
    cleanup.push(base);
    const workspace = join(base, 'workspace');
    await mkdir(join(workspace, 'output'), { recursive: true });
    await writeFile(join(workspace, 'output', 'person.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const artifact = await readAgentArtifact(workspace, 'output/person.svg');

    expect(artifact.mimeType).toBe('image/svg+xml; charset=utf-8');
    expect(artifact.content.toString()).toContain('<svg');

    await writeFile(join(workspace, 'output', 'clip.mp4'), Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]));
    const video = await readAgentArtifact(workspace, 'output/clip.mp4');
    expect(video.mimeType).toBe('video/mp4');
  });

  it('rejects a real path outside the registered workspace', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dacai-artifact-'));
    cleanup.push(base);
    const workspace = join(base, 'workspace');
    await mkdir(workspace);
    await writeFile(join(base, 'outside.svg'), '<svg/>');

    await expect(readAgentArtifact(workspace, '../outside.svg')).rejects.toMatchObject<AgentArtifactError>({
      message: 'Artifact path escapes the registered workspace.',
      statusCode: 400,
    });
  });

  it('extracts image and sandbox paths from successful tool results', () => {
    expect(extractAgentArtifacts({
      type: 'tool_result',
      tool: 'filesystem.write',
      success: true,
      arguments: { path: 'output/person.svg' },
      output: '{truncated',
    })).toEqual([{ path: 'output/person.svg', kind: 'image' }]);

    expect(extractAgentArtifacts({
      type: 'tool_result',
      tool: 'engineering.artifact.inspect',
      success: true,
      output: JSON.stringify({ artifacts: [{ path: 'output/demo.html' }] }),
    })).toEqual([{ path: 'output/demo.html', kind: 'sandbox' }]);
    expect(agentArtifactUrl('workspace 1', 'output/person.svg')).toContain('workspace%201/artifact?path=output%2Fperson.svg');
    expect(extractAgentArtifacts({
      type: 'tool_result', tool: 'image.generate', success: true,
      arguments: { outputPath: 'output/portrait.png' }, output: '{}',
    })).toEqual([{ path: 'output/portrait.png', kind: 'image' }]);
    expect(extractAgentArtifacts({
      type: 'tool_result', tool: 'video.generate', success: true,
      arguments: { outputPath: 'output/portrait.mp4' }, output: '{}',
    })).toEqual([{ path: 'output/portrait.mp4', kind: 'video' }]);
  });

  it('does not preview arbitrary reads or escaped paths', () => {
    expect(extractAgentArtifacts({
      type: 'tool_result', tool: 'filesystem.read', success: true,
      arguments: { path: 'output/person.svg' }, output: '{}',
    })).toEqual([]);
    expect(extractAgentArtifacts({
      type: 'tool_result', tool: 'filesystem.write', success: true,
      arguments: { path: '../person.svg' }, output: '{}',
    })).toEqual([]);
  });
});
