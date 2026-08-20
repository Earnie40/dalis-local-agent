import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

interface Options {
  threadId: string;
  objective: string;
}

interface VisionReview {
  model: string;
  success: boolean;
  score: number | undefined;
  output: string;
}

interface VisionReviewResult {
  mode:
    | 'unavailable'
    | 'schema-incompatible'
    | 'multi-model'
    | 'single-model';
  reviews: VisionReview[];
}

const EMPTY = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function toolSchema(base: unknown): Record<string, unknown> {
  const record =
    base && typeof base === 'object'
      ? (base as Record<string, unknown>)
      : undefined;

  const value =
    record?.inputSchema ??
    record?.parameters ??
    record?.schema;

  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function schemaProperties(base: unknown): Record<string, unknown> {
  const value = toolSchema(base).properties;

  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

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
  const result: Record<string, unknown> = {
    ...(base ?? {}),
    name,
    description,
  };

  if ('inputSchema' in result) result.inputSchema = schema;
  else if ('parameters' in result) result.parameters = schema;
  else if ('schema' in result) result.schema = schema;
  else result.inputSchema = schema;

  return result as unknown as ToolSchema;
}

function shellCommandKey(tool: unknown): string {
  const props = schemaProperties(tool);

  if ('command' in props) return 'command';
  if ('cmd' in props) return 'cmd';
  if ('script' in props) return 'script';

  return 'command';
}

function encodePayload(value: unknown): string {
  return Buffer
    .from(JSON.stringify(value))
    .toString('base64url');
}

function markerJson(output: string, marker: string): unknown {
  const line = output
    .split(/\r?\n/)
    .find((x) => x.startsWith(marker));

  if (!line) return undefined;

  try {
    return JSON.parse(
      Buffer
        .from(line.slice(marker.length), 'base64url')
        .toString('utf8'),
    );
  } catch {
    return undefined;
  }
}

function findArtifact(
  value: unknown,
  extension: string,
): string | undefined {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? {});

  const normalized = text.replaceAll('\\\\', '/');

  const re = new RegExp(
    `([A-Za-z]:)?[^"'\\n\\r]*?\\.${extension.replace('.', '\\.')}`,
    'i',
  );

  return normalized.match(re)?.[0]?.trim();
}

function configuredVisionModels(): string[] {
  const multi = process.env.DACAI_VISION_MODELS
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  if (multi?.length) {
    return Array.from(new Set(multi));
  }

  const single = process.env.DACAI_VISION_MODEL?.trim();

  return single ? [single] : [];
}

function visionArguments(
  tool: unknown,
  artifact: string,
  prompt: string,
  model?: string,
): Record<string, unknown> | undefined {
  const props = schemaProperties(tool);
  const args: Record<string, unknown> = {};

  let imageMapped = false;

  for (const key of [
    'imagePath',
    'path',
    'image',
    'file',
    'artifactPath',
    'screenshotPath',
  ]) {
    if (key in props) {
      args[key] = artifact;
      imageMapped = true;
      break;
    }
  }

  for (const key of [
    'prompt',
    'instruction',
    'question',
    'task',
  ]) {
    if (key in props) {
      args[key] = prompt;
      break;
    }
  }

  if (
    model &&
    'model' in props
  ) {
    args.model = model;
  }

  return imageMapped ? args : undefined;
}

function videoArguments(
  tool: unknown,
  videoPath: string,
  prompt: string,
  model?: string,
): Record<string, unknown> | undefined {
  const props = schemaProperties(tool);
  const args: Record<string, unknown> = {};

  let mapped = false;

  for (const key of [
    'videoPath',
    'video',
    'file',
    'path',
  ]) {
    if (key in props) {
      args[key] = videoPath;
      mapped = true;
      break;
    }
  }

  for (const key of [
    'prompt',
    'instruction',
    'question',
    'task',
  ]) {
    if (key in props) {
      args[key] = prompt;
      break;
    }
  }

  if (
    model &&
    'model' in props
  ) {
    args.model = model;
  }

  return mapped ? args : undefined;
}

