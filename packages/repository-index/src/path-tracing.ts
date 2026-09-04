import { getPool } from '../../shared/src/db/pool';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RelationshipType } from './types.js';

export interface IndexedPathEdge {
  repositoryId?: string;
  filePath: string;
  source: string;
  target: string;
  relationship: RelationshipType;
  line: number;
}

export interface IndexedCodePath {
  nodes: string[];
  edges: IndexedPathEdge[];
}

export interface PathTraceOptions {
  relationships?: readonly RelationshipType[];
  maxDepth?: number;
  maxPaths?: number;
  maxVisited?: number;
}

export interface PathTraceResult {
  from: string;
  to: string;
  found: boolean;
  paths: IndexedCodePath[];
  visited: number;
  truncated: boolean;
  edgeCount: number;
  edgeLimitReached: boolean;
  relationships: RelationshipType[];
  limitations: string[];
}

const DEFAULT_RELATIONSHIPS: readonly RelationshipType[] = ['CALLS'];

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function edgeKey(edge: IndexedPathEdge): string {
  return [edge.repositoryId ?? '', edge.filePath, edge.line, edge.source, edge.relationship, edge.target].join('\u0000');
}

/**
 * Deterministic bounded breadth-first traversal over already-indexed edges.
 * The function is pure so path behavior can be tested without PostgreSQL.
 */
export function findIndexedPaths(
  edges: readonly IndexedPathEdge[],
  from: string,
  to: string,
  options: PathTraceOptions = {},
): PathTraceResult {
  const maxDepth = boundedInteger(options.maxDepth, 8, 1, 24);
  const maxPaths = boundedInteger(options.maxPaths, 5, 1, 25);
  const maxVisited = boundedInteger(options.maxVisited, 5_000, 1, 50_000);
  const relationships = [...new Set(options.relationships?.length ? options.relationships : DEFAULT_RELATIONSHIPS)];
  const allowed = new Set<RelationshipType>(relationships);

  if (from === to) {
    return {
      from,
      to,
      found: true,
      paths: [{ nodes: [from], edges: [] }],
      visited: 1,
      truncated: false,
      edgeCount: edges.length,
      edgeLimitReached: false,
      relationships,
      limitations: traceLimitations(false),
    };
  }

  const adjacency = new Map<string, IndexedPathEdge[]>();
  const unique = new Set<string>();
  for (const edge of edges) {
    if (!allowed.has(edge.relationship)) continue;
    const key = edgeKey(edge);
    if (unique.has(key)) continue;
    unique.add(key);
    const outgoing = adjacency.get(edge.source) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.source, outgoing);
  }
  for (const outgoing of adjacency.values()) {
    outgoing.sort((left, right) =>
      left.target.localeCompare(right.target) ||
      left.relationship.localeCompare(right.relationship) ||
      left.filePath.localeCompare(right.filePath) ||
      left.line - right.line,
    );
  }

  const queue: IndexedCodePath[] = [{ nodes: [from], edges: [] }];
  const matches: IndexedCodePath[] = [];
  let visited = 0;
  let truncated = false;

  while (queue.length) {
    if (visited >= maxVisited) {
      truncated = true;
      break;
    }
    const current = queue.shift() as IndexedCodePath;
    visited += 1;
    const node = current.nodes[current.nodes.length - 1];
    if (current.edges.length >= maxDepth) {
      if ((adjacency.get(node)?.length ?? 0) > 0) truncated = true;
      continue;
    }

    for (const edge of adjacency.get(node) ?? []) {
      if (current.nodes.includes(edge.target)) continue;
      const next: IndexedCodePath = {
        nodes: [...current.nodes, edge.target],
        edges: [...current.edges, edge],
      };
      if (edge.target === to) {
        matches.push(next);
        if (matches.length > maxPaths) {
          truncated = true;
          break;
        }
      } else {
        queue.push(next);
      }
    }
    if (matches.length > maxPaths) break;
  }

  const paths = matches.slice(0, maxPaths);
  return {
    from,
    to,
    found: paths.length > 0,
    paths,
    visited,
    truncated,
    edgeCount: unique.size,
    edgeLimitReached: false,
    relationships,
    limitations: traceLimitations(truncated),
  };
}

