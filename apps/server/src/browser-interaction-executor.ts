import {
  resolve,
} from 'node:path';

import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

interface BrowserInteractionOptions {
  workspaceRoot: string;
}

const ACTION_TYPES = [
  'click',
  'type',
  'select',
  'check',
  'uncheck',
  'press',
  'navigate',
  'wait',
  'wait_for',
  'assert_visible',
  'assert_hidden',
  'assert_text',
  'assert_value',
  'assert_url',
  'inspect',
];

const INTERACTION_SCHEMA = {
  type: 'object',

  properties: {
    url: {
      type: 'string',

      description:
        'Initial localhost/loopback application URL.',
    },

    viewport: {
      type: 'string',

      enum: [
        'desktop',
        'mobile',
      ],
    },

    actions: {
      type: 'array',

      minItems: 1,
      maxItems: 30,

      items: {
        type: 'object',

        properties: {
          type: {
            type: 'string',

            enum:
              ACTION_TYPES,
          },

          selector: {
            type: 'string',
          },

          value: {
            type: 'string',
          },

          key: {
            type: 'string',
          },

          url: {
            type: 'string',
          },

          ms: {
            type: 'integer',
          },

          timeoutMs: {
            type: 'integer',
          },

          state: {
            type: 'string',

            enum: [
              'visible',
              'hidden',
            ],
          },
        },

        required: [
          'type',
        ],

        additionalProperties:
          false,
      },
    },
  },

  required: [
    'url',
    'actions',
  ],

  additionalProperties:
    false,
};

function isLoopbackUrl(
  value: string,
): boolean {
  try {
    const url =
      new URL(value);

    const host =
      url.hostname
        .toLowerCase()
        .replace(
          /^\[|\]$/g,
          '',
        );

    return (
      (
        url.protocol ===
          'http:' ||
        url.protocol ===
          'https:'
      ) &&
      (
        host ===
          'localhost' ||
        host ===
          '127.0.0.1' ||
        host ===
          '::1' ||
        host.startsWith(
          '127.',
        )
      )
    );
  } catch {
    return false;
  }
}

/**
 * `shellTool` may, at runtime, be a tool description shaped more loosely
 * than the declared `ToolSchema` type (some executors in this codebase
 * duck-type `parameters`/`schema` alongside or instead of `inputSchema`).
 * This helper copies whichever shape it was given, so it accepts/returns an
 * open record.
 */
function virtualTool(
  shellTool: ToolSchema | undefined,
): ToolSchema {
  const shellRecord =
    shellTool as (ToolSchema & Record<string, unknown>) | undefined;

  const result: Record<string, unknown> = {
    ...(shellRecord ?? {}),

    name:
      'browser.interact',

    description:
      'Interact with a localhost application using bounded browser actions such as click, type, select, keyboard navigation and DOM assertions. Captures before/after screenshots and runtime errors. No arbitrary JavaScript evaluation, public navigation, downloads or file uploads.',
  };

  if (
    shellTool &&
    'inputSchema' in
      shellTool
  ) {
    result.inputSchema =
      INTERACTION_SCHEMA;
  }

  if (
    shellRecord &&
    'parameters' in
      shellRecord
  ) {
    result.parameters =
      INTERACTION_SCHEMA;
  }

  if (
    shellRecord &&
    'schema' in
      shellRecord
  ) {
    result.schema =
      INTERACTION_SCHEMA;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      INTERACTION_SCHEMA;
  }

  return result as unknown as ToolSchema;
}

function commandKey(
  tool: unknown,
): string {
  const record =
    tool && typeof tool === 'object'
      ? (tool as Record<string, unknown>)
      : undefined;

  const schemaValue =
    record?.inputSchema ??
    record?.parameters ??
    record?.schema;

  const schema =
    schemaValue && typeof schemaValue === 'object'
      ? (schemaValue as Record<string, unknown>)
      : undefined;

  const propertiesValue =
    schema?.properties;

  const properties: Record<string, unknown> =
    propertiesValue && typeof propertiesValue === 'object'
      ? (propertiesValue as Record<string, unknown>)
      : {};

  for (
    const key
    of [
      'command',
      'cmd',
      'script',
    ]
  ) {
    if (
      key in
      properties
    ) {
      return key;
    }
  }

  return 'command';
}

function quoted(
  value: string,
): string {
  return `"${value.replace(
    /"/g,
    '""',
  )}"`;
}

function extractReport(
  output: string,
): unknown {
  const match =
    output.match(
      /DACAI_BROWSER_INTERACTION_JSON:([A-Za-z0-9_-]+)/,
    );

  if (!match) {
    return undefined;
  }

  try {
    return JSON.parse(
      Buffer.from(
        match[1],
        'base64url',
      ).toString(
        'utf8',
      ),
    );
  } catch {
    return undefined;
  }
}

