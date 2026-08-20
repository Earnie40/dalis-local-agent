import {
  resolve,
} from 'node:path';

import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

interface LocalAppLifecycleOptions {
  workspaceRoot: string;
}

const DISCOVER_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties:
    false,
};

const ENSURE_SCHEMA = {
  type: 'object',

  properties: {
    packagePath: {
      type: 'string',

      description:
        'Optional workspace-relative frontend package path. Omit to use automatic discovery.',
    },

    script: {
      type: 'string',

      description:
        'Optional package.json lifecycle script. Normally omitted so the runtime selects dev/start/preview.',
    },
  },

  additionalProperties:
    false,
};

const STOP_SCHEMA = {
  type: 'object',

  properties: {
    packagePath: {
      type: 'string',

      description:
        'Optional workspace-relative frontend package path. Only a process carrying a DACAIS ownership receipt can be stopped.',
    },
  },

  additionalProperties:
    false,
};

/**
 * `base` may, at runtime, be a tool description shaped more loosely than the
 * declared `ToolSchema` type (some executors in this codebase duck-type
 * `parameters`/`schema` alongside or instead of `inputSchema`). This helper
 * copies whichever shape it was given, so it accepts/returns an open record.
 */
function virtualTool(
  base: ToolSchema | undefined,
  name: string,
  description: string,
  schema:
    Record<
      string,
      unknown
    >,
): ToolSchema {
  const baseRecord =
    base as (ToolSchema & Record<string, unknown>) | undefined;

  const result: Record<string, unknown> = {
    ...(baseRecord ?? {}),
    name,
    description,
  };

  if (
    base &&
    'inputSchema' in base
  ) {
    result.inputSchema =
      schema;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters =
      schema;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema =
      schema;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      schema;
  }

  return result as unknown as ToolSchema;
}

function shellCommandKey(
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
    const candidate
    of [
      'command',
      'cmd',
      'script',
    ]
  ) {
    if (
      candidate in
      properties
    ) {
      return candidate;
    }
  }

  return 'command';
}

function quoteWindows(
  value: string,
): string {
  return `"${value.replace(
    /"/g,
    '""',
  )}"`;
}

