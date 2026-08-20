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

interface ResourcePolicyOptions {
  threadId: string;
  objective: string;
}

type ResourceProfile =
  | 'constrained'
  | 'balanced'
  | 'parallel';

type ReasoningDepth =
  | 'fast'
  | 'standard'
  | 'deep';

type FanoutMode =
  | 'serial_preferred'
  | 'queued_evidence'
  | 'parallel';

interface ResourceUsage {
  delegations: number;
  fanouts: number;
  delegatedTasks: number;
  visionCalls: number;
  browserCaptures: number;
  browserInteractions: number;
}

interface ResourcePlan {
  kind:
    'resource_execution_policy';

  profile:
    ResourceProfile;

  limits: {
    maxLocalWorkers: number;
    maxConcurrentModelRequests: number;
  };

  riskDepth:
    ReasoningDepth;

  recommendedReasoning:
    ReasoningDepth;

  fanout: {
    mode:
      FanoutMode;

    maxTasks: number;

    reason: string;
  };

  requirements: {
    deepConsensusRequired:
      boolean;

    securityReviewRequired:
      boolean;

    visualRequired:
      boolean;

    interactionRequired:
      boolean;
  };

  softBudgets: {
    delegations: number;
    visionCalls: number;
    browserCalls: number;
  };

  usage:
    ResourceUsage;

  generatedAt:
    string;
}

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties:
    false,
};

