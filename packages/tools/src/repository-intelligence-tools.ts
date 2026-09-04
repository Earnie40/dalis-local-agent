import {
  hybridSymbolSearch,
  symbolEdges,
  symbolCallers,
  symbolCallees,
  dependencyImpact,
  getRepositoryArchitectureMap,
  renderPathDiagram,
  traceRepositoryPaths,
  type PathDiagramFormat,
  type RelationshipType,
} from '@dacai-local-agent/repository-index';

import {
  loadWorkingState,
} from '@dacai-local-agent/context';

import {
  recallFailures,
} from '@dacai-local-agent/memory';

import {
  READ_ONLY_FILESYSTEM_TOOLS,
} from './filesystem-tools';

/**
 * Clone the permission/capability characteristics of an existing safe,
 * read-only filesystem tool. Repository intelligence is read-only.
 */
const READ_ONLY_BASE = READ_ONLY_FILESYSTEM_TOOLS[0];

function stringArg(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required.`);
  }

  return value.trim();
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = input[key];

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

const TRACE_RELATIONSHIPS = new Set<RelationshipType>([
  'CALLS', 'IMPORTS', 'IMPLEMENTS', 'EXTENDS', 'DEPENDS_ON', 'TESTED_BY',
  'CONFIGURES', 'READS_FROM', 'WRITES_TO', 'SUPERSEDES', 'RELATED_TO',
  'FAILS_WITH', 'FIXED_BY',
]);

function traceRelationships(input: Record<string, unknown>): RelationshipType[] | undefined {
  if (input.relationships === undefined) return undefined;
  if (!Array.isArray(input.relationships) || !input.relationships.length) {
    throw new Error('relationships must be a non-empty array when supplied.');
  }
  const values = [...new Set(input.relationships.map((value) => String(value).toUpperCase()))];
  const invalid = values.find((value) => !TRACE_RELATIONSHIPS.has(value as RelationshipType));
  if (invalid) throw new Error(`Unsupported relationship "${invalid}".`);
  return values as RelationshipType[];
}

export const REPOSITORY_INTELLIGENCE_TOOLS = [
  {
    ...READ_ONLY_BASE,

    name: 'code.symbol.search',

    description:
      'Search indexed repository symbols using semantic pgvector embeddings plus lexical relevance. Prefer this before broad filesystem exploration.',

    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language description, symbol name, implementation concept, configuration key, or behavior to locate.',
        },
        limit: {
          type: 'number',
          description:
            'Maximum results to return. Defaults to 12.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>) => {
      const query = stringArg(input, 'query');
      const limit = Math.min(
        optionalNumber(input, 'limit', 12),
        30,
      );

      const results =
        await hybridSymbolSearch(query, limit);

      return {
        query,
        count: results.length,
        results,
      };
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.symbol.references',

    description:
      'Return indexed repository graph edges and references associated with a symbol.',

    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description:
            'Exact or indexed symbol name to inspect.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>, ctx: { workspaceRoot?: string }) => {
      const symbol = stringArg(input, 'symbol');

      return {
        symbol,
        references: await symbolEdges(symbol, ctx.workspaceRoot),
      };
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.symbol.callers',

    description:
      'Find indexed callers or incoming relationships for a repository symbol.',

    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>, ctx: { workspaceRoot?: string }) => {
      const symbol = stringArg(input, 'symbol');

      return {
        symbol,
        callers: await symbolCallers(symbol, ctx.workspaceRoot),
      };
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.symbol.callees',

    description:
      'Find indexed callees or outgoing relationships for a repository symbol.',

    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>, ctx: { workspaceRoot?: string }) => {
      const symbol = stringArg(input, 'symbol');

      return {
        symbol,
        callees: await symbolCallees(symbol, ctx.workspaceRoot),
      };
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.symbol.impact',

    description:
      'Analyze the dependency impact of modifying a symbol, including graph edges, references, and related tests.',

    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>) => {
      const symbol = stringArg(input, 'symbol');

      return await dependencyImpact(symbol);
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.path.trace',

    description:
      'Trace bounded indexed symbol paths from A to B and return file/line evidence plus Mermaid or DOT graph source. This is static indexed evidence, not a runtime trace.',

    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Exact indexed source symbol name. Use code.symbol.search first when uncertain.',
        },
        to: {
          type: 'string',
          description: 'Exact indexed destination symbol name.',
        },
        relationships: {
          type: 'array',
          items: { type: 'string', enum: [...TRACE_RELATIONSHIPS] },
          description: 'Indexed edge types to traverse. Defaults to CALLS.',
        },
        maxDepth: { type: 'number', minimum: 1, maximum: 24, description: 'Maximum edges in a path. Defaults to 8.' },
        maxPaths: { type: 'number', minimum: 1, maximum: 25, description: 'Maximum paths to return. Defaults to 5.' },
        maxVisited: { type: 'number', minimum: 1, maximum: 50000, description: 'Maximum queued paths to inspect. Defaults to 5000.' },
        format: { type: 'string', enum: ['mermaid', 'dot'], description: 'Graph source format. Defaults to mermaid.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>, ctx: { workspaceRoot?: string }) => {
      if (!ctx.workspaceRoot) throw new Error('A workspace is required.');
      const from = stringArg(input, 'from');
      const to = stringArg(input, 'to');
      const relationships = traceRelationships(input);
      const maxDepth = Math.min(optionalNumber(input, 'maxDepth', 8), 24);
      const maxPaths = Math.min(optionalNumber(input, 'maxPaths', 5), 25);
      const maxVisited = Math.min(optionalNumber(input, 'maxVisited', 5_000), 50_000);
      const format: PathDiagramFormat = input.format === 'dot' ? 'dot' : 'mermaid';
      if (input.format !== undefined && input.format !== 'dot' && input.format !== 'mermaid') {
        throw new Error('format must be "mermaid" or "dot".');
      }

      const trace = await traceRepositoryPaths(ctx.workspaceRoot, from, to, {
        relationships,
        maxDepth,
        maxPaths,
        maxVisited,
      });
      return {
        ...trace,
        diagramFormat: format,
        diagram: renderPathDiagram(trace, format),
      };
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.architecture.context',

    description:
      'Return the persisted repository architecture map containing applications, packages, important files, symbols, and dependency information.',

    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },

    execute: async () => {
      const map =
        await getRepositoryArchitectureMap();

      if (!map) {
        throw new Error(
          'Repository architecture map has not been generated yet.',
        );
      }

      return map;
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.failure.recall',

    description:
      'Recall previous structured agent failures and corrections for a similar operation or error.',

    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description:
            'Operation or tool name, such as filesystem.read, code.diagnostics, or agent.run.',
        },
        errorSignature: {
          type: 'string',
          description:
            'Optional distinctive fragment of the current error.',
        },
        limit: {
          type: 'number',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>) => {
      const operation =
        stringArg(input, 'operation');

      const signature =
        typeof input.errorSignature === 'string'
          ? input.errorSignature.trim()
          : undefined;

      const limit = Math.min(
        optionalNumber(input, 'limit', 8),
        25,
      );

      return {
        operation,
        failures: await recallFailures(
          operation,
          signature,
          limit,
        ),
      };
    },
  },

  {
    ...READ_ONLY_BASE,

    name: 'code.working-state.get',

    description:
      'Retrieve persistent structured working state for a known agent thread or run.',

    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description:
            'Agent run/thread identifier.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>) => {
      const threadId =
        stringArg(input, 'threadId');

      return {
        threadId,
        state: await loadWorkingState(threadId),
      };
    },
  },
  {
    ...READ_ONLY_BASE,

    name: 'code.validation.status',

    description:
      'Read persistent validation requirements and results for the current or supplied agent thread.',

    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },

    execute: async (input: Record<string, unknown>) => {
      const threadId =
        stringArg(input, 'threadId');

      const state =
        await loadWorkingState(threadId);

      return {
        threadId,
        validationState:
          state?.validation_state ??
          state?.validationState ??
          null,
      };
    },
  },
];

