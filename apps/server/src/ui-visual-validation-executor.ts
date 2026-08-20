import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';
import type { AgentWorkingState } from '@dacai-local-agent/context';

interface VisualValidationOptions {
  threadId: string;
  objective: string;
}

interface VisionEvidence {
  generation: number;
  inspectedAt: string;
  toolOutput: string;
  imagePath?: string;
}

interface VisualState {
  required: boolean;
  generation: number;
  validatedGeneration: number;
  status:
    | 'not_required'
    | 'required'
    | 'inspected'
    | 'passed'
    | 'changes_required'
    | 'blocked';
  changedUiFiles: string[];
  latestInspection?: VisionEvidence;
  findings?: string[];
  summary?: string;
  updatedAt: string;
}

const UI_EXTENSIONS =
  new Set([
    '.tsx',
    '.jsx',
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.html',
    '.vue',
    '.svelte',
  ]);

const MUTATION_TOOLS =
  new Set([
    'filesystem.edit',
    'filesystem.write',
    'filesystem.move',
    'filesystem.copy',
  ]);

const RECORD_SCHEMA = {
  type: 'object',

  properties: {
    verdict: {
      type: 'string',
      enum: [
        'passed',
        'changes_required',
        'blocked',
      ],
    },

    summary: {
      type: 'string',
    },

    findings: {
      type: 'array',
      items: {
        type: 'string',
      },
    },

    imagePath: {
      type: 'string',
    },
  },

  required: [
    'verdict',
    'summary',
  ],

  additionalProperties:
    false,
};

