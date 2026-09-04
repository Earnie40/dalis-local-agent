/**
 * Operational (system/network) request handling.
 *
 * The agent's base persona is a repository coding agent whose first rule is
 * "inspect before you answer" — which, for a live system or network task,
 * wrongly sends it hunting through project source for hosts, SSIDs, or command
 * names that only exist on the running machine. It also loses execution-context
 * constraints ("use wsl") and, when a command is missing on the Windows PATH,
 * concludes the command is unavailable instead of trying the runtime the user
 * actually asked for.
 *
 * This module is deliberately category-based, not example-based: it recognizes
 * general system/network vocabulary and named runtimes. It contains no branch
 * for any specific host, SSID, tool, or application — those would be brittle
 * and would not generalize to the next operational request.
 */

export type ExecutionEnvironment = 'wsl' | 'powershell' | 'bash' | 'cmd';

/** Named runtimes, most specific first. A bare mention in an instruction to the
 *  agent is treated as "run it there". */
const ENVIRONMENT_PATTERNS: ReadonlyArray<readonly [ExecutionEnvironment, RegExp]> = [
  ['wsl', /\b(?:wsl|windows subsystem for linux)\b/i],
  ['powershell', /\bpower\s?shell\b/i],
  ['cmd', /\b(?:command prompt|cmd\.exe)\b/i],
  ['bash', /\bbash\b/i],
];

/**
 * The runtime the user explicitly asked commands to run in, scanned across the
 * current prompt and any earlier turns passed in. Scanning history is what lets
 * a constraint like "use wsl" survive into the turn that finally runs a command.
 */
export function detectExecutionEnvironment(
  ...texts: Array<string | undefined>
): ExecutionEnvironment | undefined {
  const haystack = texts.filter((text): text is string => Boolean(text)).join('\n');
  if (!haystack) return undefined;
  for (const [environment, pattern] of ENVIRONMENT_PATTERNS) {
    if (pattern.test(haystack)) return environment;
  }
  return undefined;
}

// A literal IPv4 address or CIDR block is a strong, fully general signal that a
// request is about the live network rather than this repository.
const IPV4_OR_CIDR = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/;

const OPERATIONAL_INTENT = new RegExp(
  [
    // network discovery / administration
    'port\\s*scan',
    '(?:scan|scanning)\\s+(?:the\\s+)?(?:network|subnet|lan|wi-?fi)',
    'network\\s+scan',
    '\\bsubnet\\b',
    '\\bcidr\\b',
    '\\bwlan\\b',
    '\\bssid\\b',
    '\\bwi-?fi\\s+network\\b',
    '\\bping\\b',
    '\\btraceroute\\b',
    '\\btracert\\b',
    '\\bipconfig\\b',
    '\\bifconfig\\b',
    '\\bnetstat\\b',
    '\\bnslookup\\b',
    // remote access / control of another machine
    'remote\\s+desktop',
    '\\brdp\\b',
    '\\bwinrm\\b',
    '\\bssh\\b',
    '\\bscp\\b',
    '\\bpsexec\\b',
    'remote(?:ly)?\\s+(?:into|control|manage|access|open|type)',
    'remote-?management',
    'logged-?in\\s+(?:desktop\\s+)?session',
    // process / service / host administration
    '\\bsystemctl\\b',
    '\\btasklist\\b',
    'ps\\s+aux',
    'kill\\s+(?:the\\s+)?process',
    '\\breboot\\b',
    '\\bshutdown\\b',
    'restart\\s+the\\s+(?:service|machine|host|computer|daemon)',
    // installing software onto a host
    'apt-get',
    'apt\\s+install',
    'yum\\s+install',
    'dnf\\s+install',
    '\\bpacman\\b',
    'brew\\s+install',
    '\\bwinget\\b',
    '\\bchoco\\b',
  ].join('|'),
  'i',
);

// "run X in <runtime>" is an instruction to execute on the live machine even
// when X is outside the vocabulary above. Only the verb category is recognized;
// the command itself is never inspected.
const COMMAND_EXECUTION_INTENT =
  /\b(?:run|execute|exec|invoke|launch|start|stop|restart|check|show|print|list|query|call)\b/i;