function numericScore(output: string): number | undefined {
  const patterns = [
    /"overall"\s*:\s*(\d+(?:\.\d+)?)/i,
    /"score"\s*:\s*(\d+(?:\.\d+)?)/i,
    /\boverall(?:\s+score)?\s*[:=-]\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);

    if (match) {
      const n = Number(match[1]);

      if (
        Number.isFinite(n) &&
        n >= 0 &&
        n <= 100
      ) {
        return n;
      }
    }
  }

  return undefined;
}

function consensus(scores: number[]) {
  if (!scores.length) {
    return {
      score: null,
      agreement: null,
    };
  }

  const mean =
    scores.reduce((a, b) => a + b, 0) /
    scores.length;

  if (scores.length === 1) {
    return {
      score: Math.round(mean * 10) / 10,
      agreement: null,
    };
  }

  const variance =
    scores.reduce(
      (sum, score) =>
        sum + Math.pow(score - mean, 2),
      0,
    ) / scores.length;

  const sd = Math.sqrt(variance);

  return {
    score: Math.round(mean * 10) / 10,
    agreement: Math.max(
      0,
      Math.round((1 - sd / 50) * 1000) / 1000,
    ),
  };
}

const AESTHETIC_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    criteria: { type: 'string' },
  },
  additionalProperties: false,
};

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    focus: { type: 'string' },
  },
  additionalProperties: false,
};

const SPATIAL_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
  },
  additionalProperties: false,
};

const ANIMATION_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    durationMs: {
      type: 'integer',
      minimum: 250,
      maximum: 15000,
    },
    frames: {
      type: 'integer',
      minimum: 3,
      maximum: 30,
    },
  },
  required: ['url'],
  additionalProperties: false,
};

const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    actions: {
      type: 'array',
      items: { type: 'object' },
    },
  },
  required: ['url'],
  additionalProperties: false,
};

const CONTRACT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    durationMs: {
      type: 'integer',
      minimum: 500,
      maximum: 30000,
    },
    actions: {
      type: 'array',
      items: { type: 'object' },
    },
  },
  required: ['url'],
  additionalProperties: false,
};

const MOCK_SCHEMA = {
  type: 'object',
  properties: {
    contractPath: { type: 'string' },
  },
  required: ['contractPath'],
  additionalProperties: false,
};