const STATUS_SCHEMA = {
  type: 'object',
  properties: {},
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
  schema: Record<string, unknown>,
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

function extension(
  path: string,
): string {
  const normalized =
    path
      .replace(
        /\\/g,
        '/',
      )
      .toLowerCase();

  const name =
    normalized
      .split('/')
      .pop() ??
    normalized;

  const index =
    name.lastIndexOf('.');

  return index >= 0
    ? name.slice(index)
    : '';
}

function isUiFile(
  path: string,
): boolean {
  const normalized =
    path
      .replace(
        /\\/g,
        '/',
      )
      .toLowerCase();

  if (
    UI_EXTENSIONS.has(
      extension(
        normalized,
      ),
    )
  ) {
    return true;
  }

  /*
   * Component/theme files occasionally use .ts.
   */
  if (
    (
      normalized.includes(
        '/components/',
      ) ||
      normalized.includes(
        '/ui/',
      ) ||
      normalized.includes(
        '/styles/',
      )
    ) &&
    (
      normalized.endsWith(
        '.ts',
      ) ||
      normalized.endsWith(
        '.js',
      )
    )
  ) {
    return true;
  }

  return false;
}

function pathsFromArguments(
  args:
    Record<string, unknown>,
): string[] {
  const paths:
    string[] = [];

  for (
    const key
    of [
      'path',
      'file',
      'filePath',
      'targetPath',
      'source',
      'sourcePath',
      'from',
      'destination',
      'destinationPath',
      'target',
      'to',
    ]
  ) {
    const value =
      args[key];

    if (
      typeof value ===
        'string' &&
      value.trim()
    ) {
      paths.push(
        value.trim(),
      );
    }
  }

  return Array.from(
    new Set(paths),
  );
}

function imagePathFromArguments(
  args:
    Record<string, unknown>,
): string | undefined {
  for (
    const key
    of [
      'path',
      'imagePath',
      'filePath',
      'image',
      'file',
    ]
  ) {
    const value =
      args[key];

    if (
      typeof value ===
        'string' &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return undefined;
}

function realMutation(
  call:
    NormalizedToolCall,

  result:
    LoopToolResult,
): boolean {
  if (
    !MUTATION_TOOLS.has(
      call.name,
    ) ||
    !result.success ||
    result.denied
  ) {
    return false;
  }

  const output =
    String(
      result.output ??
      '',
    ).toLowerCase();

  /*
   * First ImpactAwareExecutor call may intentionally stop
   * before mutation.
   */
  if (
    output.includes(
      'pre_edit_impact_gate',
    )
  ) {
    return false;
  }

  if (
    output.includes(
      '"executed": false',
    ) ||
    output.includes(
      '"executed":false',
    )
  ) {
    return false;
  }

  return true;
}

function defaultVisualState():
  VisualState {
  return {
    required: false,
    generation: 0,
    validatedGeneration: 0,
    status:
      'not_required',
    changedUiFiles: [],
    updatedAt:
      new Date()
        .toISOString(),
  };
}

function validationState(
  state: unknown,
): Record<string, unknown> {
  if (!state || typeof state !== 'object') {
    return {};
  }

  const record = state as Record<string, unknown>;
  const value = record.validationState ?? record.validation_state;

  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

async function readVisualState(
  threadId: string,
): Promise<{
  state: unknown;
  visual: VisualState;
}> {
  const state =
    await loadWorkingState(
      threadId,
    );

  const validation =
    validationState(
      state,
    );

  const uiVisual =
    validation.uiVisual;

  return {
    state,

    visual:
      (uiVisual && typeof uiVisual === 'object'
        ? (uiVisual as VisualState)
        : undefined) ??
      defaultVisualState(),
  };
}

async function persistVisualState(
  threadId: string,
  state: unknown,
  visual: VisualState,
): Promise<void> {
  if (!state || typeof state !== 'object') {
    return;
  }

  const validation =
    validationState(
      state,
    );

  await saveWorkingState({
    ...(state as Record<string, unknown>),

    threadId,

    validationState: {
      ...validation,

      uiVisual:
        visual,
    },
  } as AgentWorkingState);
}

export class UiVisualValidationExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      VisualValidationOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const base =
      existing.find(
        (tool) =>
          tool.name ===
          'vision.inspect',
      ) ??
      existing.find(
        (tool) =>
          tool.name ===
          'code.review.prepare',
      ) ??
      existing[0];

    if (!base) {
      return existing;
    }

    const additions: ToolSchema[] =
      [];

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'ui.visual.record',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'ui.visual.record',

          'Record the visual-validation verdict for the current UI mutation generation. A passed verdict is accepted only after vision.inspect produced evidence for this generation.',

          RECORD_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'ui.visual.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'ui.visual.status',

          'Read whether current UI changes still require rendered visual inspection before final patch review.',

          STATUS_SCHEMA,
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
    if (
      call.name ===
      'ui.visual.status'
    ) {
      return this.status();
    }

    if (
      call.name ===
      'ui.visual.record'
    ) {
      return this.record(
        call,
      );
    }

    /*
     * Final review is the hard gate.
     */
    if (
      call.name ===
      'code.review.prepare'
    ) {
      const {
        visual,
      } =
        await readVisualState(
          this.options.threadId,
        );

      if (
        visual.required &&
        (
          visual.status !==
            'passed' ||
          visual.validatedGeneration !==
            visual.generation
        )
      ) {
        return {
          success: false,

          error:
            'ui-visual-validation-required',

          output: [
            'UI_VISUAL_VALIDATION_REQUIRED',
            '',
            `Current UI generation: ${visual.generation}`,
            `Validated generation: ${visual.validatedGeneration}`,
            `Status: ${visual.status}`,
            '',
            'Changed UI files:',
            ...visual.changedUiFiles.map(
              (path) =>
                `- ${path}`,
            ),
            '',
            'Before final patch review:',
            '1. Render the affected UI in its actual application context.',
            '2. Capture a current screenshot using an available browser/screenshot path.',
            '3. Call vision.inspect on that screenshot.',
            '4. Inspect layout, clipping, overflow, spacing, alignment, visibility, typography, responsive behavior and obvious render errors.',
            '5. Call ui.visual.record with passed or changes_required.',
            '6. If changes_required, repair the UI and visually inspect the new generation again.',
            '',
            'Do not claim visual success from source inspection alone.',
          ].join('\n'),
        };
      }
    }

    const result =
      await this.inner.execute(
        call,
        signal,
      );

    /*
     * Observe real UI mutations AFTER the permission/edit layers
     * confirm that something actually happened.
     */
    if (
      realMutation(
        call,
        result,
      )
    ) {
      const uiPaths =
        pathsFromArguments(
          call.arguments ??
            {},
        )
          .filter(
            isUiFile,
          );

      if (
        uiPaths.length
      ) {
        const {
          state,
          visual,
        } =
          await readVisualState(
            this.options.threadId,
          );

        const next:
          VisualState = {
            ...visual,

            required:
              true,

            generation:
              visual.generation +
              1,

            status:
              'required',

            changedUiFiles:
              Array.from(
                new Set([
                  ...visual.changedUiFiles,
                  ...uiPaths,
                ]),
              ).slice(
                -30,
              ),

            latestInspection:
              undefined,

            findings:
              undefined,

            summary:
              undefined,

            updatedAt:
              new Date()
                .toISOString(),
          };

        await persistVisualState(
          this.options.threadId,
          state,
          next,
        );

        return {
          ...result,

          output: [
            result.output ?? '',
            '',
            'UI_VISUAL_GENERATION_DIRTY',
            `generation: ${next.generation}`,
            `files: ${uiPaths.join(', ')}`,
            '',
            'Rendered visual validation is now required before final patch review.',
            'Do not infer visual correctness from TypeScript, tests or source inspection alone.',
          ]
            .filter(Boolean)
            .join('\n'),

          evidence: [
            ...(
              result.evidence ??
              []
            ),

            {
              kind:
                'ui-visual-validation-required',

              summary:
                `UI mutation created visual-validation generation ${next.generation}.`,

              detail: {
                generation:
                  next.generation,

                paths:
                  uiPaths,
              },
            },
          ],
        };
      }
    }

    /*
     * Capture actual vision evidence.
     *
     * We do not decide whether the image is "good" here.
     * We only prove that the current generation was inspected.
     */
    if (
      call.name ===
        'vision.inspect' &&
      result.success
    ) {
      const {
        state,
        visual,
      } =
        await readVisualState(
          this.options.threadId,
        );

      if (
        visual.required &&
        visual.generation >
          visual.validatedGeneration
      ) {
        const next:
          VisualState = {
            ...visual,

            status:
              'inspected',

            latestInspection: {
              generation:
                visual.generation,

              inspectedAt:
                new Date()
                  .toISOString(),

              imagePath:
                imagePathFromArguments(
                  call.arguments ??
                    {},
                ),

              toolOutput:
                String(
                  result.output ??
                  '',
                ).slice(
                  0,
                  12_000,
                ),
            },

            updatedAt:
              new Date()
                .toISOString(),
          };

        await persistVisualState(
          this.options.threadId,
          state,
          next,
        );

        return {
          ...result,

          output: [
            result.output ?? '',
            '',
            'UI_VISUAL_INSPECTION_CAPTURED',
            `generation: ${next.generation}`,
            '',
            'Now decide whether the rendered evidence satisfies the requested UI outcome.',
            'Call ui.visual.record with passed or changes_required and concise evidence-grounded findings.',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }
    }

    return result;
  }

  private async status():
    Promise<LoopToolResult> {
    const {
      visual,
    } =
      await readVisualState(
        this.options.threadId,
      );

    return {
      success: true,

      output:
        JSON.stringify(
          {
            kind:
              'ui_visual_validation_status',

            ...visual,

            readyForFinalReview:
              !visual.required ||
              (
                visual.status ===
                  'passed' &&
                visual.validatedGeneration ===
                  visual.generation
              ),
          },
          null,
          2,
        ),
    };
  }

  private async record(
    call:
      NormalizedToolCall,
  ): Promise<LoopToolResult> {
    const verdict =
      call.arguments
        ?.verdict;

    const summary =
      typeof call.arguments
        ?.summary ===
        'string'
        ? call.arguments
            .summary
            .trim()
        : '';

    const findings =
      Array.isArray(
        call.arguments
          ?.findings,
      )
        ? call.arguments
            .findings
            .filter(
              (
                item,
              ): item is string =>
                typeof item ===
                  'string' &&
                item.trim().length >
                  0,
            )
            .map(
              (item) =>
                item.trim(),
            )
        : [];

    if (
      (
        verdict !==
          'passed' &&
        verdict !==
          'changes_required' &&
        verdict !==
          'blocked'
      ) ||
      !summary
    ) {
      return {
        success: false,

        error:
          'invalid-ui-visual-verdict',

        output:
          'ui.visual.record requires verdict=passed|changes_required|blocked and a concise summary.',
      };
    }

    const {
      state,
      visual,
    } =
      await readVisualState(
        this.options.threadId,
      );

    if (
      !visual.required
    ) {
      return {
        success: false,

        error:
          'ui-visual-not-required',

        output:
          'No current UI mutation generation requires visual validation.',
      };
    }

    /*
     * A pass MUST be grounded in a real vision.inspect call
     * from the current generation.
     */
    if (
      verdict ===
        'passed' &&
      (
        !visual
          .latestInspection ||
        visual
          .latestInspection
          .generation !==
          visual.generation
      )
    ) {
      return {
        success: false,

        error:
          'vision-evidence-required',

        output: [
          'Cannot record UI visual validation as passed.',
          '',
          `Generation ${visual.generation} has no successful vision.inspect evidence.`,
          'Render/capture the current UI and call vision.inspect first.',
        ].join('\n'),
      };
    }

    const next:
      VisualState = {
        ...visual,

        status:
          verdict,

        validatedGeneration:
          verdict ===
            'passed'
            ? visual.generation
            : visual
                .validatedGeneration,

        findings,

        summary,

        updatedAt:
          new Date()
            .toISOString(),
      };

    await persistVisualState(
      this.options.threadId,
      state,
      next,
    );

    if (
      verdict ===
      'changes_required'
    ) {
      return {
        success: true,

        output: [
          'UI_VISUAL_CHANGES_REQUIRED',
          '',
          `generation: ${visual.generation}`,
          `summary: ${summary}`,
          '',
          'Findings:',
          ...(
            findings.length
              ? findings.map(
                  (finding) =>
                    `- ${finding}`,
                )
              : [
                  '- See vision.inspect evidence for the current generation.',
                ]
          ),
          '',
          'Repair the smallest evidence-backed UI defects.',
          'Any subsequent UI source mutation creates a new visual generation and requires another rendered inspection.',
        ].join('\n'),
      };
    }

    if (
      verdict ===
      'blocked'
    ) {
      return {
        success: true,

        output: [
          'UI_VISUAL_VALIDATION_BLOCKED',
          `generation: ${visual.generation}`,
          `reason: ${summary}`,
          '',
          'Do not claim visual validation passed.',
        ].join('\n'),
      };
    }

    return {
      success: true,

      output: [
        'UI_VISUAL_VALIDATION_PASSED',
        `generation: ${visual.generation}`,
        `summary: ${summary}`,
        '',
        'The current UI generation now has vision-backed evidence and may proceed to final patch review.',
      ].join('\n'),

      evidence: [
        {
          kind:
            'ui-visual-validation',

          summary:
            `UI generation ${visual.generation} passed rendered vision inspection.`,

          detail: {
            generation:
              visual.generation,

            imagePath:
              visual
                .latestInspection
                ?.imagePath,

            findings,

            summary,
          },
        },
      ],
    };
  }
}
