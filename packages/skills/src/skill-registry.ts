import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SkillDefinition, SkillMatch } from './types';

const CACHE_MS = 15_000;

function tokens(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3),
  )];
}

function parseList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseSkill(path: string, raw: string): SkillDefinition {
  let body = raw.trim();
  const meta: Record<string, string> = {};

  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      const frontmatter = body.slice(3, end).trim();
      body = body.slice(end + 4).trim();
      for (const line of frontmatter.split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (match) meta[match[1].toLowerCase()] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.replace(/^#+\s+/gm, '').trim())
    .find((part) => part && !part.startsWith('```'));

  return {
    name: meta.name || heading || path.split(/[\\/]/).at(-2) || 'unnamed-skill',
    description: meta.description || paragraph?.slice(0, 500) || '',
    tags: meta.tags ? parseList(meta.tags) : [],
    path,
    content: body,
  };
}

export async function findRepositoryRoot(start = process.cwd()): Promise<string> {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) || existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export class SkillRegistry {
  private cache?: { at: number; skills: SkillDefinition[] };

  constructor(private readonly rootPromise: Promise<string> = findRepositoryRoot()) {}

  async list(force = false): Promise<SkillDefinition[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.skills;

    const root = await this.rootPromise;
    const roots = [
      join(root, '.dacai', 'skills'),
      join(root, '.github', 'skills'),
    ];

    const found: SkillDefinition[] = [];
    for (const skillsRoot of roots) {
      if (!existsSync(skillsRoot)) continue;
      const dirs = await readdir(skillsRoot, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const path = join(skillsRoot, dir.name, 'SKILL.md');
        if (!existsSync(path)) continue;
        try {
          found.push(parseSkill(path, await readFile(path, 'utf8')));
        } catch {
          // A malformed optional skill never blocks the agent.
        }
      }
    }

    const deduped = [...new Map(found.map((skill) => [skill.name.toLowerCase(), skill])).values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { at: Date.now(), skills: deduped };
    return deduped;
  }

  async get(name: string): Promise<SkillDefinition | undefined> {
    const normalized = name.trim().toLowerCase();
    return (await this.list()).find((skill) => skill.name.toLowerCase() === normalized);
  }

  async findRelevant(query: string, limit = 3): Promise<SkillMatch[]> {
    const queryTokens = tokens(query);
    if (!queryTokens.length) return [];

    const matches = (await this.list()).map((skill) => {
      const name = tokens(skill.name);
      const description = tokens(skill.description);
      const tags = skill.tags.flatMap(tokens);
      const headings = tokens(
        [...skill.content.matchAll(/^#{1,3}\s+(.+)$/gm)]
          .map((match) => match[1])
          .join(' '),
      );

      let score = 0;
      const matchedTerms: string[] = [];
      for (const term of queryTokens) {
        if (name.includes(term)) score += 8;
        if (tags.includes(term)) score += 7;
        if (description.includes(term)) score += 4;
        if (headings.includes(term)) score += 2;
        if (score > 0 && !matchedTerms.includes(term)) matchedTerms.push(term);
      }

      // Intent shortcuts make generic coding prompts reliably select the core skill.
      if (skill.tags.includes('coding') && /\b(implement|change|fix|refactor|add|edit|code)\b/i.test(query)) score += 5;
      if (skill.tags.includes('debug') && /\b(error|fail|bug|debug|broken|exception)\b/i.test(query)) score += 8;
      if (skill.tags.includes('ci') && /\b(ci|check|workflow|github actions|pipeline)\b/i.test(query)) score += 10;
      if (skill.tags.includes('security') && /\b(security|vulnerability|threat|auth|tenant|injection)\b/i.test(query)) score += 8;
      if (skill.tags.includes('git') && /\b(pr|pull request|commit|branch|worktree)\b/i.test(query)) score += 8;
      if (skill.tags.includes('testing') && /\b(test|property|fuzz|mutation|invariant)\b/i.test(query)) score += 8;

      return { skill, score, matchedTerms };
    });

    return matches
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, Math.max(1, Math.min(limit, 6)));
  }
}
