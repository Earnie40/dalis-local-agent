import {
  curateContext,
  loadWorkingState,
} from '@dacai-local-agent/context';

import {
  getRepositoryArchitectureMap,
  hybridSymbolSearch,
} from '@dacai-local-agent/repository-index';

import {
  recallFailures,
} from '@dacai-local-agent/memory';

interface BuildContextInput {
  prompt: string;
  threadId: string;
  characterBudget?: number;
}

interface ContextPacket {
  text: string;
  entries: number;
  totalCharacters: number;
  sources: string[];
}

function truncate(
  value: unknown,
  limit: number,
): string {
  if (value === undefined || value === null) {
    return '';
  }

  const text =
    typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);

  return text.length > limit
    ? `${text.slice(0, limit)}\n[truncated]`
    : text;
}

function architectureSummary(map: unknown): string {
  if (!map || typeof map !== 'object') {
    return '';
  }

  const value = map as Record<string, unknown>;

  return JSON.stringify({
    repositoryId: value.repositoryId,
    generatedAt: value.generatedAt,
    packages: value.packages,
    applications: value.applications,
    importantFiles: Array.isArray(value.importantFiles)
      ? value.importantFiles.slice(0, 80)
      : value.importantFiles,
    fileCount: value.fileCount,
    symbolCount: value.symbolCount,
    edgeCount: value.edgeCount,
  }, null, 2);
}

function symbolSummary(
  symbol: Record<string, unknown>,
): string {
  const payload =
    symbol.payload &&
    typeof symbol.payload === 'object'
      ? symbol.payload as Record<string, unknown>
      : {};

  return JSON.stringify({
    name: symbol.name,
    kind: symbol.kind,
    filePath: symbol.filePath,
    similarity: symbol.similarity,
    signature:
      payload.signature ??
      payload.definition ??
      payload.name,
    context: truncate(
      payload.definition ??
      payload.source ??
      payload.content,
      1200,
    ),
  }, null, 2);
}

async function safe<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.warn(
      'Context source unavailable:',
      error instanceof Error
        ? error.message
        : String(error),
    );

    return fallback;
  }
}

export async function buildCuratedAgentContext(
  input: BuildContextInput,
): Promise<ContextPacket> {
  const candidates: Array<{
    source: string;
    content: string;
    score: number;
    key?: string;
  }> = [];

  const architecture = await safe(
    () => getRepositoryArchitectureMap(),
    null,
  );

  if (architecture) {
    candidates.push({
      source: 'repository-architecture',
      content: architectureSummary(architecture),
      score: 0.72,
      key: 'repository-architecture',
    });
  }

  const symbols = await safe(
    () => hybridSymbolSearch(
      input.prompt,
      12,
    ),
    [],
  );

  for (const symbol of symbols) {
    candidates.push({
      source: 'semantic-symbol',
      content: symbolSummary(
        symbol as unknown as Record<string, unknown>,
      ),
      score:
        0.75 +
        Math.min(
          Number(
            (symbol as { similarity?: number })
              .similarity ?? 0,
          ),
          0.24,
        ),
      key: `symbol:${
        (symbol as { id?: string }).id ??
        JSON.stringify(symbol).slice(0, 120)
      }`,
    });
  }

  const workingState = await safe(
    () => loadWorkingState(input.threadId),
    null,
  );

  if (workingState) {
    candidates.push({
      source: 'working-state',
      content: truncate(
        workingState,
        5000,
      ),
      score: 0.95,
      key: `working-state:${input.threadId}`,
    });
  }

  const previousFailures = await safe(
    () => recallFailures(
      'agent.run',
      undefined,
      5,
    ),
    [],
  );

  if (previousFailures.length) {
    candidates.push({
      source: 'failure-memory',
      content: truncate(
        previousFailures,
        5000,
      ),
      score: 0.6,
      key: 'recent-agent-failures',
    });
  }

  const curated = curateContext(
    candidates,
    input.characterBudget ?? 24000,
  );

  const text = curated.entries
    .map(
      (entry) =>
        `### ${entry.source}\n${entry.content}`,
    )
    .join('\n\n');

  return {
    text,
    entries: curated.entries.length,
    totalCharacters:
      curated.totalCharacters,
    sources: Array.from(
      new Set(
        curated.entries.map(
          (entry) => entry.source,
        ),
      ),
    ),
  };
}