function integerEnvironment(
  name: string,
  fallback: number,
): number {
  const parsed =
    Number.parseInt(
      process.env[name] ??
        '',
      10,
    );

  return Number.isFinite(
    parsed,
  ) &&
    parsed > 0
    ? parsed
    : fallback;
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

function defaultUsage():
  ResourceUsage {
  return {
    delegations: 0,
    fanouts: 0,
    delegatedTasks: 0,
    visionCalls: 0,
    browserCaptures: 0,
    browserInteractions: 0,
  };
}

function profileFor(
  workers: number,
  modelRequests: number,
): ResourceProfile {
  const explicit =
    process.env
      .DACAI_RESOURCE_PROFILE
      ?.trim()
      .toLowerCase();

  if (
    explicit ===
      'constrained' ||
    explicit ===
      'balanced' ||
    explicit ===
      'parallel'
  ) {
    return explicit;
  }

  if (
    workers <= 1 &&
    modelRequests <= 1
  ) {
    return 'constrained';
  }

  if (
    workers >= 3 &&
    modelRequests >= 2
  ) {
    return 'parallel';
  }

  return 'balanced';
}

function riskDepthFor(
  validation:
    Record<string, unknown>,
): ReasoningDepth {
  const changeRisk =
    validation.changeRisk &&
    typeof validation.changeRisk === 'object'
      ? (validation.changeRisk as { depth?: unknown })
      : undefined;

  const candidate =
    changeRisk
      ?.depth ??
    validation
      .validationDepth ??
    validation
      .recommendedReasoningMode;

  return (
    candidate ===
      'deep' ||
    candidate ===
      'standard' ||
    candidate ===
      'fast'
  )
    ? candidate
    : 'standard';
}

function gatePending(
  validation:
    Record<string, unknown>,

  id: string,
): boolean {
  const diffValidationPlan =
    validation.diffValidationPlan &&
    typeof validation.diffValidationPlan === 'object'
      ? (validation.diffValidationPlan as { gates?: unknown })
      : undefined;

  const gates =
    diffValidationPlan?.gates;

  if (
    !Array.isArray(gates)
  ) {
    return false;
  }

  const gate = gates.find(
    (candidate: unknown) =>
      candidate &&
      typeof candidate === 'object' &&
      (candidate as { id?: unknown }).id === id,
  ) as { status?: unknown } | undefined;

  return Boolean(
    gate &&
    gate.status !==
      'passed',
  );
}

function objectiveNeedsUi(
  objective: string,
): boolean {
  return /\b(ui|ux|visual|layout|react|css|component|page|screen|menu|modal|form|browser|responsive|animation|3d|spatial)\b/i
    .test(
      objective,
    );
}

function makePlan(
  validation:
    Record<string, unknown>,

  objective: string,

  priorUsage?:
    ResourceUsage,
): ResourcePlan {
  const maxLocalWorkers =
    integerEnvironment(
      'MAX_LOCAL_WORKERS',
      1,
    );

  const maxConcurrentModelRequests =
    integerEnvironment(
      'MAX_CONCURRENT_MODEL_REQUESTS',
      1,
    );

  const profile =
    profileFor(
      maxLocalWorkers,
      maxConcurrentModelRequests,
    );

  const riskDepth =
    riskDepthFor(
      validation,
    );

  const securityReviewRequired =
    gatePending(
      validation,
      'security-review',
    );

  const uiVisual =
    validation.uiVisual &&
    typeof validation.uiVisual === 'object'
      ? (validation.uiVisual as { required?: unknown })
      : undefined;

  const visualRequired =
    Boolean(
      uiVisual
        ?.required,
    ) ||
    gatePending(
      validation,
      'ui-visual',
    );

  const interactionRequired =
    gatePending(
      validation,
      'ui-interaction',
    );

  const deepConsensusRequired =
    riskDepth === 'deep';

  let fanoutMode:
    FanoutMode;

  let fanoutMaxTasks:
    number;

  let fanoutReason:
    string;

  if (
    maxLocalWorkers <= 1
  ) {
    if (
      deepConsensusRequired ||
      securityReviewRequired
    ) {
      fanoutMode =
        'queued_evidence';

      fanoutMaxTasks = 3;

      fanoutReason =
        'Only one worker can infer at a time, but multiple independent specialist opinions may still be required as queued evidence.';
    } else {
      fanoutMode =
        'serial_preferred';

      fanoutMaxTasks = 0;

      fanoutReason =
        'With one local worker, fan-out provides no inference parallelism and adds unnecessary delegated-model overhead.';
    }
  } else {
    fanoutMode =
      'parallel';

    fanoutMaxTasks =
      Math.max(
        2,

        Math.min(
          6,
          maxLocalWorkers,
          maxConcurrentModelRequests,
        ),
      );

    fanoutReason =
      `Runtime permits up to ${fanoutMaxTasks} useful concurrent specialist task(s).`;
  }

  const softBudgets =
    riskDepth === 'deep'
      ? {
          delegations: 8,
          visionCalls: 6,
          browserCalls: 10,
        }
      : riskDepth ===
          'standard'
        ? {
            delegations: 4,
            visionCalls: 4,
            browserCalls: 7,
          }
        : {
            delegations: 2,
            visionCalls: 2,
            browserCalls: 4,
          };

  return {
    kind:
      'resource_execution_policy',

    profile,

    limits: {
      maxLocalWorkers,

      maxConcurrentModelRequests,
    },

    riskDepth,

    /*
     * Required risk depth is never lowered merely because
     * compute is constrained.
     */
    recommendedReasoning:
      riskDepth,

    fanout: {
      mode:
        fanoutMode,

      maxTasks:
        fanoutMaxTasks,

      reason:
        fanoutReason,
    },

    requirements: {
      deepConsensusRequired,

      securityReviewRequired,

      visualRequired,

      interactionRequired,
    },

    softBudgets,

    usage:
      priorUsage ??
      defaultUsage(),

    generatedAt:
      new Date()
        .toISOString(),
  };
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
      EMPTY_SCHEMA;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters =
      EMPTY_SCHEMA;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema =
      EMPTY_SCHEMA;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      EMPTY_SCHEMA;
  }

  // Invariant enforced above: result.inputSchema is always populated by one
  // of the branches (either copied from base or defaulted to EMPTY_SCHEMA).
  return result as unknown as ToolSchema;
}

