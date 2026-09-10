import { describe, expect, it } from 'vitest';
import { selectAgentTools, selectPersonalAgentTools } from '../apps/server/src/agent-tool-selection';
import { fallbackPlan, normalizeExecutionPlan } from '../apps/server/src/coding-agent-graph';
import {
  classifyAgentTaskKind,
  evidenceRequirementFor,
  resolveAgentTaskProfile,
} from '../apps/server/src/operational-task';
import {
  isPersonalAllowedTool,
  isPersonalResearchRequest,
  isRepositoryInspectionTool,
  isRepositoryWorkRequest,
  PERSONAL_CHAT_PROMPT,
  PERSONAL_LLM_PROMPT,
  personalContextOptions,
  personalLlmConstraintsInstructions,
} from '../apps/server/src/personal-llm-task';

const REPO_AND_WEB_TOOLS = [
  'filesystem.list',
  'filesystem.search',
  'filesystem.read',
  'filesystem.stat',
  'code.symbol.search',
  'git.run',
  'tests.run',
  'shell.run',
  'skills.list',
  'web.search',
  'web.fetch',
  'download.approved',
];

describe('personal vs repository request detection', () => {
  it('does not treat public-person research as repository work', () => {
    const prompt =
      'Find out everything possible about a local business owner, finances of the bar, family, and any public deed or will for a farm.';
    expect(isRepositoryWorkRequest(prompt)).toBe(false);
    expect(isPersonalResearchRequest(prompt)).toBe(true);
    expect(classifyAgentTaskKind(prompt)).toBe('personal');
  });

  it('keeps genuine coding requests on the repository path', () => {
    expect(isRepositoryWorkRequest('fix the failing unit test in agent-run-mode.ts')).toBe(true);
    expect(classifyAgentTaskKind('refactor the service layer in the network module')).toBe('repository');
    expect(classifyAgentTaskKind('inspect the repo and update packages/agent-core/src/agent-loop.ts')).toBe('repository');
    expect(classifyAgentTaskKind('continue the DacaiLocalAgent repository-intelligence investigation')).toBe('repository');
  });

  it('keeps live-system requests operational even when they mention research words', () => {
    expect(classifyAgentTaskKind('scan the 192.168.1.0/24 network and ping the gateway')).toBe('operational');
  });

  it('does not let a prior coding turn reclassify a new personal-research question', () => {
    const history = 'fix the failing unit test in agent-run-mode.ts and inspect packages/agent-core/src/agent-loop.ts';
    expect(classifyAgentTaskKind(
      'Find out public information about a local business owner and any public records related to a family farm.',
      history,
    )).toBe('personal');
  });

  it('lets a short follow-up inherit repository work from the previous turn', () => {
    expect(classifyAgentTaskKind('now do it', 'fix the failing unit test in agent-run-mode.ts')).toBe('repository');
    expect(classifyAgentTaskKind('continue', 'inspect the repo and update agent-loop.ts')).toBe('repository');
  });
});

describe('personal run routing gates', () => {
  it('skips repository parallel specialists and the coding wrapper stack', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(process.cwd(), 'apps/server/src/routes/agent.ts'), 'utf8');
    expect(source).toContain("} else if (isParallel && taskProfile.kind !== 'personal') {");
    expect(source).toContain('personalExecutor ??');
    expect(source).toContain('Personal/general-LLM runs must not inherit the coding wrapper stack.');
    expect(source).toContain('Personal/general-LLM runs receive empty curated context and no repository contextProvider.');
  });

  it('skips workspace RAG on personal delegated tasks', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(process.cwd(), 'apps/server/src/routes/tasks.ts'), 'utf8');
    expect(source).toContain('const builtContext = personalTask');
    expect(source).toContain("? { sections: [], truncated: false, reasoning: '', totalTokens: 0 }");
  });
});

describe('personal tool selection and evidence', () => {
  it('still describes the public-web subset a personal answer can cite', () => {
    // This set no longer narrows a run — the agent keeps every tool its
    // workspace allows, because a classifier's guess about intent is not a
    // reason to tell the operator it cannot read a file. The subset survives
    // for describing what a personal answer should be able to cite.
    const enabled = REPO_AND_WEB_TOOLS.map((name) => ({ name }));
    const subset = selectPersonalAgentTools(selectAgentTools(enabled));

    expect(subset.map((tool) => tool.name)).toEqual(['web.search', 'web.fetch', 'download.approved']);
    expect(subset.some((tool) => isRepositoryInspectionTool(tool.name))).toBe(false);
    expect(subset.every((tool) => isPersonalAllowedTool(tool.name))).toBe(true);
  });

  it('requires public-web evidence instead of filesystem.list', () => {
    const profile = resolveAgentTaskProfile({
      prompt: 'Look up public records and news about the business and family situation.',
      availableTools: REPO_AND_WEB_TOOLS,
    });
    expect(profile.kind).toBe('personal');
    expect(profile.evidenceRequirement?.tools).toEqual(['web.search', 'web.fetch']);
    expect(profile.directive).toContain('PERSONAL / GENERAL LLM DIRECTIVE');
    expect(profile.directive).toContain('Do NOT use filesystem.list');
    expect(profile.directive).not.toContain('OPERATIONAL EXECUTION DIRECTIVE');
  });

  it('does not fall back to repository evidence when web tools are missing', () => {
    expect(
      evidenceRequirementFor({ kind: 'personal', availableTools: ['filesystem.list', 'filesystem.read'] }),
    ).toBeUndefined();
    expect(
      personalLlmConstraintsInstructions({
        research: true,
        availableTools: ['filesystem.list'],
      }),
    ).toContain('Do NOT inspect this repository as a substitute');
  });
});

describe('personal planning and persona', () => {
  it('does not begin a personal plan with repository inspection', () => {
    const plan = fallbackPlan('research public facts about a person and a business', 'personal');
    expect(plan.split('\n')[0]).toMatch(/do not inspect this repository/i);
    expect(plan).not.toMatch(/inspect repository instructions|validate mutations/);
  });

  it('falls back to the personal checklist when a planner drafts a repo dump', () => {
    const plan = normalizeExecutionPlan(
      'Final Summary: README.md and media_service.py confirm the farm governance.',
      'Find public information about the family farm and the bar.',
      'personal',
    );
    expect(plan.split('\n')[0]).toMatch(/do not inspect this repository/i);
    expect(plan).not.toContain('README.md');
  });

  it('tells the model it is a personal LLM, not a coding agent', () => {
    expect(PERSONAL_LLM_PROMPT).toMatch(/local personal LLM/i);
    expect(PERSONAL_LLM_PROMPT).toMatch(/Do NOT inspect, list, search, or read this workspace/i);
    expect(PERSONAL_LLM_PROMPT).not.toMatch(/Inspect before you answer\. Never answer from memory about this project\./);
    expect(PERSONAL_CHAT_PROMPT).toMatch(/this chat cannot/i);
    expect(personalContextOptions()).toEqual({
      enableSkills: false,
      enableRag: false,
      enableRepositoryRag: false,
      enableMemory: false,
    });
  });
});
