/**
 * Personal / general-LLM request handling.
 *
 * DACAIS is the owner's local personal LLM, not only an image/video generator
 * or a repository coding agent. The coding persona's first rule — "inspect
 * this workspace before you answer" — is correct for source changes and wrong
 * for people, businesses, families, property, news, or ordinary questions.
 * When that rule fires on a personal prompt, the model dumps README, AGENTS.md,
 * docs/, and packages/ and never leaves the repo.
 *
 * This module is category-based: it recognizes software-work vocabulary and
 * workspace paths. It does not special-case any person, business, or address.
 */

export const PERSONAL_WEB_TOOLS = ['web.search', 'web.fetch'] as const;

export const PERSONAL_ALLOWED_TOOLS = [
  ...PERSONAL_WEB_TOOLS,
  'download.approved',
] as const;

/**
 * Coding/repository vocabulary. Kept aligned with operational-task's
 * REPOSITORY_WORK_INTENT so a live-system request that is also a code change
 * still stays on the repository path when those verbs appear.
 */
const REPOSITORY_WORK_INTENT =
  /\b(?:implement|edit|fix|refactor|migrate|patch|rewrite|debug|modify|source\s+code|repository|repo|codebase|unit\s+tests?|test\s+suite|typecheck|lint|diagnostics)\b/i;

const THIS_WORKSPACE_INTENT =
  /\b(?:this|the|our)\s+(?:repo(?:sitory)?|codebase|workspace|source tree|project files?)\b/i;

const WORKSPACE_FILE_QUESTION =
  /\b(?:this|the|attached|uploaded)\s+(?:file|folder|directory|path|module|function|class|component)\b/i;

const WORKSPACE_PATH_INTENT =
  /\b(?:apps|packages|tests|docs|src|\.dacai)\/[\w./-]+/i;

const SOURCE_FILE_INTENT =
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|json|yml|yaml|ps1|md)\b/i;

const PRODUCT_CODE_INTENT =
  /\b(?:dacailocalagent|dacais)\b.{0,80}\b(?:code|source|repo|repository|bug|fix|implement|file|function|test|agent-loop|coding agent)\b/i;

const REPOSITORY_INTELLIGENCE_INTENT =
  /\brepository[-\s]*intelligence\b|\bcodebase\s+investigation\b|\binspect\s+(?:the\s+)?(?:repo|repository|workspace|codebase)\b/i;

export const PERSONAL_RESEARCH_INTENT =
  /\b(?:find out|look up|look into|search(?:\s+the\s+web)?|investigate|research|background on|public records?|who is|who was|what is known|obituar(?:y|ies)|court records?|county records?|deed|will|trust|marriage(?:\s+history)?|news about)\b/i;

export function isRepositoryWorkRequest(...texts: Array<string | undefined>): boolean {
  const present = texts.filter((text): text is string => Boolean(text && text.trim()));
  if (!present.length) return false;
  const haystack = present.join('\n');
  return (
    REPOSITORY_WORK_INTENT.test(haystack) ||
    THIS_WORKSPACE_INTENT.test(haystack) ||
    WORKSPACE_FILE_QUESTION.test(haystack) ||
    WORKSPACE_PATH_INTENT.test(haystack) ||
    SOURCE_FILE_INTENT.test(haystack) ||
    PRODUCT_CODE_INTENT.test(haystack) ||
    REPOSITORY_INTELLIGENCE_INTENT.test(haystack)
  );
}

export function isPersonalResearchRequest(...texts: Array<string | undefined>): boolean {
  const present = texts.filter((text): text is string => Boolean(text && text.trim()));
  if (!present.length) return false;
  return PERSONAL_RESEARCH_INTENT.test(present.join('\n'));
}

/**
 * A terse continuation such as "now do it" or "continue" has no new goal of
 * its own. Longer prompts are a new request even if earlier turns were coding.
 */
const SHORT_FOLLOW_UP =
  /^(?:(?:please|ok|okay|yes|yep|sure)\s+)?(?:now\s+)?(?:do it|go ahead|continue|proceed|keep going|same for this|and then(?:\?)?|look (?:him|her|it|them) up)\.?$/i;

export function isShortFollowUp(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? '';
  if (!trimmed || trimmed.length > 80) return false;
  return SHORT_FOLLOW_UP.test(trimmed);
}

export function isRepositoryInspectionTool(name: string): boolean {
  return (
    name.startsWith('filesystem.') ||
    name.startsWith('code.') ||
    name.startsWith('git.') ||
    name.startsWith('quality.') ||
    name.startsWith('github.') ||
    name === 'tests.run' ||
    name === 'shell.run' ||
    name.startsWith('wsl.') ||
    name.startsWith('skills.')
  );
}

