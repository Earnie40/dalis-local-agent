import {
  buildFinalReviewPacket,
  recordFinalReview,
} from './final-review';

import type {
  ToolDefinition,
} from '@dacai-local-agent/tools';

export function createFinalReviewTools(options: {
  threadId: string;
  workspaceRoot: string;
  objective: string;
}): ToolDefinition[] {
  return [
    {
      name: 'code.review.prepare',

      description:
        'Build the final Git-diff review packet after implementation and validation.',

      permissionTier: 'safe',

      timeoutMs: 30_000,

      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },

      execute: async () => {
        return await buildFinalReviewPacket(
          options.threadId,
          options.workspaceRoot,
          options.objective,
        );
      },
    },

    {
      name: 'code.review.record',

      description:
        'Persist the independent reviewer verdict for the current patch.',

      permissionTier: 'safe',

      timeoutMs: 30_000,

      inputSchema: {
        type: 'object',

        properties: {
          verdict: {
            type: 'string',
            enum: [
              'approved',
              'changes_required',
            ],
          },

          summary: {
            type: 'string',
          },

          findings: {
            type: 'array',
            items: {},
          },
        },

        required: [
          'verdict',
          'summary',
        ],

        additionalProperties: false,
      },

      execute: async (
        input: Record<string, unknown>,
      ) => {
        const verdict =
          input.verdict;

        if (
          verdict !== 'approved' &&
          verdict !== 'changes_required'
        ) {
          throw new Error(
            'verdict must be approved or changes_required.',
          );
        }

        const summary =
          typeof input.summary === 'string'
            ? input.summary
            : '';

        const findings =
          Array.isArray(input.findings)
            ? input.findings
            : [];

        await recordFinalReview(
          options.threadId,
          verdict,
          summary,
          findings,
        );

        return {
          recorded: true,
          verdict,
          summary,
          findings,
        };
      },
    },
  ];
}
