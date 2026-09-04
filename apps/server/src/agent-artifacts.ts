import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const PREVIEW_MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
};

export class AgentArtifactError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 413 | 415 = 400) {
    super(message);
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' || (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/**
 * Loads only browser-previewable files after resolving symlinks and proving the
 * final file remains inside the registered workspace root.
 */
export async function readAgentArtifact(workspaceRoot: string, requestedPath: string): Promise<{
  content: Buffer;
  fileName: string;
  mimeType: string;
}> {
  if (!requestedPath?.trim() || isAbsolute(requestedPath)) {
    throw new AgentArtifactError('A workspace-relative artifact path is required.');
  }

  const root = await realpath(workspaceRoot);
  let target: string;
  try {
    target = await realpath(resolve(root, requestedPath));
  } catch {
    throw new AgentArtifactError('Artifact not found.', 404);
  }
  if (!isWithinRoot(root, target)) {
    throw new AgentArtifactError('Artifact path escapes the registered workspace.');
  }

  const info = await stat(target);
  if (!info.isFile()) throw new AgentArtifactError('Artifact is not a file.', 404);
  if (info.size > MAX_ARTIFACT_BYTES) {
    throw new AgentArtifactError('Artifact is too large for an inline preview.', 413);
  }

  const mimeType = PREVIEW_MIME_TYPES[extname(target).toLowerCase()];
  if (!mimeType) {
    throw new AgentArtifactError('This artifact type cannot be previewed in the agent chat.', 415);
  }

  return { content: await readFile(target), fileName: basename(target), mimeType };
}
