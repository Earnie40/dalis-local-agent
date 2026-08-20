import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/**
 * Resolves a requested path against a workspace root and guarantees the result
 * stays inside it. Symlinks are resolved before comparison so a link pointing
 * outside the workspace cannot be used to escape.
 *
 * Returns the real, absolute path that is safe to operate on.
 */
export function resolveWithinWorkspace(workspaceRoot: string, requestedPath: string): string {
  if (/^\\\\/.test(requestedPath) || /^\/\//.test(requestedPath)) {
    throw new PathContainmentError('UNC and network paths are not permitted.');
  }

  const realRoot = safeRealpath(resolve(workspaceRoot));
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(realRoot, requestedPath);

  // Resolve symlinks on the deepest existing ancestor so that new files (which
  // do not exist yet) are still checked against a real, non-symlinked parent.
  const realCandidate = safeRealpath(candidate);

  if (!isInside(realRoot, realCandidate)) {
    throw new PathContainmentError(
      `Path escapes the workspace root. Requested "${requestedPath}" resolves outside the registered workspace.`,
    );
  }

  return realCandidate;
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
  if (candidate === normalizedRoot) return true;
  return candidate.startsWith(normalizedRoot + sep);
}

/**
 * realpath that tolerates not-yet-existing leaves by walking up to the nearest
 * existing ancestor and re-appending the remainder.
 */
function safeRealpath(target: string): string {
  let current = target;
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length ? resolve(real, ...trailing.reverse()) : real;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return target;
      trailing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}