async function loadPlan(
  options:
    ResourcePolicyOptions,
): Promise<{
  state: unknown;
  validation:
    Record<string, unknown>;
  plan: ResourcePlan;
}> {
  const state =
    await loadWorkingState(
      options.threadId,
    );

  if (!state) {
    throw new Error(
      `Working state "${options.threadId}" is unavailable.`,
    );
  }

  const validation =
    validationState(
      state,
    );

  const prior =
    validation.resourceExecutionPolicy &&
    typeof validation.resourceExecutionPolicy === 'object'
      ? (validation.resourceExecutionPolicy as { usage?: ResourceUsage })
      : undefined;

  const plan =
    makePlan(
      validation,

      options.objective,

      prior?.usage,
    );

  return {
    state,
    validation,
    plan,
  };
}

async function persistPlan(
  options:
    ResourcePolicyOptions,

  state: unknown,

  validation:
    Record<string, unknown>,

  plan:
    ResourcePlan,
): Promise<void> {
  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};

  await saveWorkingState({
    ...stateRecord,

    threadId:
      options.threadId,

    validationState: {
      ...validation,

      resourceExecutionPolicy:
        plan,

      /*
       * Keep existing reasoning infrastructure informed without
       * introducing another model-routing implementation.
       */
      recommendedReasoningMode:
        plan.recommendedReasoning,

      resourceProfile:
        plan.profile,
    },
  } as AgentWorkingState);
}

function fanoutTasks(
  call:
    NormalizedToolCall,
): unknown[] {
  const args =
    call.arguments as
      Record<
        string,
        unknown
      > |
      undefined;

  return Array.isArray(
    args?.tasks,
  )
    ? args!.tasks
    : [];
}

function delegatedAgent(
  call:
    NormalizedToolCall,
): string {
  const args =
    call.arguments as
      Record<
        string,
        unknown
      > |
      undefined;

  return typeof args
    ?.agentId ===
    'string'
    ? args.agentId
    : 'auto';
}

function requiredSpecialist(
  plan:
    ResourcePlan,

  agentId: string,
): boolean {
  if (
    plan.requirements
      .securityReviewRequired &&
    agentId ===
      'security-reviewer'
  ) {
    return true;
  }

  if (
    plan.requirements
      .deepConsensusRequired &&
    [
      'reviewer',
      'security-reviewer',
      'test-engineer',
      'debugger',
    ].includes(
      agentId,
    )
  ) {
    return true;
  }

  return false;
}

function explicitlyUiRelated(
  options:
    ResourcePolicyOptions,

  plan:
    ResourcePlan,
): boolean {
  return (
    plan.requirements
      .visualRequired ||
    plan.requirements
      .interactionRequired ||
    objectiveNeedsUi(
      options.objective,
    )
  );
}

function updateUsage(
  plan:
    ResourcePlan,

  call:
    NormalizedToolCall,
): void {
  if (
    call.name ===
    'agent.delegate'
  ) {
    plan.usage
      .delegations += 1;

    plan.usage
      .delegatedTasks += 1;
  }

  if (
    call.name ===
    'agent.delegate.fanout'
  ) {
    plan.usage
      .fanouts += 1;

    plan.usage
      .delegatedTasks +=
        fanoutTasks(
          call,
        ).length;
  }

  if (
    call.name ===
    'vision.inspect'
  ) {
    plan.usage
      .visionCalls += 1;
  }

  if (
    call.name ===
    'browser.capture'
  ) {
    plan.usage
      .browserCaptures += 1;
  }

  if (
    call.name ===
    'browser.interact'
  ) {
    plan.usage
      .browserInteractions += 1;
  }
}

