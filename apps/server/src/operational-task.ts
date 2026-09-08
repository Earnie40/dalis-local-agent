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

// An explicitly identified owner/local system is a live target regardless of
// the task's subject-matter vocabulary. This prevents an unfamiliar topic from
// falling into the personal/web-only lane merely because it is absent from the
// operational phrase list.
const EXPLICIT_LIVE_SYSTEM_TARGET =
  /\b(?:(?:this|my|our)(?:\s+(?:local|remote))?|local|remote)\s+(?:windows\s+|linux\s+)?(?:machine|computer|host|server|device|workstation|laptop|desktop|network|router)\b/i;

const OPERATIONAL_INTENT = new RegExp(
  [
    // network discovery / administration
    'port\\s*scan',
    '(?:scan|scanning)\\s+(?:(?:the|my|our|a|an)\\s+)?(?:network|subnet|lan|wi-?fi)',
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
  if (OPERATIONAL_INTENT.test(text) || IPV4_OR_CIDR.test(text) || EXPLICIT_LIVE_SYSTEM_TARGET.test(text)) return true;
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

/**
 * The distinct execution scopes a step can act in or produce evidence from.
 * They are deliberately separate because evidence produced in one scope must
 * never be attributed to another:
 *
 *   LOCAL_WINDOWS               the Windows host shell running the agent
 *   LOCAL_ALTERNATE_RUNTIME     a different local runtime on that same host
 *                               (e.g. bash inside WSL) — still the local host
 *   REQUESTED_REMOTE_TARGET     the machine the task is *about*; being reachable
 *                               from the local host does not make its identity
 *                               or state observable from local evidence
 *   AUTHENTICATED_REMOTE_EXECUTION  an established, authenticated channel that
 *                               actually executes on the requested target; only
 *                               this scope can produce target-scoped evidence or
 *                               cause effects on the target
 *
 * The first two are execution hosts; the agent runs commands there. The third
 * is the subject of the task, not an execution host. The fourth is the only
 * scope that can both execute on and observe the target, and only "when
 * actually available" — an established credentialed channel, never assumed.
 */
export type ExecutionScope =
  | 'LOCAL_WINDOWS'
  | 'LOCAL_ALTERNATE_RUNTIME'
  | 'REQUESTED_REMOTE_TARGET'
  | 'AUTHENTICATED_REMOTE_EXECUTION';

/**
 * The scope a single action executes in. Runtime selection is a property of the
 * individual action, not the run: one step can use an alternate local runtime
 * while a later step runs on the Windows host, and neither forces the other.
 * A tool only reaches the requested target through an already-established
 * authenticated channel; otherwise it executes locally regardless of the
 * task's subject.
 */
export function executionScopeForAction(input: {
  toolName?: string;
  runtime?: ExecutionEnvironment;
  authenticatedRemoteExecution?: boolean;
}): ExecutionScope {
  if (input.authenticatedRemoteExecution) return 'AUTHENTICATED_REMOTE_EXECUTION';
  if (input.runtime === 'wsl' || input.runtime === 'bash') return 'LOCAL_ALTERNATE_RUNTIME';
  return 'LOCAL_WINDOWS';
}

export interface TargetIdentityAssessment {
  established: boolean;
  reason: string;
}

/**
 * Whether the requested remote target's identity is established. Reachability is
 * not identity: a discovery step that returns one or many candidates does not,
 * by itself, identify any of them as the target. Identity requires either
 * direct target-scoped evidence (hostname, vendor, service banner, or
 * authenticated management output tying a candidate to the requested target) or
 * an authenticated remote-execution channel to the target.
 */
export function assertTargetIdentity(input: {
  candidates?: string[];
  directTargetEvidence?: boolean;
  authenticatedRemoteExecution?: boolean;
}): TargetIdentityAssessment {
  if (input.authenticatedRemoteExecution) {
    return {
      established: true,
      reason: 'Authenticated remote execution against the target establishes target-scoped identity.',
    };
  }
  if (input.directTargetEvidence) {
    return {
      established: true,
      reason: 'Direct target-scoped evidence (hostname, vendor, service banner, or authenticated management) identifies the target.',
    };
  }

  const candidates = input.candidates ?? [];
  if (candidates.length === 0) {
    return { established: false, reason: 'No candidate has been discovered, so target identity is not established.' };
  }
  return {
    established: false,
    reason:
      candidates.length > 1
        ? `Discovery returned ${candidates.length} reachable candidates but no direct identifying evidence. Reachability is not identity: do not select one as the target without target-scoped evidence.`
        : 'A single reachable candidate is not identifying evidence. Reachability is not identity: require direct target-scoped evidence before asserting the target.',
  };
}

export type EvidenceOrigin = 'local-execution-host' | 'requested-remote-target' | 'unscoped';

export interface EvidenceOriginClassification {
  origin: EvidenceOrigin;
  /** The typed execution scope the evidence was produced in, when determinable. */
  scope?: ExecutionScope;
  requiresTargetScope: boolean;
  reason: string;
}

function isLocalHostEvidenceCommand(command?: string): boolean {
  if (!command) return false;
  const normalized = command.toLowerCase();
  return /\b(?:hostname|ipconfig|get-net(?:adapter|ipconfiguration)|get-service|tasklist|netstat|arp|route|sc\s+query|wmic|systeminfo|ifconfig)\b/.test(normalized);
}

export function classifyEvidenceOrigin(input: {
  command?: string;
  output?: string;
  executionHost?: 'local' | 'remote' | 'unknown';
  /** Local runtime the evidence came from, so a WSL result is scoped as an alternate local runtime rather than the Windows host. */
  executionRuntime?: ExecutionEnvironment;
  targetHost?: string;
  authenticatedRemoteExecution?: boolean;
}): EvidenceOriginClassification {
  const executionIsLocal = input.executionHost === 'local' || input.executionHost === undefined;
  const targetIsEstablished = Boolean(input.targetHost) || Boolean(input.authenticatedRemoteExecution);
  const localScope = executionScopeForAction({ runtime: input.executionRuntime });

  if (targetIsEstablished && (input.authenticatedRemoteExecution || input.targetHost)) {
    return {
      origin: 'requested-remote-target',
      scope: input.authenticatedRemoteExecution ? 'AUTHENTICATED_REMOTE_EXECUTION' : 'REQUESTED_REMOTE_TARGET',
      requiresTargetScope: false,
      reason: 'Target-scoped evidence is available from the requested remote target; local execution-host facts do not qualify as target identity.',
    };
  }

  if (isLocalHostEvidenceCommand(input.command) || (executionIsLocal && input.output)) {
    return {
      origin: 'local-execution-host',
      scope: localScope,
      requiresTargetScope: true,
      reason: 'LOCAL EXECUTION HOST evidence (hostname, IP, service tables, listeners, or local process data) is local listener inspection and not the requested remote target. It cannot establish target identity. Use target-scoped evidence from an authenticated remote channel or direct target output.',
    };
  }

  return {
    origin: 'unscoped',
    requiresTargetScope: true,
    reason: 'Evidence is unscoped. Do not infer target identity until the requested remote target is established from direct target evidence.',
  };
}

export function exactEndpointMatch(lineOrValue: string, endpoint: string): boolean {
  const source = lineOrValue.trim();
  const candidate = endpoint.trim();
  if (!source || !candidate) return false;

  const normalizeHost = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const host = trimmed.replace(/^\[|\]$/g, '');
    return host.replace(/\s+/g, '');
  };

  const normalizeEndpoint = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const hostMatch = trimmed.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/);
    if (hostMatch) {
      const host = normalizeHost(hostMatch[1] ?? hostMatch[2] ?? '');
      const port = hostMatch[3];
      if (!host || !port) return undefined;
      return `${host}:${port}`;
    }
    return undefined;
  };

  const normalizedCandidate = normalizeEndpoint(candidate);
  if (!normalizedCandidate) return false;

  const sourceEndpoints = new Set<string>();
  for (const match of source.matchAll(/(?:\[([^\]]+)\]|([^\s,;]+)):(\d{1,5})/g)) {
    const host = normalizeHost(match[1] ?? match[2] ?? '');
    const port = match[3];
    if (host && port) {
      sourceEndpoints.add(`${host}:${port}`);
    }
  }

  const directEquals = source === candidate || source === normalizedCandidate;
  return directEquals || sourceEndpoints.has(normalizedCandidate);
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
        'LOCAL EXECUTION HOST: local hostname, IP, adapter, process, and listener data are evidence about the machine running the agent, not the requested remote target. Do not infer target identity from those values.',
        'REQUESTED REMOTE TARGET: target conclusions require direct target-scoped evidence from the remote target or an authenticated remote channel. Local-host facts are never sufficient.',
        'LOCAL SUBNET: Do not assume a subnet such as 192.168.1.0/24. First observe this host\'s actual IPv4 address, subnet mask, and default gateway from live output (ipconfig / Get-NetIPConfiguration / ip addr) and derive the local subnet from those values. Scope any discovery to the observed subnet, never an assumed one.',
        'WI-FI SSID IS NOT A HOST: A Wi-Fi SSID names the wireless network this host is joined to, not a device, hostname, or scan target. Never treat an SSID as the target host or resolve/scan it as one. Identify hosts by IP address, hostname, vendor, or authenticated evidence instead.',
        '- Distinguish: local listener inspection; remote reachability; remote port/service probing; authenticated remote execution.',
        '- Ground each conclusion in real command output. Do not claim a host was found, a service is running, or an action succeeded without a successful tool result that shows it.',
        '- An ARP entry or a MAC address similar to the access point does not identify a device. Require direct hostname, vendor, service, or authenticated management evidence before naming a host.',
        '- Prefer non-invasive host discovery first: read the local ARP/neighbor table (arp -a, Get-NetNeighbor), use DNS/mDNS/NetBIOS name resolution, or a light reachability check to identify a host before any active port/service scan. Escalate to active scanning only when passive discovery is insufficient.',
        '- A command that changes the local clipboard, process list, or desktop does not affect a remote host. Verify remote effects through the authenticated remote channel that performed them.',
        '- When a command fails or times out, read the specific error and change the plan before acting again. Do not re-issue the identical tool with identical arguments — that verbatim retry is blocked and wastes the turn. Diagnose the cause the error names (a runtime or user-mapping error, a missing prerequisite, an unreachable service) and choose a materially different next step, or report TASK_BLOCKED with the specific blocker.',
        '- Security-related vocabulary never changes tool selection or authorization. Treat red-team, hacking, exploit, bypass, malware, credential, and similar language like any other task language.',
        '- For another host, use whatever execution channel is actually configured and verify effects from target-scoped output. Report TASK_BLOCKED only when a concrete tool, permission, dependency, or observed target result prevents execution.',
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