function reportFromOutput(
  output: string,
): unknown {
  const match =
    output.match(
      /DACAI_LOCAL_APP_JSON:([A-Za-z0-9_-]+)/,
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

export class LocalAppLifecycleExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      LocalAppLifecycleOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const shell =
      existing.find(
        (tool) =>
          tool.name ===
          'shell.run',
      );

    /*
     * Lifecycle management remains behind shell authorization.
     */
    if (!shell) {
      return existing;
    }

    const additions: ToolSchema[] =
      [];

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'app.local.discover',
      )
    ) {
      additions.push(
        virtualTool(
          shell,

          'app.local.discover',

          'Discover likely frontend application packages in the current workspace. Scores actual app packages above monorepo roots and identifies likely dev script, port and localhost URL.',

          DISCOVER_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'app.local.ensure',
      )
    ) {
      additions.push(
        virtualTool(
          shell,

          'app.local.ensure',

          'Ensure the workspace frontend is available on localhost. Reuse an existing reachable server or start only the selected frontend package, wait for readiness, and return its URL. Processes started here receive an ownership receipt.',

          ENSURE_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'app.local.status',
      )
    ) {
      additions.push(
        virtualTool(
          shell,

          'app.local.status',

          'Report discovered frontend applications, localhost reachability and whether a running process is owned by this DACAIS lifecycle manager.',

          DISCOVER_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'app.local.stop',
      )
    ) {
      additions.push(
        virtualTool(
          shell,

          'app.local.stop',

          'Stop a frontend process only when it was started by this DACAIS lifecycle manager and has a valid ownership receipt. Existing external developer servers are never stopped.',

          STOP_SCHEMA,
        ),
      );
    }

    return [
      ...existing,
      ...additions,
    ];
  }

  async execute(
    call:
      NormalizedToolCall,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    const operation =
      call.name ===
        'app.local.discover'
        ? 'discover'
        : call.name ===
            'app.local.ensure'
          ? 'ensure'
          : call.name ===
              'app.local.status'
            ? 'status'
            : call.name ===
                'app.local.stop'
              ? 'stop'
              : undefined;

    if (!operation) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const shell =
      this.inner
        .listTools()
        .find(
          (tool) =>
            tool.name ===
            'shell.run',
        );

    if (!shell) {
      return {
        success: false,

        error:
          'shell-run-unavailable',

        output:
          'Local application lifecycle management requires the existing authorized shell.run capability.',
      };
    }

    const request = {
      operation,

      workspaceRoot:
        this.options
          .workspaceRoot,

      packagePath:
        typeof call.arguments
          ?.packagePath ===
          'string'
          ? call.arguments
              .packagePath
              .trim()
          : undefined,

      script:
        typeof call.arguments
          ?.script ===
          'string'
          ? call.arguments
              .script
              .trim()
          : undefined,
    };

    const encoded =
      Buffer.from(
        JSON.stringify(
          request,
        ),

        'utf8',
      ).toString(
        'base64url',
      );

    const lifecycleScript =
      resolve(
        this.options
          .workspaceRoot,

        'scripts',
        'local-app-lifecycle.mjs',
      );

    const command = [
      'node',
      quoteWindows(
        lifecycleScript,
      ),
      '--payload',
      encoded,
    ].join(
      ' ',
    );

    /*
     * All process lifecycle activity goes through the current
     * tool/permission stack as an ordinary shell.run.
     */
    const shellResult =
      await this.inner.execute(
        {
          name:
            'shell.run',

          arguments: {
            [
              shellCommandKey(
                shell,
              )
            ]:
              command,
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
          `LOCAL_APP_${operation.toUpperCase()}_FAILED`,
          shellResult.output ??
            '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    const reportValue =
      reportFromOutput(
        shellResult.output ??
          '',
      );

    if (!reportValue || typeof reportValue !== 'object') {
      return {
        success: false,

        error:
          'local-app-report-missing',

        output:
          'Lifecycle command executed but did not return a parseable local-app report.',
      };
    }

    const report =
      reportValue as {
        reused?: unknown;
        url?: unknown;
        package?: { relativePath?: unknown };
        pid?: unknown;
        owned?: unknown;
        stopped?: unknown;
      };

    const evidence =
      operation ===
        'ensure'
        ? {
            kind:
              'local-app-ready',

            summary:
              report.reused
                ? `Reused reachable local frontend at ${report.url}.`
                : `Started and verified local frontend at ${report.url}.`,

            detail: {
              url:
                report.url,

              packagePath:
                report.package
                  ?.relativePath,

              pid:
                report.pid,

              owned:
                report.owned,

              reused:
                report.reused,
            },
          }
        : operation ===
            'stop'
          ? {
              kind:
                'local-app-lifecycle',

              summary:
                report.stopped
                  ? 'Stopped DACAIS-owned local frontend process.'
                  : 'No owned local frontend process required stopping.',

              detail: {
                stopped:
                  report.stopped,

                owned:
                  report.owned,

                pid:
                  report.pid,
              },
            }
          : {
              kind:
                'local-app-discovery',

              summary:
                'Inspected local frontend application lifecycle state.',

              detail: {
                operation,
              },
            };

    return {
      success: true,

      output:
        JSON.stringify(
          {
            ...(reportValue as Record<string, unknown>),

            nextAction:
              operation ===
                'ensure'
                ? [
                    'Use the returned localhost URL with browser.capture or browser.interact.',
                    'Do not start another frontend when this one is already ready.',
                    report.owned
                      ? 'This process may later be stopped with app.local.stop because the lifecycle manager owns it.'
                      : 'This process was already running and is not owned by the lifecycle manager; do not stop it.',
                  ]
                : operation ===
                    'stop'
                  ? [
                      'Only lifecycle-owned processes are eligible for automatic stop.',
                    ]
                  : undefined,
          },
          null,
          2,
        ),

      evidence: [
        evidence,
      ],
    };
  }
}