export function isPersonalAllowedTool(name: string): boolean {
  return (PERSONAL_ALLOWED_TOOLS as readonly string[]).includes(name);
}

export const PERSONAL_LLM_PROMPT = `You are DACAIS, the owner's local personal LLM.

You are not limited to image/video generation. You are also not a repository coding agent on this run.

This run is a personal, general-knowledge, or public-research task. It is not work on the DacaiLocalAgent codebase.

Rules:
- Do NOT inspect, list, search, or read this workspace to answer the user.
- Do not open README.md, AGENTS.md, docs/, apps/, packages/, tests/, .dacai/, or any project source file.
- This software project is not evidence about people, businesses, families, property, courts, finances, or events outside the code.
- Do not analogize the user's life, family, or finances to this repository's media pipeline, smart contracts, agents, or coding architecture unless they asked about the software.
- When public lookup is in the tool list, use web.search for external facts, then web.fetch on the most relevant public HTTPS pages.
- Ground every factual claim in observed search/fetch text. Quote the source title or URL. Distinguish confirmed public facts from "not found in public sources".
- If a detail is not in the retrieved public pages, say so. Do not invent bank accounts, private debts, private ledgers, unpublished filings, or private contact details.
- Public obituaries, news, business listings, court indexes, and county-record portals may be used when actually retrieved.
- Duplicate web.search queries are wasted turns. Change the query or fetch a specific URL instead.
- Maintain the original user questions until each is answered or public sources are exhausted.
- Emit TASK_COMPLETE: only after answering from tool-backed public evidence, or after clearly stating which questions remain unpublished.
- Emit TASK_BLOCKED: only when web.search/web.fetch are required and unavailable. Never substitute a repository dump for missing web access.

Completion protocol:
- A directory listing, README excerpt, or media-pipeline file is not an answer to a personal question.
- If you catch yourself reading this repository, stop and return to web.search.`;

/** Chat has no tools. Keep the personal persona without inventing a workspace dump. */
export const PERSONAL_CHAT_PROMPT = `You are DACAIS, the owner's local personal LLM.

You are not limited to image/video generation. You are also not a repository coding agent in this chat.

Rules:
- Answer the user's question directly from the conversation.
- This chat has no filesystem, git, tests, or repository-intelligence tools.
- Do not invent, list, or cite files from the DacaiLocalAgent codebase.
- This software project is not evidence about people, businesses, families, property, courts, finances, or events outside the code.
- Do not analogize the user's life, family, or finances to this repository's media pipeline, smart contracts, agents, or coding architecture unless they asked about the software.
- If a current public fact is required, say so honestly. Agent mode with public web access can search; this chat cannot.
- Do not invent private financial, legal, or contact details.`;

/** Skip workspace RAG/skills/memory when the question is not about this codebase. */
export function personalContextOptions(): {
  enableSkills: false;
  enableRag: false;
  enableRepositoryRag: false;
  enableMemory: false;
} {
  return {
    enableSkills: false,
    enableRag: false,
    enableRepositoryRag: false,
    enableMemory: false,
  };
}

export function personalLlmConstraintsInstructions(input: {
  research: boolean;
  availableTools: string[];
}): string {
  const available = new Set(input.availableTools);
  const webTools = PERSONAL_WEB_TOOLS.filter((tool) => available.has(tool));

  const toolLine = webTools.length
    ? `- Use the public-web tools selected for this run: ${webTools.join(', ')}. Fetch the actual page after a promising search hit.`
    : '- No public-web tool is selected for this run. Answer from the conversation only and state that live public lookup is unavailable. Do NOT inspect this repository as a substitute.';

  const researchLine = input.research
    ? '- This is a public-research request. Search first, then fetch primary pages. Do not stop after one snippet list when the user asked several questions.'
    : '- Use web.search only when a current external fact is required. Ordinary conversation does not need a workspace listing.';

  return [
    'PERSONAL / GENERAL LLM DIRECTIVE:',
    '- This is NOT a repository coding task and NOT an image/video generation task.',
    '- Do NOT use filesystem.list, filesystem.search, filesystem.read, filesystem.stat, code.*, git.*, tests.run, or skills.* on this run.',
    '- Do NOT open README.md, AGENTS.md, docs/, apps/, packages/, or .dacai/ for this question.',
    '- This workspace\'s source cannot answer questions about people, businesses, families, farms, deeds, wills, or finances.',
    toolLine,
    researchLine,
    '- Never treat a DuckDuckGo snippet as a completed investigation when web.fetch can open the cited public page.',
    '- If public sources do not contain a fact, say it is not in the retrieved public record. Do not guess private financial or legal details.',
  ].join('\n');
}
