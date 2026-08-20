import {
  hybridSymbolSearch,
  symbolEdges,
  symbolCallers,
  symbolCallees,
  dependencyImpact,
  getRepositoryArchitectureMap,
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

    execute: async (input: Record<string, unknown>) => {
      const symbol = stringArg(input, 'symbol');

      return {
        symbol,
        references: await symbolEdges(symbol),
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

    execute: async (input: Record<string, unknown>) => {
      const symbol = stringArg(input, 'symbol');

      return {
        symbol,
        callers: await symbolCallers(symbol),
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

    execute: async (input: Record<string, unknown>) => {
      const symbol = stringArg(input, 'symbol');

      return {
        symbol,
        callees: await symbolCallees(symbol),
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