function traceLimitations(truncated: boolean): string[] {
  return [
    'This is a static trace over the latest persisted index, not a runtime execution trace.',
    'Dynamic dispatch, reflection, generated code, callbacks, and unsupported parser constructs may be absent.',
    'Indexed edges currently identify symbols by name; duplicate names can make a path ambiguous.',
    ...(truncated ? ['The search hit a configured path or visit bound; additional paths may exist.'] : []),
  ];
}

export async function traceRepositoryPaths(
  workspaceRoot: string,
  from: string,
  to: string,
  options: PathTraceOptions = {},
): Promise<PathTraceResult> {
  const relationships = [...new Set(options.relationships?.length ? options.relationships : DEFAULT_RELATIONSHIPS)];
  const canonicalRoot = realpathSync(resolve(workspaceRoot));
  const pool = getPool();
  const repository = await pool.query<{ id: string }>(
    'SELECT id FROM repositories WHERE root_path = $1 ORDER BY indexed_at DESC LIMIT 1',
    [canonicalRoot],
  );
  if (!repository.rows[0]) {
    const empty = findIndexedPaths([], from, to, { ...options, relationships });
    return {
      ...empty,
      limitations: [...empty.limitations, `No persisted repository index matches the canonical workspace root "${canonicalRoot}".`],
    };
  }

  const edgeLimit = 50_000;
  const result = await pool.query<{
    repository_id: string;
    file_path: string;
    source: string;
    target: string;
    relationship: RelationshipType;
    line: number | null;
  }>(`
    SELECT
      e.repository_id,
      e.file_path,
      e.source,
      e.target,
      e.relationship,
      e.line
    FROM symbol_edges e
    WHERE e.repository_id = $1
      AND e.relationship = ANY($2::text[])
    ORDER BY e.source, e.target, e.relationship, e.file_path, e.line
    LIMIT $3
  `, [repository.rows[0].id, relationships, edgeLimit + 1]);

  const edgeLimitReached = result.rows.length > edgeLimit;
  const edges: IndexedPathEdge[] = result.rows.slice(0, edgeLimit).map((row) => ({
    repositoryId: row.repository_id,
    filePath: row.file_path,
    source: row.source,
    target: row.target,
    relationship: row.relationship,
    line: row.line ?? 0,
  }));
  const trace = findIndexedPaths(edges, from, to, { ...options, relationships });
  if (!edgeLimitReached) return trace;
  return {
    ...trace,
    truncated: true,
    edgeLimitReached: true,
    limitations: [
      ...trace.limitations,
      `The persisted edge query exceeded ${edgeLimit} rows; paths beyond that deterministic bound were not searched.`,
    ],
  };
}

export type PathDiagramFormat = 'mermaid' | 'dot';

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

export function renderPathDiagram(result: PathTraceResult, format: PathDiagramFormat): string {
  const nodes = new Map<string, string>();
  const addNode = (name: string) => {
    if (!nodes.has(name)) nodes.set(name, `n${nodes.size}`);
  };
  addNode(result.from);
  addNode(result.to);
  for (const path of result.paths) for (const node of path.nodes) addNode(node);

  const uniqueEdges = new Map<string, IndexedPathEdge>();
  for (const path of result.paths) {
    for (const edge of path.edges) uniqueEdges.set(edgeKey(edge), edge);
  }

  if (format === 'dot') {
    const lines = ['digraph code_path {', '  rankdir=LR;'];
    for (const [name, id] of nodes) lines.push(`  ${id} [label="${escapeLabel(name)}"];`);
    for (const edge of uniqueEdges.values()) {
      const detail = `${edge.relationship}\\n${edge.filePath}${edge.line ? `:${edge.line}` : ''}`;
      lines.push(`  ${nodes.get(edge.source)} -> ${nodes.get(edge.target)} [label="${escapeLabel(detail)}"];`);
    }
    if (!result.found) lines.push('  // No indexed path found between the requested symbols.');
    lines.push('}');
    return lines.join('\n');
  }

  const lines = ['flowchart LR'];
  for (const [name, id] of nodes) lines.push(`  ${id}["${escapeLabel(name)}"]`);
  for (const edge of uniqueEdges.values()) {
    const detail = `${edge.relationship} · ${edge.filePath}${edge.line ? `:${edge.line}` : ''}`;
    lines.push(`  ${nodes.get(edge.source)} -->|"${escapeLabel(detail)}"| ${nodes.get(edge.target)}`);
  }
  if (!result.found) lines.push('  %% No indexed path found between the requested symbols.');
  return lines.join('\n');
}
