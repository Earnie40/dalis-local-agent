import { describe, expect, it } from 'vitest';
import {
  findIndexedPaths,
  renderPathDiagram,
  type IndexedPathEdge,
} from '../packages/repository-index/src/path-tracing';

const edge = (
  source: string,
  target: string,
  line: number,
  relationship: IndexedPathEdge['relationship'] = 'CALLS',
  filePath = 'src/path.ts',
): IndexedPathEdge => ({ source, target, line, relationship, filePath, repositoryId: 'repo-1' });

describe('indexed code path tracing', () => {
  it('returns deterministic shortest-first paths with file and line evidence', () => {
    const result = findIndexedPaths([
      edge('A', 'C', 30),
      edge('C', 'D', 31),
      edge('A', 'B', 10),
      edge('B', 'D', 11),
      edge('B', 'C', 12),
    ], 'A', 'D', { maxPaths: 3 });

    expect(result.found).toBe(true);
    expect(result.paths.map((path) => path.nodes)).toEqual([
      ['A', 'B', 'D'],
      ['A', 'C', 'D'],
      ['A', 'B', 'C', 'D'],
    ]);
    expect(result.paths[0].edges[1]).toMatchObject({ filePath: 'src/path.ts', line: 11 });
  });

  it('does not loop through cycles', () => {
    const result = findIndexedPaths([
      edge('A', 'B', 1),
      edge('B', 'A', 2),
      edge('B', 'C', 3),
    ], 'A', 'C');
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].nodes).toEqual(['A', 'B', 'C']);
  });

  it('filters relationships and reports not found without inventing a path', () => {
    const edges = [edge('A', 'B', 1, 'IMPORTS'), edge('B', 'C', 2, 'CALLS')];
    expect(findIndexedPaths(edges, 'A', 'C').found).toBe(false);
    expect(findIndexedPaths(edges, 'A', 'C', { relationships: ['IMPORTS', 'CALLS'] }).found).toBe(true);
  });

  it('handles identity paths and configured bounds', () => {
    expect(findIndexedPaths([], 'A', 'A').paths[0].nodes).toEqual(['A']);

    const depthBound = findIndexedPaths([edge('A', 'B', 1), edge('B', 'C', 2)], 'A', 'C', { maxDepth: 1 });
    expect(depthBound.found).toBe(false);
    expect(depthBound.truncated).toBe(true);
    expect(depthBound.edgeLimitReached).toBe(false);

    const visitBound = findIndexedPaths([
      edge('A', 'B', 1), edge('A', 'C', 2), edge('B', 'D', 3), edge('C', 'D', 4),
    ], 'A', 'D', { maxVisited: 1 });
    expect(visitBound.truncated).toBe(true);
    expect(visitBound.limitations.at(-1)).toMatch(/configured path or visit bound/i);
  });

  it('renders Mermaid and DOT source without requiring Graphviz', () => {
    const result = findIndexedPaths([edge('route', 'runAgentLoop', 42, 'CALLS', 'src/route.ts')], 'route', 'runAgentLoop');
    expect(renderPathDiagram(result, 'mermaid')).toContain('flowchart LR');
    expect(renderPathDiagram(result, 'mermaid')).toContain('src/route.ts:42');
    expect(renderPathDiagram(result, 'dot')).toContain('digraph code_path');
    expect(renderPathDiagram(result, 'dot')).toContain('route');
  });
});
