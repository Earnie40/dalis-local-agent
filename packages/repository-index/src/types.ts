/** Repository-intelligence domain types (persistent symbol/relationship schema). */

export type SymbolType =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property'
  | 'schema'
  | 'other';

export type RelationshipType =
  | 'CALLS'
  | 'IMPORTS'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'DEPENDS_ON'
  | 'TESTED_BY'
  | 'CONFIGURES'
  | 'READS_FROM'
  | 'WRITES_TO'
  | 'SUPERSEDES'
  | 'RELATED_TO'
  | 'FAILS_WITH'
  | 'FIXED_BY';

export interface CodeSymbol {
  filePath: string;
  language: string;
  name: string;
  type: SymbolType;
  /** First declaration line, trimmed (used as a compact signature). */
  signature?: string;
  /** 1-based inclusive start line in the source file. */
  startLine: number;
  /** 1-based inclusive end line in the source file. */
  endLine: number;
  /** Source snippet of the symbol (safe after redaction at the ingestion boundary). */
  content: string;
}

export interface CodeEdge {
  filePath: string;
  /** Caller/source symbol name (or module path for IMPORTS-from-file). */
  source: string;
  /** Callee/target symbol name (or module specifier). */
  target: string;
  relationship: RelationshipType;
  /** 1-based source line where the relationship is expressed. */
  line: number;
}

export interface ExtractionResult {
  symbols: CodeSymbol[];
  edges: CodeEdge[];
}

export interface RepositoryRecord {
  id: string;
  workspaceId?: string;
  rootPath: string;
  branch?: string;
  headCommit?: string;
  indexedAt?: string;
}

export interface SymbolRecord {
  id: string;
  repositoryId: string;
  filePath: string;
  language: string;
  symbolName: string;
  symbolType: SymbolType;
  signature?: string;
  startLine: number;
  endLine: number;
  summary?: string;
  contentHash: string;
  updatedAt?: string;
}

export interface IndexPlan {
  /** File paths whose content changed (or are new) and must be re-indexed. */
  toIndex: string[];
  /** File paths present in the previous index but absent from the current walk. */
  toDrop: string[];
  /** File paths re-checked but unchanged (hash equal). */
  unchanged: number;
}

export interface IndexSummary {
  indexed: number;
  removed: number;
  unchanged: number;
}