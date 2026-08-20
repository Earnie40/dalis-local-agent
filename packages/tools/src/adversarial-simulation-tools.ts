import {
  BoundedAdversarialHarness,
  SYNTHETIC_API_CASES,
  SYNTHETIC_NETWORK,
  SYNTHETIC_PROMPT_ATTACKS,
  SYNTHETIC_TARGET,
  containsPromptInjectionMarkers,
  evaluateSyntheticTenantIsolation,
  isSyntheticDestination,
  isValidSyntheticApiId,
  type SimulationDisposition,
} from '@dacai-local-agent/security';

import type { ToolDefinition } from './types';

type AdversarialCategory =
  | 'api-input'
  | 'prompt-injection'
  | 'database-isolation'
  | 'network-boundary';

interface AdversarialOutcome {
  observed: string;
  disposition: SimulationDisposition;
  confidence: number;
  evidence?: Record<string, unknown>;
}

interface LiveAdversarialRequest {
  category: AdversarialCategory;
  details: Record<string, unknown>;
}

/**
 * Injected live execution boundary.
 *
 * This file never performs direct network/database I/O itself.
 * The live executor must own:
 *
 * - engagement authorization
 * - target scope validation
 * - rate/action limits
 * - concurrency limits
 * - emergency-stop handling
 * - observation provenance
 * - evidence collection
 */
export interface LiveAdversarialExecutor {
  execute(request: LiveAdversarialRequest): Promise<AdversarialOutcome>;
}

export interface AdversarialToolOptions {
  /**
   * Defaults to false.
   *
   * false -> live validation path
   * true  -> synthetic/local harness
   */
  simulation?: boolean;

  /**
   * Required when simulation === false.
   */
  liveExecutor?: LiveAdversarialExecutor;
}

/**
 * Main factory.
 *
 * Live validation is the default:
 *
 *   createAdversarialTools({
 *     simulation: false,
 *     liveExecutor,
 *   })
 *
 * Synthetic mode remains available explicitly:
 *
 *   createAdversarialTools({
 *     simulation: true,
 *   })
 */
export function createAdversarialTools(
  options: AdversarialToolOptions = {
    simulation: false,
  },
): ToolDefinition[] {
  const simulation = options.simulation ?? false;

  if (simulation) {
    return createAdversarialSimulationTools();
  }

  if (!options.liveExecutor) {
    throw new Error(
      'Live adversarial tools are enabled because simulation=false, ' +
        'but no LiveAdversarialExecutor was provided.',
    );
  }

  return createAdversarialLiveTools(options.liveExecutor);
}

/**
 * Agent-facing synthetic tools.
 *
 * They never perform network or database I/O:
 * all targets, payloads, and outcomes are synthetic and evaluated locally.
 */