// Repository work stays repository work even when it names a runtime, e.g.
// "fix the parser and run the tests in bash". Coding verbs and repository
// nouns only; no command or file names.
const REPOSITORY_WORK_INTENT =
  /\b(?:implement|edit|fix|refactor|migrate|patch|rewrite|debug|modify|source\s+code|repository|repo|codebase|unit\s+tests?|test\s+suite|typecheck|lint|diagnostics)\b/i;

function textIsOperational(text: string): boolean {
  if (OPERATIONAL_INTENT.test(text) || IPV4_OR_CIDR.test(text)) return true;
  return (
    detectExecutionEnvironment(text) !== undefined &&
    COMMAND_EXECUTION_INTENT.test(text) &&
    !REPOSITORY_WORK_INTENT.test(text)
  );
}

/**
 * True when the text reads as a live system/network operation rather than work
 * on this project's source. Pass the current prompt first and recent history
 * after it: the prompt is judged on its own, then together with the history,
 * so "use wsl" in one turn and "now run it" in the next still count.
 */
export function isOperationalRequest(...texts: Array<string | undefined>): boolean {
  const present = texts.filter((text): text is string => Boolean(text && text.trim()));
  if (!present.length) return false;
  if (textIsOperational(present[0])) return true;
  return present.length > 1 && textIsOperational(present.join('\n'));
}

/** Tool categories that observe or act on the running machine rather than this project's files. */
export function isLiveSystemTool(toolName: string): boolean {
  return toolName === 'shell.run' || toolName.startsWith('wsl.') || toolName.startsWith('system.');
}

/** The repository-inspection tools a coding run must use before answering. */
export const REPOSITORY_EVIDENCE_TOOLS: readonly string[] = [
  'filesystem.list',
  'filesystem.search',
  'filesystem.read',
  'filesystem.stat',
];

export interface AgentEvidenceRequirement {
  /** Any one successful tool in this set satisfies the requirement. */
  tools: string[];
  maxNudges: number;
}

export interface AgentTaskProfile {
  kind: 'repository' | 'operational';
  executionEnvironment?: ExecutionEnvironment;
  /** Undefined when no selected tool could produce the required kind of evidence. */
  evidenceRequirement?: AgentEvidenceRequirement;
  /** System-prompt directive; '' for an ordinary coding run. */
  directive: string;
}

/**
 * Which selected tools can serve as evidence for a task. Repository tasks
 * require repository inspection; operational tasks require output from a live
 * system tool, narrowed to the requested runtime when one was named and is
 * actually selected. Only selected tools are ever named, so the loop never
 * demands a tool the model cannot call.
 */
export function evidenceRequirementFor(input: {
  kind: AgentTaskProfile['kind'];
  executionEnvironment?: ExecutionEnvironment;
  availableTools: string[];
}): AgentEvidenceRequirement | undefined {
  const available = new Set(input.availableTools);
  if (input.kind === 'repository') {
    const tools = REPOSITORY_EVIDENCE_TOOLS.filter((tool) => available.has(tool));
    return { tools: tools.length ? tools : [...REPOSITORY_EVIDENCE_TOOLS], maxNudges: 2 };
  }

  const live = input.availableTools.filter(isLiveSystemTool);
  if (!live.length) return undefined;
  const wsl = live.filter((tool) => tool.startsWith('wsl.'));
  const wantsLinuxRuntime = input.executionEnvironment === 'wsl' || input.executionEnvironment === 'bash';
  return { tools: wantsLinuxRuntime && wsl.length ? wsl : live, maxNudges: 2 };
}

/**
 * One decision for the whole run: what kind of task this is, which runtime it
 * must use, what counts as evidence, and the directive that tells the model so.
 * `availableTools` must be the tools actually selected for the run.
 */
export function resolveAgentTaskProfile(input: {
  prompt: string;
  history?: string;
  availableTools: string[];
}): AgentTaskProfile {
  const executionEnvironment = detectExecutionEnvironment(input.prompt, input.history);
  const operational = isOperationalRequest(input.prompt, input.history);
  const kind = operational ? 'operational' : 'repository';
  return {
    kind,
    executionEnvironment,
    evidenceRequirement: evidenceRequirementFor({
      kind,
      executionEnvironment,
      availableTools: input.availableTools,
    }),
    directive: operationalConstraintsInstructions({
      operational,
      executionEnvironment,
      availableTools: input.availableTools,
    }),
  };
}

