/**
 * Turns an instruction into the approval it already contains.
 *
 * When the operator writes "run the tests and commit the fix", they have
 * authorized running tests and committing. Stopping mid-run to ask whether they
 * meant it does not add a decision — it replays one they already made, and a
 * prompt that carries no new information trains them to approve without
 * reading. That is the failure this exists to prevent.
 *
 * It is deliberately narrow:
 *
 * - A rule fires only on an explicit instruction, never on a passing mention.
 *   "don't commit this" must not authorize committing, so negations are checked
 *   before the verb.
 * - A rule can only grant tools the run actually has. Naming a tool the
 *   workspace never enabled grants nothing.
 * - No rule matching means no grant, and the human gate stands unchanged.
 *
 * The result feeds `ApprovalRegistry.grantRun`, so everything it produces is
 * still run-scoped, still announced in the activity journal, and still dies
 * with the run.
 */

export interface ApprovalTriggerRule {
  /** Short identifier used in the activity journal. */
  id: string;
  /** The instruction that authorizes these tools. */
  match: RegExp;
  /** Tools that instruction covers. */
  tools: string[];
}

/**
 * Phrases that withdraw an instruction rather than give it. Checked first, so
 * "do not push" never authorizes pushing.
 */
const NEGATION = /\b(?:do\s+not|don't|dont|never|without|avoid|skip|no need to|refrain from)\s+(?:\w+\s+){0,3}/i;

export const APPROVAL_TRIGGER_RULES: readonly ApprovalTriggerRule[] = [
  {
    id: 'tests',
    match: /\b(?:run|execute|re-?run)\s+(?:the\s+)?(?:unit\s+|integration\s+|full\s+)?(?:tests?|test\s+suite|specs?)\b|\bnpm\s+test\b|\bpnpm\s+test\b|\bvitest\b|\btypecheck\b|\blint\b/i,
    tools: ['tests.run', 'shell.run'],
  },
  {
    id: 'git-read',
    match: /\b(?:git\s+(?:status|diff|log|show|blame)|check\s+(?:the\s+)?(?:git\s+)?status|what\s+changed)\b/i,
    tools: ['git.run'],
  },
  {
    id: 'git-write',
    match: /\b(?:commit|stage|branch off|create\s+a\s+branch|checkout\s+-b|worktree)\b/i,
    tools: ['git.run', 'shell.run'],
  },
  {
    id: 'edit',
    match: /\b(?:edit|modify|change|update|fix|refactor|implement|rewrite|patch|apply)\b/i,
    tools: ['filesystem.edit', 'filesystem.write', 'shell.run'],
  },
  {
    id: 'search',
    match: /\b(?:find|search|locate|grep|look\s+for|inspect|read|list)\b/i,
    tools: ['filesystem.read', 'filesystem.list', 'filesystem.search', 'filesystem.stat', 'shell.run'],
  },
  {
    id: 'build',
    match: /\b(?:build|compile|bundle|install\s+(?:the\s+)?(?:deps|dependencies|packages)|pnpm\s+install|npm\s+install)\b/i,
    tools: ['tests.run', 'shell.run'],
  },
  {
    id: 'web',
    match: /\b(?:search\s+(?:the\s+)?(?:web|internet|online)|look\s+it\s+up|google|research|find\s+out\s+how)\b/i,
    tools: ['web.search', 'web.fetch'],
  },
];

/**
 * True when the instruction states this rule affirmatively.
 *
 * A negation immediately before the matched verb withdraws it; a negation
 * elsewhere in a long prompt does not, or "don't break anything, run the tests"
 * would stop authorizing the tests it plainly asks for.
 */
function statedAffirmatively(prompt: string, rule: ApprovalTriggerRule): boolean {
  const hit = rule.match.exec(prompt);
  if (!hit) return false;

  const preceding = prompt.slice(Math.max(0, hit.index - 40), hit.index);
  return !new RegExp(`${NEGATION.source}$`, 'i').test(preceding);
}

export interface DerivedGrant {
  tools: string[];
  /** Rule ids that fired, for the activity journal. */
  reasons: string[];
}

/**
 * Tools the prompt itself authorizes, intersected with what the run actually
 * has. Returns undefined when nothing matched, which leaves the normal
 * approval gate in place.
 */
export function derivePromptGrant(
  prompt: string,
  availableTools: readonly string[],
  rules: readonly ApprovalTriggerRule[] = APPROVAL_TRIGGER_RULES,
): DerivedGrant | undefined {
  const text = typeof prompt === 'string' ? prompt : '';
  if (!text.trim()) return undefined;

  const available = new Set(availableTools);
  const tools = new Set<string>();
  const reasons: string[] = [];

  for (const rule of rules) {
    if (!statedAffirmatively(text, rule)) continue;
    const granted = rule.tools.filter((tool) => available.has(tool));
    if (!granted.length) continue;
    reasons.push(rule.id);
    for (const tool of granted) tools.add(tool);
  }

  if (!tools.size) return undefined;
  return { tools: [...tools], reasons };
}
