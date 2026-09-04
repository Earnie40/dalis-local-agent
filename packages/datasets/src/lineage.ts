import type { DomainId } from '@dacai-local-agent/domain-knowledge';
import { hashArtifact } from '@dacai-local-agent/domain-knowledge';

/**
 * Dataset lineage.
 *
 * There is deliberately no "everything" dataset. A dataset belongs to exactly
 * one domain, carries an immutable version, and records what it was derived
 * from. Lineage is what lets a promoted adapter be traced back to the exact
 * inputs that produced it — and what lets a poisoned or mislicensed source be
 * followed forward to every artifact that inherited it.
 */

export type DatasetPurpose =
  /** Retrieval corpus. Served through RAG, never frozen into weights. */
  | 'retrieval'
  /** Supervised fine-tuning examples of stable procedures. */
  | 'training'
  /** Held-out evaluation and scoring suites. */
  | 'evaluation'
  /** Verified agent experience awaiting review. */
  | 'experience';

export type LineageRelation =
  | 'derived_from'
  | 'filtered_from'
  | 'merged_from'
  | 'annotated_from'
  | 'simulated_from';

export interface DatasetSource {
  kind: string;
  locator: string;
  sha256?: string;
  /** Terms under which this source may be used. Absent means unknown, not permitted. */
  license?: string;
  /**
   * Set when the source required explicit permission (an authorized account
   * export, a consented voice recording). Unauthorized private data must never
   * reach a dataset in the first place.
   */
  authorizationRef?: string;
}

export interface DatasetVersion {
  datasetId: string;
  /** Monotonic, immutable once written. */
  version: number;
  domainId: DomainId;
  purpose: DatasetPurpose;
  title: string;
  recordCount: number;
  sources: readonly DatasetSource[];
  /** sha256 over the canonical content manifest. */
  contentHash: string;
  createdAt: string;
  notes?: string;
}

export interface LineageEdge {
  fromDatasetId: string;
  fromVersion: number;
  toDatasetId: string;
  toVersion: number;
  relation: LineageRelation;
}

export class LineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineageError';
  }
}

export interface DatasetVersionInput extends Omit<DatasetVersion, 'contentHash' | 'createdAt'> {
  createdAt?: string;
}

export function createDatasetVersion(input: DatasetVersionInput): DatasetVersion {
  if (input.version < 1 || !Number.isInteger(input.version)) {
    throw new LineageError(`Dataset version must be a positive integer, received ${input.version}.`);
  }
  if (input.sources.length === 0) {
    throw new LineageError(
      `Dataset "${input.datasetId}" must declare at least one source. An unsourced dataset cannot be audited.`,
    );
  }
  const contentHash = hashArtifact({
    datasetId: input.datasetId,
    version: input.version,
    domainId: input.domainId,
    purpose: input.purpose,
    recordCount: input.recordCount,
    sources: input.sources,
  });
  return {
    ...input,
    sources: [...input.sources],
    contentHash,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Lineage graph over dataset versions.
 *
 * Cross-domain datasets are built by merging, so the graph must stay acyclic —
 * a cycle would make provenance unresolvable and let a dataset transitively
 * derive from itself.
 */
export class LineageGraph {
  private readonly versions = new Map<string, DatasetVersion>();
  private readonly edges: LineageEdge[] = [];

  private static key(datasetId: string, version: number): string {
    return `${datasetId}@${version}`;
  }

  register(version: DatasetVersion): void {
    const key = LineageGraph.key(version.datasetId, version.version);
    const existing = this.versions.get(key);
    if (existing && existing.contentHash !== version.contentHash) {
      throw new LineageError(
        `Dataset version ${key} already exists with a different content hash. Versions are immutable; publish a new version instead.`,
      );
    }
    this.versions.set(key, version);
  }

  get(datasetId: string, version: number): DatasetVersion | undefined {
    return this.versions.get(LineageGraph.key(datasetId, version));
  }

  link(edge: LineageEdge): void {
    const from = LineageGraph.key(edge.fromDatasetId, edge.fromVersion);
    const to = LineageGraph.key(edge.toDatasetId, edge.toVersion);
    if (!this.versions.has(from)) throw new LineageError(`Unknown source dataset version ${from}.`);
    if (!this.versions.has(to)) throw new LineageError(`Unknown target dataset version ${to}.`);
    if (from === to) throw new LineageError(`A dataset version cannot derive from itself (${from}).`);

    this.edges.push(edge);
    if (this.hasCycle()) {
      this.edges.pop();
      throw new LineageError(
        `Refusing edge ${from} --${edge.relation}--> ${to}: it would create a lineage cycle.`,
      );
    }
  }

  /** Every version this one transitively derives from. */
  ancestorsOf(datasetId: string, version: number): DatasetVersion[] {
    const start = LineageGraph.key(datasetId, version);
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const edge of this.edges) {
        if (LineageGraph.key(edge.toDatasetId, edge.toVersion) !== current) continue;
        const parent = LineageGraph.key(edge.fromDatasetId, edge.fromVersion);
        if (seen.has(parent)) continue;
        seen.add(parent);
        queue.push(parent);
      }
    }
    return [...seen].map((key) => this.versions.get(key) as DatasetVersion);
  }

  /** Every version that transitively derives from this one. */
  descendantsOf(datasetId: string, version: number): DatasetVersion[] {
    const start = LineageGraph.key(datasetId, version);
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const edge of this.edges) {
        if (LineageGraph.key(edge.fromDatasetId, edge.fromVersion) !== current) continue;
        const child = LineageGraph.key(edge.toDatasetId, edge.toVersion);
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    return [...seen].map((key) => this.versions.get(key) as DatasetVersion);
  }

  /**
   * Every distinct source feeding a version, including inherited ones. This is
   * the query a licensing or authorization review actually needs.
   */
  resolvedSources(datasetId: string, version: number): DatasetSource[] {
    const self = this.get(datasetId, version);
    if (!self) throw new LineageError(`Unknown dataset version ${datasetId}@${version}.`);
    const all = [...self.sources, ...this.ancestorsOf(datasetId, version).flatMap((v) => v.sources)];
    const seen = new Map<string, DatasetSource>();
    for (const source of all) seen.set(`${source.kind}:${source.locator}`, source);
    return [...seen.values()];
  }

  private hasCycle(): boolean {
    const adjacency = new Map<string, string[]>();
    for (const edge of this.edges) {
      const from = LineageGraph.key(edge.fromDatasetId, edge.fromVersion);
      const to = LineageGraph.key(edge.toDatasetId, edge.toVersion);
      adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (node: string): boolean => {
      if (visiting.has(node)) return true;
      if (done.has(node)) return false;
      visiting.add(node);
      for (const next of adjacency.get(node) ?? []) if (walk(next)) return true;
      visiting.delete(node);
      done.add(node);
      return false;
    };
    return [...adjacency.keys()].some(walk);
  }
}