export class ExperienceIntelligenceExecutor
implements ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly options: Options,
  ) {}

  listTools() {
    const existing = this.inner.listTools();
    const base = existing[0];

    if (!base) return existing;

    const additions: ToolSchema[] = [];

    const add = (
      name: string,
      description: string,
      schema: Record<string, unknown>,
    ) => {
      if (!existing.some((t) => t.name === name)) {
        additions.push(
          virtualTool(
            base,
            name,
            description,
            schema,
          ),
        );
      }
    };

    add(
      'ui.aesthetic.score',
      'Capture the localhost UI and obtain independent multimodal judgments of visual hierarchy, spacing, typography, coherence, polish and aesthetic quality. Multi-model consensus is used when DACAI_VISION_MODELS and the vision tool support model selection.',
      AESTHETIC_SCHEMA,
    );

    add(
      'ui.design_system.infer',
      'Infer the design system already emerging from the repository: tokens, spacing, typography, radii, colors and repeated UI component patterns. Returns evidence for normal transactional refactoring.',
      DESIGN_SCHEMA,
    );

    add(
      'ui.spatial.inspect',
      'Inspect real CSS/WebGL/Three.js spatial implementation evidence together with rendered visual evidence to determine whether the interface actually occupies and moves through depth.',
      SPATIAL_SCHEMA,
    );

    add(
      'ui.animation.validate',
      'Capture a timed localhost animation frame sequence, build a temporal contact sheet and review trajectory, direction, clipping, continuity, easing and depth behavior.',
      ANIMATION_SCHEMA,
    );

    add(
      'ui.video.review',
      'Record a complete bounded localhost browser interaction video plus temporal keyframes and perform multimodal interaction review.',
      VIDEO_SCHEMA,
    );

    add(
      'api.contract.record',
      'Observe localhost fetch/XHR traffic and record sanitized request/response API shapes without persisting secret-bearing values.',
      CONTRACT_SCHEMA,
    );

    add(
      'api.mock.generate',
      'Generate a deterministic non-production mock candidate from a previously learned API contract. Generated mocks are never automatically activated.',
      MOCK_SCHEMA,
    );

    add(
      'experience.status',
      'Report configured vision models and availability of supporting browser, vision and shell capabilities.',
      EMPTY,
    );

    return [
      ...existing,
      ...additions,
    ];
  }

  async execute(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    switch (call.name) {
      case 'experience.status':
        return this.status();

      case 'ui.aesthetic.score':
        return this.aesthetic(
          call.arguments ?? {},
          signal,
        );

      case 'ui.design_system.infer':
        return this.designSystem(
          call.arguments ?? {},
          signal,
        );

      case 'ui.spatial.inspect':
        return this.spatial(
          call.arguments ?? {},
          signal,
        );

      case 'ui.animation.validate':
        return this.animation(
          call.arguments ?? {},
          signal,
        );

      case 'ui.video.review':
        return this.video(
          call.arguments ?? {},
          signal,
        );

      case 'api.contract.record':
        return this.contract(
          call.arguments ?? {},
          signal,
        );

      case 'api.mock.generate':
        return this.mock(
          call.arguments ?? {},
          signal,
        );
    }

    return this.inner.execute(
      call,
      signal,
    );
  }

  private status(): LoopToolResult {
    const tools =
      this.inner.listTools();

    const models =
      configuredVisionModels();

    return {
      success: true,
      output: JSON.stringify({
        objective:
          this.options.objective,

        visionModels:
          models,

        aestheticMode:
          models.length > 1
            ? 'multi-model-requested'
            : 'single-model',

        capabilities: {
          vision:
            tools.some(
              (t) =>
                t.name ===
                'vision.inspect',
            ),

          browserCapture:
            tools.some(
              (t) =>
                t.name ===
                'browser.capture',
            ),

          browserInteraction:
            tools.some(
              (t) =>
                t.name ===
                'browser.interact',
            ),

          shell:
            tools.some(
              (t) =>
                t.name ===
                'shell.run',
            ),
        },
      }, null, 2),
    };
  }

  private async runScript(
    script: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const shell =
      this.inner
        .listTools()
        .find(
          (t) =>
            t.name ===
            'shell.run',
        );

    if (!shell) {
      return {
        success: false,
        error:
          'shell-run-unavailable',
        output:
          'shell.run is required for this bounded local capture operation.',
      };
    }

    const key =
      shellCommandKey(
        shell,
      );

    const encoded =
      encodePayload(
        payload,
      );

    return this.inner.execute(
      {
        name: 'shell.run',
        arguments: {
          [key]:
            `node "${script}" --payload ${encoded}`,
        },
      },
      signal,
    );
  }

  private async capture(
    url: string | undefined,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const browser =
      this.inner
        .listTools()
        .find(
          (t) =>
            t.name ===
            'browser.capture',
        );

    if (!browser) {
      return {
        success: false,
        error:
          'browser-capture-unavailable',
        output:
          'browser.capture is unavailable.',
      };
    }

    const props =
      schemaProperties(
        browser,
      );

    const args:
      Record<string, unknown> =
        {};

    if (
      url &&
      'url' in props
    ) {
      args.url = url;
    }

    return this.inner.execute(
      {
        name:
          'browser.capture',
        arguments:
          args,
      },
      signal,
    );
  }

  private async visionReviews(
    artifact: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<VisionReviewResult> {
    const tool =
      this.inner
        .listTools()
        .find(
          (t) =>
            t.name ===
            'vision.inspect',
        );

    if (!tool) {
      return {
        mode:
          'unavailable',
        reviews: [],
      };
    }

    const models =
      configuredVisionModels();

    const supportsModel =
      'model' in
      schemaProperties(
        tool,
      );

    const selected =
      supportsModel &&
      models.length
        ? models
        : [undefined];

    const reviews: VisionReview[] = [];

    for (
      const model
      of selected
    ) {
      const args =
        visionArguments(
          tool,
          artifact,
          prompt,
          model,
        );

      if (!args) {
        return {
          mode:
            'schema-incompatible',
          reviews,
        };
      }

      const result =
        await this.inner.execute(
          {
            name:
              'vision.inspect',
            arguments:
              args,
          },
          signal,
        );

      reviews.push({
        model:
          model ??
          models[0] ??
          'configured-default',

        success:
          result.success,

        score:
          numericScore(
            result.output ??
              '',
          ),

        output:
          result.output,
      });

      if (
        signal?.aborted
      ) {
        break;
      }
    }

    return {
      mode:
        supportsModel &&
        selected.length > 1
          ? 'multi-model'
          : 'single-model',

      reviews,
    };
  }

  private async aesthetic(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const capture =
      await this.capture(
        typeof args.url ===
        'string'
          ? args.url
          : undefined,
        signal,
      );

    if (!capture.success) {
      return capture;
    }

    const screenshot =
      findArtifact(
        capture.output,
        'png',
      );

    if (!screenshot) {
      return {
        success: false,
        error:
          'screenshot-artifact-not-found',
        output:
          `Browser capture succeeded but no PNG artifact could be located.\n${capture.output}`,
      };
    }

    const criteria =
      typeof args.criteria ===
      'string'
        ? args.criteria
        : '';

    const review =
      await this.visionReviews(
        screenshot,
        [
          'Evaluate this application UI as a professional product-design reviewer.',
          'Return an overall aesthetic score from 0-100.',
          'Also evaluate visual hierarchy, spacing, typography, consistency, polish, density, affordances, depth, responsiveness cues and obvious accessibility concerns.',
          'Separate objective defects from subjective preferences.',
          criteria
            ? `Additional criteria: ${criteria}`
            : '',
          'Prefer JSON with an "overall" numeric field followed by concise findings.',
        ]
          .filter(Boolean)
          .join('\n'),
        signal,
      );

    const scores =
      review.reviews
        .map(
          (x) =>
            x.score,
        )
        .filter(
          (
            x,
          ): x is number =>
            typeof x ===
            'number',
        );

    return {
      success:
        review.reviews.some(
          (x) =>
            x.success,
        ),

      output:
        JSON.stringify(
          {
            capability:
              'ai-aesthetic-scoring',

            artifact:
              screenshot,

            mode:
              review.mode,

            consensus:
              consensus(
                scores,
              ),

            reviews:
              review.reviews,
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'aesthetic-review',

          summary:
            review.mode ===
              'multi-model'
              ? `Aesthetic review used ${review.reviews.length} independent configured vision models.`
              : 'Aesthetic review completed in single-model mode.',

          detail: {
            artifact:
              screenshot,

            scores,
          },
        },
      ],
    };
  }

  private async search(
    pattern: string,
    filePattern: string,
    signal?: AbortSignal,
  ) {
    const search =
      this.inner
        .listTools()
        .find(
          (t) =>
            t.name ===
            'filesystem.search',
        );

    if (!search) {
      return undefined;
    }

    const props =
      schemaProperties(
        search,
      );

    const args:
      Record<string, unknown> =
        {};

    if (
      'pattern' in props
    ) {
      args.pattern =
        pattern;
    } else {
      return undefined;
    }

    if (
      'filePattern' in
      props
    ) {
      args.filePattern =
        filePattern;
    }

    return this.inner.execute(
      {
        name:
          'filesystem.search',
        arguments:
          args,
      },
      signal,
    );
  }

  private async designSystem(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const queries = [
      {
        label:
          'tokens',
        pattern:
          '--[A-Za-z0-9_-]+\\s*:',
      },

      {
        label:
          'colors',
        pattern:
          '#[0-9A-Fa-f]{3,8}|rgb\\(|hsl\\(',
      },

      {
        label:
          'spacing-radius',
        pattern:
          'padding|margin|gap|border-radius',
      },

      {
        label:
          'typography',
        pattern:
          'font-size|font-family|font-weight|line-height',
      },

      {
        label:
          'components',
        pattern:
          'className=|styled\\(|createStyles|module\\.css',
      },
    ];

    const observations = [];

    for (
      const query
      of queries
    ) {
      const result =
        await this.search(
          query.pattern,
          '\\.(css|scss|sass|less|tsx|jsx|ts|js)$',
          signal,
        );

      if (result) {
        observations.push({
          category:
            query.label,

          success:
            result.success,

          output:
            result.output,
        });
      }
    }

    return {
      success:
        observations.length >
        0,

      output:
        JSON.stringify(
          {
            capability:
              'design-system-inference',

            focus:
              args.focus ??
              null,

            observations,

            instructions: [
              'Infer tokens already repeated in the actual repository.',
              'Identify duplicated visual primitives and near-identical components.',
              'Prefer convergence toward existing patterns rather than imposing an unrelated design language.',
              'Any refactor must use the normal impact, transaction, validation, browser and review workflow.',
            ],
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'design-system-inference',

          summary:
            `Collected ${observations.length} design-system evidence categories.`,
        },
      ],
    };
  }

  private async spatial(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const source =
      await this.search(
        'perspective|preserve-3d|translateZ|matrix3d|rotateX|rotateY|THREE\\.|WebGL|camera|scene|depth|framer-motion',
        '\\.(css|scss|tsx|jsx|ts|js)$',
        signal,
      );

    const capture =
      await this.capture(
        typeof args.url ===
        'string'
          ? args.url
          : undefined,
        signal,
      );

    let visual:
      VisionReviewResult | undefined = undefined;

    const screenshot =
      capture.success
        ? findArtifact(
            capture.output,
            'png',
          )
        : undefined;

    if (screenshot) {
      visual =
        await this.visionReviews(
          screenshot,
          [
            'Review this UI specifically as a spatial-computing / 3D-interface critic.',
            'Determine whether interface geometry itself creates meaningful depth rather than merely displaying 3D artwork.',
            'Assess approach/recede direction, camera perspective, foreground/background construction, layering, occlusion, apparent Z motion and whether navigation direction is physically expressed by the interface.',
          ].join('\n'),
          signal,
        );
    }

    return {
      success:
        Boolean(
          source?.success ||
          capture.success,
        ),

      output:
        JSON.stringify(
          {
            capability:
              'spatial-scene-understanding',

            implementationEvidence:
              source?.output,

            screenshot:
              screenshot ??
              null,

            visualReview:
              visual ??
              null,
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'spatial-ui-review',

          summary:
            'Combined source-level depth/scene evidence with rendered visual evidence.',
        },
      ],
    };
  }

  private async animation(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const result =
      await this.runScript(
        'scripts/capture-animation-trajectory.mjs',
        {
          url:
            args.url,

          durationMs:
            args.durationMs,

          frames:
            args.frames,
        },
        signal,
      );

    if (!result.success) {
      return result;
    }

    const reportValue =
      markerJson(
        result.output,
        'DACAI_TRAJECTORY_JSON:',
      );

    const report =
      reportValue && typeof reportValue === 'object'
        ? (reportValue as { contactSheetPath?: unknown })
        : undefined;

    const sheet =
      report?.contactSheetPath;

    let visual:
      VisionReviewResult | undefined = undefined;

    if (
      typeof sheet ===
      'string'
    ) {
      visual =
        await this.visionReviews(
          sheet,
          [
            'Review this temporal contact sheet in chronological order.',
            'Assess motion direction, continuity, trajectory, clipping, layout jumps, depth continuity, formation/dissolution behavior and whether the animation visually travels in the intended direction.',
            'Flag apparent teleportation, discontinuities or false 3D effects.',
          ].join('\n'),
          signal,
        );
    }

    return {
      success: true,

      output:
        JSON.stringify(
          {
            capability:
              'animation-trajectory-validation',

            capture:
              reportValue ??
              result.output,

            visualReview:
              visual ??
              null,
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'animation-trajectory',

          summary:
            'Captured timed animation frames and temporal review evidence.',
        },
      ],
    };
  }

  private async video(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const result =
      await this.runScript(
        'scripts/record-local-ui-video.mjs',
        {
          url:
            args.url,

          actions:
            Array.isArray(
              args.actions,
            )
              ? args.actions
              : [],
        },
        signal,
      );

    if (!result.success) {
      return result;
    }

    const reportValue =
      markerJson(
        result.output,
        'DACAI_VIDEO_JSON:',
      );

    const report =
      reportValue && typeof reportValue === 'object'
        ? (reportValue as { videoPath?: unknown; contactSheetPath?: unknown })
        : undefined;

    const vision =
      this.inner
        .listTools()
        .find(
          (t) =>
            t.name ===
            'vision.inspect',
        );

    let review:
      { mode: string; output: string; success: boolean } |
      VisionReviewResult |
      undefined = undefined;

    if (
      vision &&
      typeof report?.videoPath ===
        'string'
    ) {
      const models =
        configuredVisionModels();

      const argsForVideo =
        videoArguments(
          vision,
          report.videoPath,
          [
            'Review this localhost interaction recording.',
            'Assess interaction flow, visual continuity, transitions, delays, layout movement, feedback, affordances and obvious UX failures.',
          ].join('\n'),
          models[0],
        );

      if (argsForVideo) {
        const direct =
          await this.inner.execute(
            {
              name:
                'vision.inspect',

              arguments:
                argsForVideo,
            },
            signal,
          );

        review = {
          mode:
            'direct-video',

          output:
            direct.output,

          success:
            direct.success,
        };
      }
    }

    if (
      !review &&
      typeof report?.contactSheetPath ===
        'string'
    ) {
      review =
        await this.visionReviews(
          report.contactSheetPath,
          [
            'Review these interaction keyframes chronologically.',
            'Assess workflow continuity, transition quality, UI feedback, layout shifts, user orientation and visual defects.',
            'The raw video artifact is preserved separately; this review is based on temporal keyframes.',
          ].join('\n'),
          signal,
        );
    }

    return {
      success: true,

      output:
        JSON.stringify(
          {
            capability:
              'video-interaction-review',

            recording:
              reportValue ??
              result.output,

            review:
              review ??
              null,
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'video-interaction-review',

          summary:
            'Recorded a bounded localhost interaction session and produced multimodal review evidence.',
        },
      ],
    };
  }

  private async contract(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const result =
      await this.runScript(
        'scripts/record-api-contracts.mjs',
        {
          url:
            args.url,

          durationMs:
            args.durationMs,

          actions:
            Array.isArray(
              args.actions,
            )
              ? args.actions
              : [],
        },
        signal,
      );

    if (!result.success) {
      return result;
    }

    const reportValue =
      markerJson(
        result.output,
        'DACAI_CONTRACT_JSON:',
      );

    const report =
      reportValue && typeof reportValue === 'object'
        ? (reportValue as { exchangeCount?: unknown; contractPath?: unknown })
        : undefined;

    return {
      success: true,

      output:
        JSON.stringify(
          {
            capability:
              'network-api-contract-recorder',

            report:
              reportValue ??
              result.output,

            policy:
              'Recorded schemas are behavioral evidence, not permission to call undocumented or external APIs.',
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'api-contract',

          summary:
            `Observed ${report?.exchangeCount ?? 'unknown'} localhost API exchange(s).`,

          detail: {
            contractPath:
              report?.contractPath,
          },
        },
      ],
    };
  }

  private async mock(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const result =
      await this.runScript(
        'scripts/generate-api-mock.mjs',
        {
          contractPath:
            args.contractPath,
        },
        signal,
      );

    if (!result.success) {
      return result;
    }

    const reportValue =
      markerJson(
        result.output,
        'DACAI_MOCK_JSON:',
      );

    const report =
      reportValue && typeof reportValue === 'object'
        ? (reportValue as { mockPath?: unknown })
        : undefined;

    return {
      success: true,

      output:
        JSON.stringify(
          {
            capability:
              'automatic-mock-generation',

            result:
              reportValue ??
              result.output,

            activation:
              'NOT_ACTIVATED',

            warning:
              'Generated mock candidates never count as proof that the real API works.',
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'mock-candidate',

          summary:
            'Generated a deterministic API mock candidate without activating it.',

          detail: {
            mockPath:
              report?.mockPath,

            realApiVerified:
              false,
          },
        },
      ],
    };
  }
}