export function createAdversarialSimulationTools(): ToolDefinition[] {
  const harness = new BoundedAdversarialHarness({
    engagementId: `synthetic-agent-${Date.now()}`,
    operator: 'agent-ui-operator',
    expiresAt: new Date(Date.now() + 30 * 60_000),
    allowedTargets: new Set([SYNTHETIC_TARGET]),
    allowedNetworks: [SYNTHETIC_NETWORK],
    maxActions: 50,
    maxConcurrency: 1,
  });

  const run = async (
    category: AdversarialCategory,
    details: Record<string, unknown>,
    outcome: AdversarialOutcome,
  ) => {
    const evidence = await harness.run(
      {
        testId: `${category}-${Date.now()}`,
        category,
        target: SYNTHETIC_TARGET,
        resolvedIp: '10.20.1.5',
        expected:
          'Synthetic target rejects or contains the adversarial input without leakage.',
        details,
      },
      async () => outcome,
    );

    return {
      ...evidence,
      harnessState: harness.state,
    };
  };

  return [
    {
      name: 'security.simulation.api-input',
      description:
        'Run bounded malformed-input cases against the synthetic API harness. No network I/O.',
      inputSchema: {
        type: 'object',
        properties: {
          caseIndex: {
            type: 'integer',
            minimum: 0,
            maximum: SYNTHETIC_API_CASES.length - 1,
          },
        },
        required: ['caseIndex'],
      },
      permissionTier: 'safe',
      timeoutMs: 10_000,

      async execute(input) {
        const index = Number(input.caseIndex);

        if (
          !Number.isInteger(index) ||
          !SYNTHETIC_API_CASES[index]
        ) {
          throw new Error(
            'Invalid synthetic API case index.',
          );
        }

        const payload =
          SYNTHETIC_API_CASES[index];

        const valid =
          isValidSyntheticApiId(payload);

        return run(
          'api-input',
          {
            caseIndex: index,
            payload,
          },
          {
            observed: valid
              ? 'Synthetic validator accepted the payload as a well-formed id.'
              : 'Synthetic validator rejected the malformed payload; no record was created.',
            disposition: valid
              ? 'allowed-as-designed'
              : 'blocked',
            confidence: 1,
          },
        );
      },
    },

    {
      name:
        'security.simulation.prompt-injection',

      description:
        'Scan a synthetic untrusted prompt-injection fixture for known injection phrasing. ' +
        'It cannot alter system policy or call tools, and this tool never invokes a real model — ' +
        '"blocked" means the fixture was flagged as untrusted data, not that a live LLM resisted it.',

      inputSchema: {
        type: 'object',
        properties: {
          attackIndex: {
            type: 'integer',
            minimum: 0,
            maximum:
              SYNTHETIC_PROMPT_ATTACKS.length -
              1,
          },
        },
        required: ['attackIndex'],
      },

      permissionTier: 'safe',
      timeoutMs: 10_000,

      async execute(input) {
        const index =
          Number(input.attackIndex);

        if (
          !Number.isInteger(index) ||
          !SYNTHETIC_PROMPT_ATTACKS[index]
        ) {
          throw new Error(
            'Invalid synthetic prompt attack index.',
          );
        }

        const content =
          SYNTHETIC_PROMPT_ATTACKS[index];

        const flagged =
          containsPromptInjectionMarkers(
            content,
          );

        return run(
          'prompt-injection',
          {
            attackIndex: index,
            untrustedContent: content,
          },
          {
            observed: flagged
              ? 'Synthetic scan flagged known prompt-injection phrasing; content treated as untrusted data.'
              : 'Synthetic scan found no known prompt-injection phrasing in this content.',
            disposition: flagged
              ? 'blocked'
              : 'missed',
            confidence: flagged
              ? 1
              : 0.5,
          },
        );
      },
    },

    {
      name:
        'security.simulation.tenant-isolation',

      description:
        'Run a synthetic cross-tenant isolation check with no real records or database access.',

      inputSchema: {
        type: 'object',
        properties: {
          sourceTenant: {
            type: 'string',
          },
          targetTenant: {
            type: 'string',
          },
        },
        required: [
          'sourceTenant',
          'targetTenant',
        ],
      },

      permissionTier: 'safe',
      timeoutMs: 10_000,

      async execute(input) {
        if (
          input.sourceTenant ===
          input.targetTenant
        ) {
          throw new Error(
            'Source and target tenants must differ.',
          );
        }

        const sourceTenant =
          String(input.sourceTenant);

        const targetTenant =
          String(input.targetTenant);

        const verdict =
          evaluateSyntheticTenantIsolation(
            sourceTenant,
            targetTenant,
          );

        const outcome: Record<
          typeof verdict,
          AdversarialOutcome
        > = {
          isolated: {
            observed:
              'Synthetic tenant boundary denies the cross-tenant read: normalized identifiers are distinct.',
            disposition: 'blocked',
            confidence: 1,
          },

          'boundary-collision': {
            observed:
              'Tenant identifiers differ literally but normalize to the same tenant; the boundary would not actually separate them.',
            disposition: 'missed',
            confidence: 1,
          },

          unmodeled: {
            observed:
              'One or both tenant ids are outside this fixture\'s known tenant set; isolation cannot be attested.',
            disposition: 'inconclusive',
            confidence: 0.3,
          },
        };

        return run(
          'database-isolation',
          {
            sourceTenant,
            targetTenant,
            operation: 'read',
            verdict,
          },
          outcome[verdict],
        );
      },
    },

    {
      name:
        'security.simulation.network-boundary',

      description:
        'Validate synthetic DNS/IP destinations against the fixed synthetic CIDR; never connects.',

      inputSchema: {
        type: 'object',
        properties: {
          host: {
            type: 'string',
          },
          resolvedIp: {
            type: 'string',
          },
        },
        required: [
          'host',
          'resolvedIp',
        ],
      },

      permissionTier: 'safe',
      timeoutMs: 10_000,

      async execute(input) {
        const host =
          String(input.host);

        const resolvedIp =
          String(input.resolvedIp);

        const allowed =
          isSyntheticDestination(
            host,
            resolvedIp,
          );

        return run(
          'network-boundary',
          {
            host,
            resolvedIp,
            allowed,
          },
          {
            observed: allowed
              ? `Destination ${host} (${resolvedIp}) resolves within the synthetic authorized network.`
              : `Destination ${host} (${resolvedIp}) is outside the synthetic authorized network; connection would be refused.`,
            disposition: allowed
              ? 'allowed-as-designed'
              : 'blocked',
            confidence: 1,
          },
        );
      },
    },
  ];
}