function runtimeLabel(environment: ExecutionEnvironment): string {
  switch (environment) {
    case 'wsl':
      return 'WSL';
    case 'powershell':
      return 'PowerShell';
    case 'cmd':
      return 'the Windows Command Prompt';
    case 'bash':
      return 'bash';
  }
}

/**
 * Runtime guidance that names only tools actually selected for the run. When
 * the requested runtime has no selected tool, the model is told to report the
 * gap rather than quietly executing somewhere else.
 */
function environmentGuidance(environment: ExecutionEnvironment, availableTools: string[]): string {
  const available = new Set(availableTools);
  const hasWslRun = available.has('wsl.run');
  const hasWslList = available.has('wsl.list');
  const hasShell = available.has('shell.run');
  const missing = (tool: string) =>
    `- The user requires commands to run in ${runtimeLabel(environment)}, but ${tool} is not selected for this run. Do not substitute another runtime; report TASK_BLOCKED naming the missing tool.`;

  switch (environment) {
    case 'wsl':
      return [
        hasWslRun
          ? `- The user requires commands to run in WSL. Use wsl.run to execute them${hasWslList ? ' and wsl.list to enumerate distributions' : ''}.${hasShell ? ' Do NOT run these commands with shell.run — that is the Windows host shell (PowerShell), a different runtime.' : ''}`
          : missing('wsl.run'),
        hasWslRun
          ? '- A command that fails on the Windows host with "not recognized" / "not found" is NOT evidence the command is unavailable. Run the SAME command through wsl.run before concluding it is missing.'
          : '',
        '- Do NOT respond to a missing Windows executable by installing software on the Windows host (winget, choco, an installer). The user asked for WSL; check and use WSL first.',
      ].filter(Boolean).join('\n');
    case 'powershell':
    case 'cmd':
      return hasShell
        ? `- The user requires commands to run in ${runtimeLabel(environment)}. Use shell.run, which is the Windows host shell. Do not silently switch runtimes.`
        : missing('shell.run');
    case 'bash':
      return [
        hasWslRun
          ? '- The user requires commands to run in bash. Use wsl.run, the bash runtime on this Windows host.'
          : hasShell
            ? '- The user requires commands to run in bash. Use shell.run only where bash is the shell it provides; otherwise report that the bash runtime is not selected rather than switching runtimes.'
            : missing('a shell tool'),
        '- A command missing on one runtime is not proof it is missing in bash. Try the requested runtime before concluding it is unavailable.',
      ].join('\n');
  }
}

/**
 * The directive appended to the system prompt for operational and/or
 * runtime-constrained requests. Returns '' for ordinary coding requests, so
 * genuine repository work is completely unaffected.
 *
 * The two halves compose independently: the operational half relaxes the
 * repository-inspection bias; the environment half preserves an explicit
 * runtime. A coding task that merely names a shell gets only the (benign)
 * environment half and keeps normal repository behavior.
 */
export function operationalConstraintsInstructions(input: {
  operational: boolean;
  executionEnvironment?: ExecutionEnvironment;
  availableTools: string[];
}): string {
  const sections: string[] = [];

  if (input.operational) {
    const liveTools = input.availableTools.filter(isLiveSystemTool).join(', ');

    sections.push(
      [
        'OPERATIONAL EXECUTION DIRECTIVE:',
        '- This is a live system/network task, not a request to inspect or modify this repository. Do NOT use filesystem.list, filesystem.search, or filesystem.read to look for live-system entities — hosts, IP addresses, SSIDs, installed applications, or OS command names. Those tools only see this project\'s files and cannot observe the running machine or network.',
        liveTools
          ? `- Use the live-system tools selected for this run instead: ${liveTools}. Reach for repository tools only if the task is actually to read or change this project's code.`
          : '- No live-system tool is selected for this run, so the task cannot be observed or executed here. Report TASK_BLOCKED naming the missing capability instead of inspecting the repository.',
        '- Ground each conclusion in real command output. Do not claim a host was found, a service is running, or an action succeeded without a successful tool result that shows it.',
      ].join('\n'),
    );
  }

  if (input.executionEnvironment) {
    sections.push(
      [
        'EXECUTION ENVIRONMENT CONSTRAINT:',
        environmentGuidance(input.executionEnvironment, input.availableTools),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
