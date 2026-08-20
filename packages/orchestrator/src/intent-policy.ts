export type TaskIntent =
  | 'inspect'
  | 'research'
  | 'review'
  | 'implement'
  | 'fix'
  | 'refactor'
  | 'validate'
  | 'release';

const MUTATION_TOOLS = new Set([
  'filesystem.write',
  'filesystem.edit',
  'filesystem.move',
  'filesystem.copy',
  'git.commit',
  'git.push',
  'git.checkout',
  'git.branch.create',
  'github.pr.create',
]);

const RELEASE_PREFIXES = ['git.', 'github.'];

const VALIDATION_TOOLS = new Set([
  'tests.run',
  'code.diagnostics',
]);

export function classifyTaskIntent(text: string): TaskIntent {
  const normalized = text.toLowerCase();

  if (/\b(release|publish|push|pull request|create pr|merge)\b/.test(normalized))
    return 'release';

  if (/\b(test|validate|verify|diagnose|typecheck|build)\b/.test(normalized))
    return 'validate';

  if (/\b(refactor|restructure|reorganize)\b/.test(normalized))
    return 'refactor';

  if (/\b(fix|repair|resolve|correct|patch)\b/.test(normalized))
    return 'fix';

  if (/\b(implement|create|add|build|change|modify|write)\b/.test(normalized))
    return 'implement';

  if (/\b(review|audit|critique)\b/.test(normalized))
    return 'review';

  if (/\b(research|investigate|explore)\b/.test(normalized))
    return 'research';

  return 'inspect';
}

export function toolAllowedForIntent(
  intent: TaskIntent,
  toolName: string,
): boolean {
  if (intent === 'inspect' || intent === 'research' || intent === 'review') {
    return !MUTATION_TOOLS.has(toolName) &&
      !RELEASE_PREFIXES.some((prefix) => toolName.startsWith(prefix));
  }

  if (intent === 'validate') {
    return (
      !MUTATION_TOOLS.has(toolName) ||
      VALIDATION_TOOLS.has(toolName)
    );
  }

  if (intent === 'release') {
    return true;
  }

  return true;
}

export function filterToolsForIntent<T extends { name: string }>(
  intent: TaskIntent,
  tools: T[],
): T[] {
  return tools.filter((tool) => toolAllowedForIntent(intent, tool.name));
}