export class ResourceAwareExecutionExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      ResourcePolicyOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const base =
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
          'code.resource.plan',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.resource.plan',

          'Recalculate and persist the current resource-aware execution policy from runtime worker/model limits, change risk, required validation evidence and current usage.',
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'code.resource.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.resource.status',

          'Read the current execution profile, worker/model concurrency limits, reasoning depth, fan-out policy and resource usage.',
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
    let state: unknown;

    let validation:
      Record<string, unknown>;

    let plan:
      ResourcePlan;

    try {
      ({
        state,
        validation,
        plan,
      } =
        await loadPlan(
          this.options,
        ));
    } catch (error) {
      /*
       * Resource optimization must never become a new reason
       * required engineering work cannot execute.
       */
      if (
        call.name ===
          'code.resource.plan' ||
        call.name ===
          'code.resource.status'
      ) {
        return {
          success: false,

          error:
            'resource-policy-unavailable',

          output:
            error instanceof Error
              ? error.message
              : String(error),
        };
      }

      return this.inner.execute(
        call,
        signal,
      );
    }

    if (
      call.name ===
        'code.resource.plan' ||
      call.name ===
        'code.resource.status'
    ) {
      await persistPlan(
        this.options,
        state,
        validation,
        plan,
      );

      return {
        success: true,

        output:
          JSON.stringify(
            plan,
            null,
            2,
          ),

        evidence: [
          {
            kind:
              'resource-execution-policy',

            summary:
              `${plan.profile} profile; ${plan.riskDepth} reasoning; fan-out ${plan.fanout.mode}.`,

            detail: {
              profile:
                plan.profile,

              maxLocalWorkers:
                plan.limits
                  .maxLocalWorkers,

              maxConcurrentModelRequests:
                plan.limits
                  .maxConcurrentModelRequests,

              riskDepth:
                plan.riskDepth,

              fanoutMode:
                plan.fanout
                  .mode,
            },
          },
        ],
      };
    }

    /*
     * FAN-OUT
     *
     * With one worker and no evidence requirement for multiple
     * specialists, fan-out is wasted model overhead. Tell the
     * parent to continue directly or delegate sequentially.
     */
    if (
      call.name ===
      'agent.delegate.fanout'
    ) {
      const tasks =
        fanoutTasks(
          call,
        );

      if (
        plan.fanout.mode ===
        'serial_preferred'
      ) {
        return {
          success: false,

          error:
            'resource-policy-serialize',

          output: [
            'RESOURCE_POLICY_SERIALIZE',
            '',
            `MAX_LOCAL_WORKERS=${plan.limits.maxLocalWorkers}`,
            `MAX_CONCURRENT_MODEL_REQUESTS=${plan.limits.maxConcurrentModelRequests}`,
            '',
            'Fan-out would not provide inference parallelism for this change.',
            'Continue in the parent agent or use one bounded agent.delegate at a time when specialist evidence is actually useful.',
            '',
            'This is resource scheduling, not a permission denial and not evidence of task failure.',
          ].join(
            '\n',
          ),
        };
      }

      if (
        tasks.length >
        plan.fanout.maxTasks
      ) {
        return {
          success: false,

          error:
            'resource-policy-fanout-too-wide',

          output: [
            'RESOURCE_POLICY_FANOUT_TOO_WIDE',
            '',
            `requested: ${tasks.length}`,
            `current useful maximum: ${plan.fanout.maxTasks}`,
            `mode: ${plan.fanout.mode}`,
            '',
            'Reduce the fan-out to the smallest independent specialist set required by the evidence plan.',
          ].join(
            '\n',
          ),
        };
      }
    }

    /*
     * SOFT DELEGATION BUDGET
     *
     * Required specialist evidence is exempt. Fast/low-risk
     * tasks should not turn into chains of generic subagents.
     */
    if (
      call.name ===
      'agent.delegate'
    ) {
      const agentId =
        delegatedAgent(
          call,
        );

      const required =
        requiredSpecialist(
          plan,
          agentId,
        );

      if (
        !required &&
        plan.riskDepth ===
          'fast' &&
        plan.usage
          .delegations >=
          plan.softBudgets
            .delegations
      ) {
        return {
          success: false,

          error:
            'resource-policy-delegation-budget',

          output: [
            'RESOURCE_POLICY_PARENT_EXECUTION_PREFERRED',
            '',
            `Fast-risk delegation budget (${plan.softBudgets.delegations}) is already consumed.`,
            'No required specialist evidence justifies another delegated model call.',
            '',
            'Continue the task in the parent agent using repository tools.',
            'Required evidence gates remain mandatory.',
          ].join(
            '\n',
          ),
        };
      }
    }

    /*
     * VISION / BROWSER
     *
     * Required visual evidence can NEVER be blocked by a soft
     * compute budget.
     */
    if (
      call.name ===
        'vision.inspect'
    ) {
      const required =
        explicitlyUiRelated(
          this.options,
          plan,
        );

      if (
        !required &&
        plan.usage
          .visionCalls >=
          plan.softBudgets
            .visionCalls
      ) {
        return {
          success: false,

          error:
            'resource-policy-vision-budget',

          output: [
            'RESOURCE_POLICY_VISION_DEFERRED',
            '',
            'No current UI/visual evidence requirement justifies another vision-model request.',
            'Use direct source/runtime evidence unless the objective or validation plan actually requires rendered visual inspection.',
          ].join(
            '\n',
          ),
        };
      }
    }

    if (
      call.name ===
        'browser.capture' ||
      call.name ===
        'browser.interact'
    ) {
      const browserCalls =
        plan.usage
          .browserCaptures +
        plan.usage
          .browserInteractions;

      const required =
        explicitlyUiRelated(
          this.options,
          plan,
        );

      if (
        !required &&
        browserCalls >=
          plan.softBudgets
            .browserCalls
      ) {
        return {
          success: false,

          error:
            'resource-policy-browser-budget',

          output: [
            'RESOURCE_POLICY_BROWSER_DEFERRED',
            '',
            'No current UI/runtime evidence gate requires additional browser execution.',
            'Avoid repeated browser work unrelated to the current acceptance/validation requirements.',
          ].join(
            '\n',
          ),
        };
      }
    }

    const result =
      await this.inner.execute(
        call,
        signal,
      );

    /*
     * Count expensive work only after it actually executes
     * successfully.
     */
    if (
      result.success
    ) {
      updateUsage(
        plan,
        call,
      );
    }

    /*
     * Recalculate after operations that may materially change
     * the risk/evidence plan.
     */
    if (
      [
        'code.risk.assess',
        'code.validation.plan',
        'code.validation.plan.status',
        'code.completion.manifest',
        'code.completion.status',
        'ui.visual.record',
      ].includes(
        call.name,
      )
    ) {
      const currentState =
        await loadWorkingState(
          this.options.threadId,
        );

      if (currentState) {
        const currentValidation =
          validationState(
            currentState,
          );

        plan =
          makePlan(
            currentValidation,

            this.options
              .objective,

            plan.usage,
          );

        state =
          currentState;

        validation =
          currentValidation;
      }
    }

    await persistPlan(
      this.options,
      state,
      validation,
      plan,
    );

    /*
     * Add compact scheduling provenance only for expensive
     * orchestration/model/browser operations.
     */
    if (
      [
        'agent.delegate',
        'agent.delegate.fanout',
        'vision.inspect',
        'browser.capture',
        'browser.interact',
      ].includes(
        call.name,
      )
    ) {
      return {
        ...result,

        output: [
          result.output ??
            '',
          '',
          'RESOURCE_POLICY_OBSERVED',
          `profile: ${plan.profile}`,
          `risk depth: ${plan.riskDepth}`,
          `fanout mode: ${plan.fanout.mode}`,
          `delegations: ${plan.usage.delegations}/${plan.softBudgets.delegations} soft budget`,
          `vision: ${plan.usage.visionCalls}/${plan.softBudgets.visionCalls} soft budget`,
          `browser: ${plan.usage.browserCaptures + plan.usage.browserInteractions}/${plan.softBudgets.browserCalls} soft budget`,
        ].join(
          '\n',
        ),
      };
    }

    return result;
  }
}
