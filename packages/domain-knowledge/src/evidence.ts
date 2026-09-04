import { createHash } from 'node:crypto';

/**
 * Evidence hashing for the DACAIS Evidence Registry.
 *
 * Raw data never leaves the machine. What an on-chain registry would carry is a
 * content hash plus the kind of artifact it commits to, so a dataset, a
 * prediction, or a training run can later be shown to be the one that was
 * actually used. Nothing here talks to a chain — this is the hashing and
 * anchor-record layer only.
 */

export type EvidenceKind =
  | 'sourceHash'
  | 'datasetHash'
  | 'marketSnapshotHash'
  | 'predictionHash'
  | 'simulationHash'
  | 'trainingRunHash'
  | 'modelAdapterHash'
  | 'evaluationHash'
  | 'approvalHash'
  | 'physicalActionEvidenceHash';

export interface EvidenceAnchor {
  kind: EvidenceKind;
  /** sha256 hex of the canonical serialization of the committed artifact. */
  digest: string;
  /** Local pointer to the off-chain payload. Never the payload itself. */
  locator?: string;
  createdAt: string;
  /**
   * Populated only once an anchor has actually been submitted to a registry.
   * Undefined means "computed locally, never anchored" — the current state of
   * every anchor this repository produces.
   */
  anchoredTxHash?: string;
}

/**
 * Deterministic JSON: object keys sorted recursively so two structurally equal
 * artifacts always hash identically regardless of construction order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashArtifact(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export function anchorFor(
  kind: EvidenceKind,
  artifact: unknown,
  locator?: string,
  now: Date = new Date(),
): EvidenceAnchor {
  return {
    kind,
    digest: hashArtifact(artifact),
    locator,
    createdAt: now.toISOString(),
  };
}

/** True when the artifact still hashes to what the anchor committed to. */
export function verifyAnchor(anchor: EvidenceAnchor, artifact: unknown): boolean {
  return hashArtifact(artifact) === anchor.digest;
}
