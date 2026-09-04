import type { AgentEvent } from './api';

export interface AgentArtifact {
  path: string;
  kind: 'image' | 'sandbox' | 'video';
}

const IMAGE_EXTENSIONS = /\.(?:gif|jpe?g|png|svg|webp)$/i;
const SANDBOX_EXTENSIONS = /\.html?$/i;
const VIDEO_EXTENSIONS = /\.mp4$/i;
const ARTIFACT_TOOLS = new Set([
  'filesystem.write',
  'filesystem.edit',
  'engineering.artifact.inspect',
  'scene.render',
  'cad.execute',
  'bim.execute',
  'image.generate',
  'video.generate',
]);

function artifactFromPath(path: unknown): AgentArtifact | undefined {
  if (typeof path !== 'string' || !path.trim() || /^[a-z]:[\\/]|^[\\/]/i.test(path)) return undefined;
  const normalized = path.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) return undefined;
  if (IMAGE_EXTENSIONS.test(normalized)) return { path: normalized, kind: 'image' };
  if (VIDEO_EXTENSIONS.test(normalized)) return { path: normalized, kind: 'video' };
  if (SANDBOX_EXTENSIONS.test(normalized)) return { path: normalized, kind: 'sandbox' };
  return undefined;
}

/** Finds previewable paths in successful mutation/render tool results. */
export function extractAgentArtifacts(event: AgentEvent): AgentArtifact[] {
  if (event.type !== 'tool_result' || event.success !== true || !event.tool || !ARTIFACT_TOOLS.has(event.tool)) return [];

  let result: unknown = {};
  try {
    if (event.output?.trim()) result = JSON.parse(event.output);
  } catch {
    // The SSE transcript is intentionally bounded and may truncate a large
    // write result. Tool arguments still carry its authoritative target path.
    result = {};
  }

  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const candidates: unknown[] = [
    event.arguments?.path,
    event.arguments?.outputPath,
    record.path,
    record.outputPath,
    record.artifactPath,
  ];
  if (Array.isArray(record.artifacts)) {
    for (const artifact of record.artifacts) {
      candidates.push(typeof artifact === 'string' ? artifact : (artifact as Record<string, unknown> | null)?.path);
    }
  }

  const unique = new Map<string, AgentArtifact>();
  for (const candidate of candidates) {
    const artifact = artifactFromPath(candidate);
    if (artifact) unique.set(artifact.path.toLowerCase(), artifact);
  }
  return [...unique.values()];
}

export function agentArtifactUrl(workspaceId: string, path: string): string {
  const query = new URLSearchParams({ path });
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/artifact?${query}`;
}
