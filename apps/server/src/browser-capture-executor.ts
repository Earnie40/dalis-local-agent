import {
  resolve,
} from 'node:path';

import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

interface BrowserCaptureOptions {
  workspaceRoot: string;
}

const CAPTURE_SCHEMA = {
  type: 'object',

  properties: {
    url: {
      type: 'string',

      description:
        'Local application URL. Only localhost/loopback HTTP(S) URLs are permitted.',
    },

    mode: {
      type: 'string',

      enum: [
        'desktop',
        'mobile',
        'both',
      ],

      description:
        'Viewport set to capture. Default: both.',
    },

    waitMs: {
      type: 'integer',

      minimum: 0,
      maximum: 10000,

      description:
        'Additional wait after DOMContentLoaded before capture. Default: 800ms.',
    },
  },

  required: [
    'url',
  ],

  additionalProperties:
    false,
};

function localUrl(
  value: string,
): URL | undefined {
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

    if (
      (
        url.protocol !==
          'http:' &&
        url.protocol !==
          'https:'
      ) ||
      !(
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
    ) {
      return undefined;
    }

    return url;
  } catch {
    return undefined;
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
      'browser.capture',

    description:
      'Open a localhost/loopback web application in a bounded headless Chromium session, capture desktop/mobile screenshots, and collect console errors, page errors, failed requests and HTTP error responses. External HTTP(S) requests are blocked.',
  };

  if (
    shellTool &&
    'inputSchema' in shellTool
  ) {
    result.inputSchema =
      CAPTURE_SCHEMA;
  }

  if (
    shellRecord &&
    'parameters' in shellRecord
  ) {
    result.parameters =
      CAPTURE_SCHEMA;
  }

  if (
    shellRecord &&
    'schema' in shellRecord
  ) {
    result.schema =
      CAPTURE_SCHEMA;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      CAPTURE_SCHEMA;
  }

  return result as unknown as ToolSchema;
}

function shellCommandKey(
  shellTool: unknown,
): string {
  const record =
    shellTool && typeof shellTool === 'object'
      ? (shellTool as Record<string, unknown>)
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

  /*
   * Existing DACAIS shell.run convention.
   */
  return 'command';
}

function extractCapture(
  output: string,
): unknown {
  const match =
    output.match(
      /DACAI_BROWSER_CAPTURE_JSON:([A-Za-z0-9_-]+)/,
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

function quoteWindows(
  value: string,
): string {
  return `"${value.replace(
    /"/g,
    '""',
  )}"`;
}

export class BrowserCaptureExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      BrowserCaptureOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    if (
      existing.some(
        (tool) =>
          tool.name ===
          'browser.capture',
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

    /*
     * Browser capture intentionally depends on the existing
     * shell authorization boundary. If shell is unavailable,
     * the tool is not advertised.
     */
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
      'browser.capture'
    ) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const urlValue =
      typeof call.arguments
        ?.url ===
        'string'
        ? call.arguments
            .url
            .trim()
        : '';

    const target =
      localUrl(
        urlValue,
      );

    if (!target) {
      return {
        success: false,

        denied: true,

        error:
          'browser-loopback-only',

        output:
          'browser.capture is restricted to localhost/loopback HTTP(S) URLs.',
      };
    }

    const mode =
      call.arguments
        ?.mode ===
        'desktop' ||
      call.arguments
        ?.mode ===
        'mobile'
        ? call.arguments.mode
        : 'both';

    const waitMs =
      Math.min(
        10_000,
        Math.max(
          0,
          Number(
            call.arguments
              ?.waitMs ??
            800,
          ),
        ),
      );

    const payload =
      Buffer.from(
        JSON.stringify({
          url:
            target.href,

          mode,

          waitMs,
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
        'capture-local-ui.mjs',
      );

    const command =
      [
        'node',
        quoteWindows(
          script,
        ),
        '--payload',
        payload,
      ].join(
        ' ',
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
          'browser.capture requires the authorized shell.run capability.',
      };
    }

    const commandKey =
      shellCommandKey(
        shellTool,
      );

    /*
     * This is the authorization boundary.
     *
     * The browser tool becomes an ordinary shell.run call
     * through all inner executors and PermissionedToolExecutor.
     */
    const shellResult =
      await this.inner.execute(
        {
          name:
            'shell.run',

          arguments: {
            [commandKey]:
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
          'BROWSER_CAPTURE_FAILED',
          shellResult.output ??
            '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    const captureValue =
      extractCapture(
        shellResult.output ??
          '',
      );

    if (!captureValue || typeof captureValue !== 'object') {
      return {
        success: false,

        error:
          'browser-capture-report-missing',

        output: [
          'The local browser command executed but did not return a valid capture report.',
          '',
          shellResult.output ??
            '',
        ].join('\n'),
      };
    }

    const capture =
      captureValue as {
        captures?: unknown;
        hasRuntimeErrors?: unknown;
        outputDir?: unknown;
      };

    const screenshots =
      Array.isArray(
        capture.captures,
      )
        ? capture.captures
            .map(
              (entry: unknown) =>
                entry && typeof entry === 'object'
                  ? (entry as { screenshotPath?: unknown })
                      .screenshotPath
                  : undefined,
            )
            .filter(
              (
                value: unknown,
              ): value is string =>
                typeof value ===
                'string' &&
              value.length > 0,
            )
        : [];

    return {
      success:
        screenshots.length >
        0,

      error:
        screenshots.length
          ? undefined
          : 'browser-no-screenshot',

      output:
        JSON.stringify(
          {
            ...(captureValue as Record<string, unknown>),

            nextAction:
              screenshots.length
                ? [
                    'Call vision.inspect on the screenshot path(s) relevant to the current UI generation.',
                    'Use desktop and mobile evidence when responsive behavior matters.',
                    'Treat console/page/network failures in this report as runtime evidence.',
                    'After vision inspection, call ui.visual.record.',
                  ]
                : [
                    'No screenshot was produced. Do not record visual validation as passed.',
                  ],
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'browser-render-capture',

          summary:
            `Captured ${screenshots.length} rendered localhost viewport(s).`,

          detail: {
            url:
              target.href,

            screenshots,

            hasRuntimeErrors:
              Boolean(
                capture
                  .hasRuntimeErrors,
              ),

            outputDir:
              capture.outputDir,
          },
        },
      ],
    };
  }
}