/**
 * Live adversarial tools.
 *
 * These tools do not perform I/O directly.
 * They hand a typed request to the injected live executor.
 *
 * The executor is responsible for enforcing engagement authorization,
 * approved target scope, limits, stop-state, and evidence collection.
 */
function createAdversarialLiveTools(
  executor: LiveAdversarialExecutor,
): ToolDefinition[] {
  const run = async (
    category: AdversarialCategory,
    details: Record<string, unknown>,
  ) => {
    return executor.execute({
      category,
      details,
    });
  };

  return [
    {
      name:
        'security.live.api-input',

      description:
        'Run an authorized bounded API-input validation scenario through the live security executor.',

      inputSchema: {
        type: 'object',
        properties: {
          caseId: {
            type: 'string',
          },
        },
        required: ['caseId'],
      },

      permissionTier: 'high-impact',
      timeoutMs: 30_000,

      async execute(input) {
        const caseId =
          String(input.caseId);

        if (!caseId.trim()) {
          throw new Error(
            'caseId is required.',
          );
        }

        return run(
          'api-input',
          {
            caseId,
          },
        );
      },
    },

    {
      name:
        'security.live.prompt-injection',

      description:
        'Run an authorized prompt-resilience validation fixture through the live security executor.',

      inputSchema: {
        type: 'object',
        properties: {
          fixtureId: {
            type: 'string',
          },
        },
        required: ['fixtureId'],
      },

      permissionTier: 'high-impact',
      timeoutMs: 30_000,

      async execute(input) {
        const fixtureId =
          String(input.fixtureId);

        if (!fixtureId.trim()) {
          throw new Error(
            'fixtureId is required.',
          );
        }

        return run(
          'prompt-injection',
          {
            fixtureId,
          },
        );
      },
    },

    {
      name:
        'security.live.tenant-isolation',

      description:
        'Run an authorized tenant-isolation validation scenario through the live security executor.',

      inputSchema: {
        type: 'object',
        properties: {
          sourceTenant: {
            type: 'string',
          },
          targetTenant: {
            type: 'string',
          },
        },
        required: [
          'sourceTenant',
          'targetTenant',
        ],
      },

      permissionTier: 'high-impact',
      timeoutMs: 30_000,

      async execute(input) {
        const sourceTenant =
          String(input.sourceTenant);

        const targetTenant =
          String(input.targetTenant);

        if (
          !sourceTenant.trim() ||
          !targetTenant.trim()
        ) {
          throw new Error(
            'sourceTenant and targetTenant are required.',
          );
        }

        if (
          sourceTenant ===
          targetTenant
        ) {
          throw new Error(
            'Source and target tenants must differ.',
          );
        }

        return run(
          'database-isolation',
          {
            sourceTenant,
            targetTenant,
            operation: 'read',
          },
        );
      },
    },

    {
      name:
        'security.live.network-boundary',

      description:
        'Run an authorized network-boundary validation scenario through the live security executor.',

      inputSchema: {
        type: 'object',
        properties: {
          destinationId: {
            type: 'string',
          },
        },
        required: [
          'destinationId',
        ],
      },

      permissionTier: 'high-impact',
      timeoutMs: 30_000,

      async execute(input) {
        const destinationId =
          String(input.destinationId);

        if (!destinationId.trim()) {
          throw new Error(
            'destinationId is required.',
          );
        }

        return run(
          'network-boundary',
          {
            destinationId,
          },
        );
      },
    },
  ];
}