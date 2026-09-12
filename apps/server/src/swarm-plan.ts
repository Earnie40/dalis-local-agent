import type { SwarmRecord } from '@dacai-local-agent/orchestrator';
import type { WorkerRoleId } from '@dacai-local-agent/agents';

export type SwarmStrategy =
  | 'balanced'
  | 'research'
  | 'review'
  | 'security'
  | 'offensive-security'
  | 'defensive-security'
  | 'custom';

export interface SwarmMemberPlan {
  role: WorkerRoleId;
  objective: string;
}

const STRATEGY_LENSES: Record<Exclude<SwarmStrategy, 'custom'>, Array<{
  role: WorkerRoleId;
  assignment: string;
}>> = {
  balanced: [
    { role: 'repo-explorer', assignment: 'Map the relevant architecture, dependencies, and existing implementation evidence.' },
    { role: 'debugger', assignment: 'Independently identify failure modes, uncertain assumptions, and likely root causes.' },
    { role: 'reviewer', assignment: 'Evaluate correctness, maintainability, and competing solution tradeoffs.' },
    { role: 'security-reviewer', assignment: 'Inspect trust boundaries, permission effects, and concrete security risks.' },
    { role: 'variant-hunter', assignment: 'Search for analogous patterns and variants that could change the conclusion.' },
    { role: 'test-engineer', assignment: 'Design validation evidence and identify coverage gaps. Do not modify files.' },
  ],
  research: [
    { role: 'repo-explorer', assignment: 'Collect primary repository evidence and map the relevant components.' },
    { role: 'debugger', assignment: 'Check the leading explanation against the observed evidence.' },
    { role: 'variant-hunter', assignment: 'Search broadly for related implementations, edge cases, and structural variants.' },
    { role: 'reviewer', assignment: 'Compare the evidence and identify unsupported claims or missing context.' },
    { role: 'security-reviewer', assignment: 'Analyze security and privacy implications supported by concrete evidence.' },
    { role: 'test-engineer', assignment: 'Specify reproducible checks that would confirm or falsify the findings. Do not modify files.' },
  ],
  review: [
    { role: 'reviewer', assignment: 'Perform an independent correctness and maintainability review.' },
    { role: 'test-engineer', assignment: 'Assess validation quality and missing test scenarios. Do not modify files.' },
    { role: 'security-reviewer', assignment: 'Review permission, trust-boundary, and abuse-case implications.' },
    { role: 'debugger', assignment: 'Look for latent failure paths and disprove the strongest assumptions.' },
    { role: 'variant-hunter', assignment: 'Find structurally similar sites that the review must account for.' },
    { role: 'repo-explorer', assignment: 'Confirm architecture and call-path claims against repository evidence.' },
  ],
  security: [
    { role: 'security-reviewer', assignment: 'Map trust boundaries and inspect concrete security risks.' },
    { role: 'variant-hunter', assignment: 'Search for variants of every confirmed or suspected weakness.' },
    { role: 'debugger', assignment: 'Trace exploitable failure conditions and challenge false positives.' },
    { role: 'reviewer', assignment: 'Independently review severity, reachability, and remediation tradeoffs.' },
    { role: 'test-engineer', assignment: 'Design reproducible security regression checks. Do not modify files.' },
    { role: 'repo-explorer', assignment: 'Map entry points, data flows, and affected components from source evidence.' },
  ],
  'offensive-security': [
    { role: 'security-reviewer', assignment: 'Map the protected system trust boundaries and identify concrete paths to obtain the authorized level of access.' },
    { role: 'repo-explorer', assignment: 'Enumerate exposed interfaces, authentication flows, authorization checks, and reachable assets.' },
    { role: 'debugger', assignment: 'Inspect access paths using available evidence and report reproducible failure conditions.' },
    { role: 'variant-hunter', assignment: 'Search for alternate access paths and structural variants of every confirmed weakness.' },
    { role: 'reviewer', assignment: 'Independently assess reachability, impact, false positives, and operational tradeoffs.' },
    { role: 'test-engineer', assignment: 'Design reproducible proof and regression checks for the authorized access assessment. Do not modify files.' },
  ],
  'defensive-security': [
    { role: 'security-reviewer', assignment: 'Map protected assets, trust boundaries, abuse cases, and the highest-priority defensive controls.' },
    { role: 'debugger', assignment: 'Investigate access failures, suspicious behavior, and concrete root-cause evidence.' },
    { role: 'repo-explorer', assignment: 'Inventory authentication, authorization, logging, containment, and recovery mechanisms.' },
    { role: 'variant-hunter', assignment: 'Search for repeated control gaps and alternate paths around existing defenses.' },
    { role: 'reviewer', assignment: 'Prioritize containment and hardening changes while checking for operational regressions.' },
    { role: 'test-engineer', assignment: 'Design defensive verification and regression coverage. Do not modify files.' },
  ],
};

export class SwarmPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwarmPlanError';
  }
}

export function planSwarmMembers(
  objective: string,
  strategy: Exclude<SwarmStrategy, 'custom'> = 'balanced',
  size = 3,
): SwarmMemberPlan[] {
  const parent = objective.trim();
  if (!parent) throw new SwarmPlanError('objective is required.');
  if (!Number.isInteger(size) || size < 2 || size > 6) {
    throw new SwarmPlanError('size must be an integer from 2 through 6.');
  }
  const lenses = STRATEGY_LENSES[strategy];
  if (!lenses) throw new SwarmPlanError(`Unknown swarm strategy "${strategy}".`);
  return lenses.slice(0, size).map(({ role, assignment }, index) => ({
    role,
    objective:
      `Parent objective: ${parent}\n\n` +
      `Swarm assignment ${index + 1}/${size}: ${assignment}\n\n` +
      'Work only on this assignment. Return concise findings, evidence, uncertainty, and any blocker for the coordinator.',
  }));
}

export function createSwarmSynthesisObjective(swarm: SwarmRecord): string {
  const packets = swarm.members.map((member) => {
    const result = (member.result ?? '(no result)').slice(0, 4_000);
    const errors = member.errors.length ? JSON.stringify(member.errors).slice(0, 1_000) : 'none';
    return [
      `Capability lane ${member.ordinal + 1}: ${member.role}`,
      `Status: ${member.status}`,
      `Assignment: ${member.objective.slice(0, 1_500)}`,
      `Result: ${result}`,
      `Errors: ${errors}`,
    ].join('\n');
  });

  return [
    `Coordinate the final answer for AI swarm ${swarm.id}.`,
    `Parent objective: ${swarm.objective}`,
    '',
    'Synthesize the worker packets below. Reconcile disagreements, preserve genuine blockers and uncertainty, and distinguish observed evidence from proposals. Do not claim work or validation that no worker actually completed.',
    '',
    ...packets,
  ].join('\n\n');
}
