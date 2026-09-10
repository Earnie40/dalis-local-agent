import type { NormalizedToolCall, ToolSchema } from './types';

export const PROVENANCE = [
  'production_data', 'local_machine', 'repository_code', 'documentation',
  'fixture', 'example', 'public_source', 'inference', 'speculation', 'unknown',
] as const;
export type EvidenceProvenance = typeof PROVENANCE[number];

/** Supplied by the runtime/adapter, never by tool arguments or model assertions. */
export interface EvidenceSource {
  id: string;
  locator: string;
  provenance: EvidenceProvenance;
  content: string;
  effect: 'read' | 'mutation' | 'validation';
}

/** Origin classification is about the source, not the topic or value it contains. */
export function pathProvenance(path: string): EvidenceProvenance | undefined {
  const normalized = path.replaceAll('\\', '/');
  if (/(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(normalized)) return 'fixture';
  if (/(?:^|\/)(?:corpus|examples?|samples?|demo)(?:\/|$)|\.example(?:\.|$)/i.test(normalized)) return 'example';
  if (/(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|rst)$/i.test(normalized)) return 'documentation';
  return undefined;
}

export function toolResultSucceeded(result: { success: boolean; output: string; evidence?: Array<{ kind: string; detail?: Record<string, unknown> }> }): boolean {
  if (!result.success) return false;
  const exit = result.evidence?.find(e => e.kind === 'exit_code')?.detail?.exitCode;
  if (typeof exit === 'number' && exit !== 0) return false;
  try {
    const data = JSON.parse(result.output);
    if (data && typeof data === 'object' && (data.success === false || data.cancelled === true || data.timedOut === true || (typeof data.exitCode === 'number' && data.exitCode !== 0))) return false;
  } catch { /* Plain text has no structured execution status. */ }
  return true;
}

/**
 * Conservative fallback for existing adapters. Retrieval is repository/public
 * material, never user state. New adapters can attach finer source spans.
 * Shell stdout is unclassified: execution on the machine does not prove that
 * embedded values came from machine state (a command may read a fixture).
 */
export function sourcesForResult(call: NormalizedToolCall, result: { output: string; sources?: EvidenceSource[] }): EvidenceSource[] {
  if (result.sources?.length) return result.sources.map((source, index) => ({
    ...source, id: `s${index + 1}`,
    provenance: pathProvenance(source.locator) ?? source.provenance,
  }));
  const path = typeof call.arguments.path === 'string' ? call.arguments.path : call.name;
  let provenance: EvidenceProvenance = pathProvenance(path) ?? 'unknown';
  if (provenance === 'unknown') {
    if (call.name.startsWith('filesystem.') || call.name.startsWith('code.')) provenance = 'repository_code';
    if (call.name.startsWith('web.')) provenance = 'public_source';
    if (call.name.startsWith('system.')) provenance = 'local_machine';
  }
  // Search results carry per-hit origins; never label the entire mixed result
  // as production/local evidence merely because its containing file is local.
  try {
    const data = JSON.parse(result.output);
    if (Array.isArray(data?.matches)) return data.matches.map((match: Record<string, unknown>, index: number) => ({
      id: `s${index + 1}`, locator: String(match.path ?? match.file ?? path),
      provenance: pathProvenance(String(match.path ?? match.file ?? path)) ?? provenance,
      content: JSON.stringify(match), effect: 'read' as const,
    }));
  } catch { /* Text observations retain their enclosing source origin. */ }
  return [{ id: 's1', locator: path, provenance, content: result.output, effect: 'read' }];
}

export interface ExecutionEnvironment {
  platform: string;
  shell: string;
  arch: string;
}

export function executionEnvironment(): ExecutionEnvironment {
  return { platform: process.platform, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', arch: process.arch };
}

/** A registered target runtime outranks the host; the model cannot relabel it. */
export function environmentForTool(tool: ToolSchema, host: ExecutionEnvironment): ExecutionEnvironment {
  return tool.executionEnvironment ?? host;
}
