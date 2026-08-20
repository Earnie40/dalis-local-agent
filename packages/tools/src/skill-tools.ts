import { SkillRegistry } from '@dacai-local-agent/skills';
import type { ToolDefinition } from './types';

const registry = new SkillRegistry();

export const skillsListTool: ToolDefinition = {
  name: 'skills.list',
  description: 'List installed DACAIS coding skills. Skills are workflow guidance, not authorization.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissionTier: 'safe',
  timeoutMs: 10_000,
  async execute() {
    return {
      skills: (await registry.list()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        path: skill.path,
      })),
    };
  },
};

export const skillsReadTool: ToolDefinition = {
  name: 'skills.read',
  description: 'Read one installed coding skill by exact skill name.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
    required: ['name'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  timeoutMs: 10_000,
  async execute(input) {
    const skill = await registry.get(String(input.name ?? ''));
    if (!skill) throw new Error(`Unknown skill "${String(input.name ?? '')}". Use skills.list first.`);
    return skill;
  },
};

export const skillsFindTool: ToolDefinition = {
  name: 'skills.find',
  description: 'Find the most relevant installed coding skills for the current task.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000 },
      limit: { type: 'number', minimum: 1, maximum: 6 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  timeoutMs: 10_000,
  async execute(input) {
    return {
      matches: (await registry.findRelevant(
        String(input.query ?? ''),
        typeof input.limit === 'number' ? input.limit : 3,
      )).map((match) => ({
        score: match.score,
        matchedTerms: match.matchedTerms,
        name: match.skill.name,
        description: match.skill.description,
        tags: match.skill.tags,
        path: match.skill.path,
      })),
    };
  },
};

export const SKILL_TOOLS: ToolDefinition[] = [skillsListTool, skillsReadTool, skillsFindTool];
