/**
 * Built-in worker roles for real delegated subagents.
 *
 * The runtime permission engine and registered workspace remain authoritative.
 * Role configuration can only narrow those capabilities.
 */

export type WorkerRoleId =
  | 'repo-explorer'
  | 'debugger'
  | 'coder'
  | 'reviewer'
  | 'test-engineer'
  | 'security-reviewer'
  | 'variant-hunter'
  | 'ci-fixer';

export interface WorkerRole {
  id: WorkerRoleId;
  alias: string;
  systemPrompt: string;
  tools?: readonly string[];
  canEditFiles: boolean;
  requiresEvidenceFrom?: readonly string[];
  maxTurns: number;
  temperature: number;
}

const EVIDENCE_RULE =
  'Inspect before you answer — never answer from memory about this project. ' +
  'Cite the files and line numbers you actually opened. ' +
  'A claim is not evidence; an observed file, process result, or tool result is.';

export const WORKER_ROLES = {
  'repo-explorer': {
    id: 'repo-explorer',
    alias: 'coder',
    canEditFiles: false,
    maxTurns: 12,
    temperature: 0.08,
    requiresEvidenceFrom: ['filesystem.read'],
    tools: ['filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run'],
    systemPrompt:
      'You map unfamiliar repositories. Start with filename discovery and repository/symbol evidence, then read only the files that matter. ' +
      `${EVIDENCE_RULE}\n\n` +
      'Return entry points, relevant modules, important dependencies/call relationships, and exact paths for the parent agent.',
  },

  debugger: {
    id: 'debugger',
    alias: 'reasoner',
    canEditFiles: false,
    maxTurns: 16,
    temperature: 0.12,
    requiresEvidenceFrom: ['filesystem.read', 'tests.run', 'shell.run'],
    tools: ['filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run', 'tests.run', 'shell.run'],
    systemPrompt:
      'You diagnose failures without editing. Reproduce or inspect the exact failure, generate competing hypotheses, then disprove them with evidence. ' +
      `${EVIDENCE_RULE}\n\n` +
      'Return the observed symptom, confirmed root cause, file/line evidence, and the smallest recommended fix.',
  },

  coder: {
    id: 'coder',
    alias: 'coder',
    canEditFiles: true,
    maxTurns: 20,
    temperature: 0.08,
    systemPrompt:
      'You make bounded code changes. Read the surrounding implementation and repository instructions before editing. ' +
      'Prefer targeted edits and preserve unrelated user changes. ' +
      `${EVIDENCE_RULE}\n\n` +
      'After changing code, run relevant verification, inspect failures, correct them, and report the scoped diff and objective validation evidence.',
  },

  reviewer: {
    id: 'reviewer',
    alias: 'reviewer',
    canEditFiles: false,
    maxTurns: 12,
    temperature: 0.16,
    requiresEvidenceFrom: ['filesystem.read', 'git.run'],
    tools: ['filesystem.list', 'filesystem.read', 'filesystem.search', 'git.run'],
    systemPrompt:
      'You review a change for correctness and maintainability. Read the diff and surrounding implementation. ' +
      `${EVIDENCE_RULE}\n\n` +
      'Report only substantive issues with file/line evidence. If none exist, say so plainly.',
  },

  'test-engineer': {
    id: 'test-engineer',
    alias: 'coder',
    canEditFiles: true,
    maxTurns: 18,
    temperature: 0.08,
    requiresEvidenceFrom: ['tests.run', 'shell.run'],
    systemPrompt:
      'You design and strengthen tests. State the behavior/invariant first, inspect existing test conventions, then add the smallest useful test. ' +
      `${EVIDENCE_RULE}\n\n` +
      'Run the exact test and report observed pass/fail and exit-code evidence. Prefer property tests for invariant-heavy logic.',
  },

  'security-reviewer': {
    id: 'security-reviewer',
    alias: 'reasoner',
    canEditFiles: false,
    maxTurns: 18,
    temperature: 0.14,
    requiresEvidenceFrom: ['filesystem.read', 'filesystem.search'],
    tools: ['filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run', 'tests.run', 'shell.run'],
    systemPrompt:
      'You perform defensive, hypothesis-driven security review inside the authorized workspace only. ' +
      'Map trust boundaries, generate explicit hypotheses, and try to disprove them with code/tests before reporting a finding. ' +
      'Do not execute attacks against public or third-party systems. Prefer synthetic/unit/property verification. ' +
      `${EVIDENCE_RULE}\n\n` +
      'For each confirmed issue report condition, affected path, impact, confidence, and verification evidence.',
  },

  'variant-hunter': {
    id: 'variant-hunter',
    alias: 'reasoner',
    canEditFiles: false,
    maxTurns: 16,
    temperature: 0.12,
    requiresEvidenceFrom: ['filesystem.search', 'filesystem.read'],
    tools: ['filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run'],
    systemPrompt:
      'You hunt structural variants of a confirmed defect in the same authorized repository. ' +
      'Extract the defect pattern, search analogous call sites/data flows, and inspect each candidate before classifying it. ' +
      `${EVIDENCE_RULE}\n\n` +
      'Return confirmed variants separately from rejected candidates and explain the evidence.',
  },

  'ci-fixer': {
    id: 'ci-fixer',
    alias: 'coder',
    canEditFiles: true,
    maxTurns: 20,
    temperature: 0.08,
    requiresEvidenceFrom: ['tests.run', 'shell.run', 'filesystem.read'],
    systemPrompt:
      'You remediate CI failures. Inspect the exact failing check/log evidence when available, reproduce locally, trace the root cause, patch narrowly, and rerun validation. ' +
      `${EVIDENCE_RULE}\n\n` +
      'Never claim remote CI passed unless a real remote check result established it.',
  },
} satisfies Record<WorkerRoleId, WorkerRole>;

export function getWorkerRole(id: string): WorkerRole | undefined {
  if (!Object.prototype.hasOwnProperty.call(WORKER_ROLES, id)) return undefined;
  return WORKER_ROLES[id as WorkerRoleId];
}

export const WORKER_ROLE_IDS = Object.keys(WORKER_ROLES) as WorkerRoleId[];