function validateActions(
  actions: unknown[],
): string | undefined {
  for (
    let index = 0;
    index <
    actions.length;
    index += 1
  ) {
    const actionValue =
      actions[index];

    if (
      !actionValue ||
      typeof actionValue !==
        'object'
    ) {
      return `Invalid browser action at index ${index}.`;
    }

    const action =
      actionValue as Record<string, unknown>;

    if (
      !ACTION_TYPES.includes(
        action.type as string,
      )
    ) {
      return `Invalid browser action at index ${index}.`;
    }

    if (
      action.type ===
        'navigate' &&
      (
        typeof action.url !==
          'string' ||
        !isLoopbackUrl(
          action.url,
        )
      )
    ) {
      return `navigate action ${index} must target loopback.`;
    }

    /*
     * Explicitly reject capability expansion through extra
     * arguments even if a provider ignores JSON schema.
     */
    for (
      const forbidden
      of [
        'javascript',
        'evaluate',
        'script',
        'file',
        'filePath',
        'upload',
        'download',
      ]
    ) {
      if (
        forbidden in
        action
      ) {
        return `Action ${index} contains forbidden field "${forbidden}".`;
      }
    }
  }

  return undefined;
}

export class BrowserInteractionExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      BrowserInteractionOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    if (
      existing.some(
        (tool) =>
          tool.name ===
          'browser.interact',
      )
    ) {
      return existing;
    }

    const shellTool =
      existing.find(
        (tool) =>
          tool.name ===
          'shell.run',
      );

    if (!shellTool) {
      return existing;
    }

    return [
      ...existing,
      virtualTool(
        shellTool,
      ),
    ];
  }

  async execute(
    call:
      NormalizedToolCall,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    if (
      call.name !==
      'browser.interact'
    ) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const url =
      typeof call.arguments
        ?.url ===
        'string'
        ? call.arguments
            .url
            .trim()
        : '';

    if (
      !isLoopbackUrl(
        url,
      )
    ) {
      return {
        success: false,

        denied: true,

        error:
          'browser-loopback-only',

        output:
          'browser.interact is restricted to localhost/loopback HTTP(S) URLs.',
      };
    }

    const actions =
      Array.isArray(
        call.arguments
          ?.actions,
      )
        ? call.arguments.actions
            .slice(
              0,
              30,
            )
        : [];

    if (!actions.length) {
      return {
        success: false,

        error:
          'missing-actions',

        output:
          'browser.interact requires at least one action.',
      };
    }

    const actionError =
      validateActions(
        actions,
      );

    if (actionError) {
      return {
        success: false,

        denied: true,

        error:
          'invalid-browser-action',

        output:
          actionError,
      };
    }

    const payload =
      Buffer.from(
        JSON.stringify({
          url,

          viewport:
            call.arguments
              ?.viewport ===
              'mobile'
              ? 'mobile'
              : 'desktop',

          actions,
        }),

        'utf8',
      ).toString(
        'base64url',
      );

    const script =
      resolve(
        this.options
          .workspaceRoot,

        'scripts',
        'interact-local-ui.mjs',
      );

    const shellTool =
      this.inner
        .listTools()
        .find(
          (tool) =>
            tool.name ===
            'shell.run',
        );

    if (!shellTool) {
      return {
        success: false,

        error:
          'shell-run-unavailable',

        output:
          'browser.interact requires the existing authorized shell.run capability.',
      };
    }

    const shellResult =
      await this.inner.execute(
        {
          name:
            'shell.run',

          arguments: {
            [
              commandKey(
                shellTool,
              )
            ]:
              [
                'node',
                quoted(
                  script,
                ),
                '--payload',
                payload,
              ].join(
                ' ',
              ),
          },
        },
        signal,
      );

    if (
      !shellResult.success
    ) {
      return {
        ...shellResult,

        output: [
          'BROWSER_INTERACTION_FAILED',
          shellResult.output ??
            '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    const reportValue =
      extractReport(
        shellResult.output ??
          '',
      );

    if (!reportValue || typeof reportValue !== 'object') {
      return {
        success: false,

        error:
          'interaction-report-missing',

        output:
          'Browser process completed without a parseable interaction report.',
      };
    }

    const report =
      reportValue as {
        interactionPassed?: unknown;
        actionCount?: unknown;
        finalUrl?: unknown;
        viewport?: unknown;
        failedActionCount?: unknown;
        screenshots?: unknown;
        outputDir?: unknown;
      };

    const passed =
      report
        .interactionPassed ===
        true;

    return {
      /*
       * Failed DOM assertions are real failed verification,
       * unlike an ordinary capture that still produced pixels.
       */
      success:
        passed,

      error:
        passed
          ? undefined
          : 'ui-interaction-verification-failed',

      output:
        JSON.stringify(
          {
            ...(reportValue as Record<string, unknown>),

            nextAction:
              passed
                ? [
                    'The requested DOM interaction/assertion sequence passed.',
                    'Use vision.inspect on screenshots.after when rendered appearance is also relevant.',
                    'Do not infer behavior outside the actions/assertions that were actually executed.',
                  ]
                : [
                    'At least one browser interaction/assertion or runtime check failed.',
                    'Use the failed step and runtime evidence to locate the smallest implementation defect.',
                    'Repair it and rerun the relevant interaction sequence.',
                  ],
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'ui-runtime-interaction',

          summary:
            passed
              ? `Local UI interaction sequence passed ${report.actionCount} action(s).`
              : `Local UI interaction sequence failed after ${report.actionCount} attempted action(s).`,

          detail: {
            url,

            finalUrl:
              report.finalUrl,

            viewport:
              report.viewport,

            interactionPassed:
              passed,

            failedActionCount:
              report.failedActionCount,

            screenshots:
              report.screenshots,

            outputDir:
              report.outputDir,
          },
        },
      ],
    };
  }
}
