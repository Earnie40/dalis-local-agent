import { describe, expect, it } from 'vitest';
import {
  assertTargetIdentity,
  classifyEvidenceOrigin,
  detectExecutionEnvironment,
  exactEndpointMatch,
  evidenceRequirementFor,
  executionScopeForAction,
  isOperationalRequest,
  operationalConstraintsInstructions,
  prohibitedOperationalRequestReason,
  resolveAgentTaskProfile,
} from '../apps/server/src/operational-task';

const LIVE_TOOLS = ['shell.run', 'wsl.run', 'wsl.list', 'system.network.info', 'filesystem.search'];

describe('operational vs. repository request detection', () => {
  it('1. an operational network request is not mapped to repository inspection', () => {
    const prompt =
      'identify the desktop on the 192.168.1.0/24 network and open a remote desktop session to it';
    expect(isOperationalRequest(prompt)).toBe(true);

    const directive = operationalConstraintsInstructions({
      operational: true,
      availableTools: LIVE_TOOLS,
    });
    // The mechanism that stops the repository-search reflex: an explicit
    // instruction not to look for live-system entities in project files.
    expect(directive).toContain('Do NOT use filesystem.list, filesystem.search');
    expect(directive).toContain('live-system tools');
    expect(directive).toContain('system.network.info');
  });

  it('5. a genuine coding request is untouched — no directive, normal repository behavior', () => {
    const prompt = 'fix the failing unit test in agent-run-mode.ts and update its assertions';
    expect(isOperationalRequest(prompt)).toBe(false);
    expect(detectExecutionEnvironment(prompt)).toBeUndefined();
    expect(
      operationalConstraintsInstructions({
        operational: false,
        executionEnvironment: undefined,
        availableTools: LIVE_TOOLS,
      }),
    ).toBe('');
  });

  it('does not misfire on coding prose that merely resembles system words', () => {
    // "service layer" / "network module" are code nouns, not host administration.
    expect(isOperationalRequest('refactor the service layer in the network module')).toBe(false);
  });
});

describe('operational safety boundary', () => {
  it('blocks explicit remote compromise even when the user claims to own the target', () => {
    expect(prohibitedOperationalRequestReason(
      'scan the Wi-Fi I own, find the desktop, and find a backdoor way into it',
    )).toMatch(/cannot be executed/i);
  });

  it('allows authenticated remote administration on an owned system', () => {
    expect(prohibitedOperationalRequestReason(
      'open an RDP session to my desktop using my configured credentials',
    )).toBeUndefined();
  });

  it('does not block repository work that fixes a backdoor vulnerability', () => {
    expect(prohibitedOperationalRequestReason(
      'fix the backdoor vulnerability in the remote access module and add unit tests',
    )).toBeUndefined();
  });

  it('preserves the block across a terse follow-up via conversation history', () => {
    expect(prohibitedOperationalRequestReason(
      'now do it',
      'scan my network and find a backdoor way into the desktop',
    )).toMatch(/authenticated administration path/i);
  });

  it('warns operational models against the unsupported inferences in the failure trace', () => {
    const directive = operationalConstraintsInstructions({
      operational: true,
      availableTools: LIVE_TOOLS,
    });
    expect(directive).toContain('An ARP entry or a MAC address');
    expect(directive).toContain('local clipboard');
    expect(directive).toContain('Never replace authentication with a backdoor');
  });
});

describe('explicit execution-environment constraints', () => {
  it('2. an explicit "use wsl" is preserved across turns via history', () => {
    // The turn that finally runs a command may only say "go ahead"; the
    // constraint lives in the earlier turn, so history must be consulted.
    const currentPrompt = 'now run it';
    const history = 'scan the network for the host\nuse wsl';
    expect(detectExecutionEnvironment(currentPrompt)).toBeUndefined();
    expect(detectExecutionEnvironment(currentPrompt, history)).toBe('wsl');
  });

  it('3. a WSL command is routed to wsl.run, not tested against the Windows shell first', () => {
    const directive = operationalConstraintsInstructions({
      operational: true,
      executionEnvironment: 'wsl',
      availableTools: LIVE_TOOLS,
    });
    expect(directive).toContain('Use wsl.run');
    expect(directive).toContain('Do NOT run these commands with shell.run');
    expect(directive).toContain('Run the SAME command through wsl.run before concluding it is missing');
  });

  it('4. a missing Windows executable does not justify a Windows install when WSL was requested', () => {
    const directive = operationalConstraintsInstructions({
      operational: true,
      executionEnvironment: 'wsl',
      availableTools: LIVE_TOOLS,
    });
    expect(directive).toContain('Do NOT respond to a missing Windows executable by installing software on the Windows host');
  });

  it('recognizes the named runtimes and prefers the most specific match', () => {
    expect(detectExecutionEnvironment('run this in PowerShell')).toBe('powershell');
    expect(detectExecutionEnvironment('execute inside the command prompt')).toBe('cmd');
    expect(detectExecutionEnvironment('run it in bash')).toBe('bash');
    // WSL wins over a co-mentioned bash, since WSL is the concrete host.
    expect(detectExecutionEnvironment('open bash in wsl')).toBe('wsl');
  });

  it('an environment constraint on an otherwise-coding task adds guidance but no repo suppression', () => {
    const directive = operationalConstraintsInstructions({
      operational: false,
      executionEnvironment: 'bash',
      availableTools: LIVE_TOOLS,
    });
    expect(directive).toContain('EXECUTION ENVIRONMENT CONSTRAINT');
    expect(directive).not.toContain('OPERATIONAL EXECUTION DIRECTIVE');
  });
});

describe('execution-host vs target-host evidence', () => {
  it('local IP evidence cannot establish remote-target identity', () => {
    const evidence = classifyEvidenceOrigin({
      command: 'ipconfig',
      output: 'IPv4 Address . . . . . . . . . : 192.168.1.12',
      executionHost: 'local',
      targetHost: undefined,
    });

    expect(evidence.origin).toBe('local-execution-host');
    expect(evidence.requiresTargetScope).toBe(true);
    expect(evidence.reason).toMatch(/LOCAL EXECUTION HOST/i);
    expect(evidence.reason).toMatch(/local listener inspection/i);
    expect(evidence.reason).toMatch(/cannot establish target identity/i);
  });

  it('local netstat output cannot be attributed to a remote target', () => {
    const evidence = classifyEvidenceOrigin({
      command: 'netstat -ano',
      output: 'TCP    0.0.0.0:80    0.0.0.0:0    LISTENING',
      executionHost: 'local',
      targetHost: undefined,
    });

    expect(evidence.origin).toBe('local-execution-host');
    expect(evidence.requiresTargetScope).toBe(true);
    expect(evidence.reason).toMatch(/local listener inspection/i);
  });

  it('target conclusions require target-scoped evidence', () => {
    const evidence = classifyEvidenceOrigin({
      command: 'ssh user@example',
      output: 'Connected to target host and printed release info.',
      executionHost: 'local',
      targetHost: 'example',
      authenticatedRemoteExecution: true,
    });

    expect(evidence.origin).toBe('requested-remote-target');
    expect(evidence.requiresTargetScope).toBe(false);
    expect(evidence.reason).toMatch(/target-scoped evidence/i);
  });

  it('runtime fallback preserves the selected execution environment', () => {
    const profile = resolveAgentTaskProfile({
      prompt: 'use WSL and run uname -a',
      availableTools: ['filesystem.list', 'shell.run', 'wsl.run'],
    });

    expect(profile.executionEnvironment).toBe('wsl');
    expect(profile.evidenceRequirement?.tools).toEqual(['wsl.run']);
    expect(profile.directive).toContain('Use wsl.run');
    expect(profile.directive).toContain('Do NOT run these commands with shell.run');
    expect(profile.directive).not.toContain('Use shell.run');
  });

  it('exact port verification does not match unrelated numeric substrings', () => {
    expect(exactEndpointMatch('0.0.0.0:8080', '0.0.0.0:8080')).toBe(true);
    expect(exactEndpointMatch('0.0.0.0:8080', '0.0.0.0:8081')).toBe(false);
    expect(exactEndpointMatch('10.0.0.5:8080', '0.0.0.0:8080')).toBe(false);
    expect(exactEndpointMatch('TCP 0.0.0.0:8080 LISTENING', '0.0.0.0:8080')).toBe(true);
    expect(exactEndpointMatch('TCP 0.0.0.0:8080 LISTENING', '8080')).toBe(false);
  });

  it('normal local-host diagnostics still work correctly', () => {
    const directive = operationalConstraintsInstructions({
      operational: true,
      executionEnvironment: undefined,
      availableTools: ['system.network.info', 'shell.run'],
    });

    expect(directive).toContain('LOCAL EXECUTION HOST');
    expect(directive).toContain('REQUESTED REMOTE TARGET');
    expect(directive).toContain('local listener inspection');
    expect(directive).toContain('authenticated remote');
  });
});

describe('run task profile — evidence follows the task, tools follow the selection', () => {
  it('a benign runtime-scoped command is operational, needs no repository evidence, and executes through WSL', () => {
    const selected = ['filesystem.list', 'filesystem.search', 'filesystem.read', 'filesystem.stat', 'shell.run', 'wsl.list', 'wsl.run'];
    const profile = resolveAgentTaskProfile({ prompt: 'use WSL and run uname -a', availableTools: selected });

    expect(profile.kind).toBe('operational');
    expect(profile.executionEnvironment).toBe('wsl');
    // Evidence must come through the requested runtime, never from repository inspection.
    expect(profile.evidenceRequirement?.tools).toEqual(['wsl.list', 'wsl.run']);
    expect(profile.evidenceRequirement?.tools).not.toEqual(expect.arrayContaining(['filesystem.list', 'filesystem.search']));
    expect(profile.directive).toContain('OPERATIONAL EXECUTION DIRECTIVE');
    expect(profile.directive).toContain('Use wsl.run');
    expect(profile.directive).toContain('Do NOT run these commands with shell.run');
  });

  it('the runtime constraint from an earlier turn still shapes the current turn', () => {
    const profile = resolveAgentTaskProfile({
      prompt: 'now run it',
      history: 'use wsl',
      availableTools: ['filesystem.read', 'shell.run', 'wsl.run'],
    });
    expect(profile.kind).toBe('operational');
    expect(profile.executionEnvironment).toBe('wsl');
    expect(profile.evidenceRequirement?.tools).toEqual(['wsl.run']);
  });

  it('a repository task keeps repository evidence even when it names a runtime', () => {
    const selected = ['filesystem.list', 'filesystem.search', 'filesystem.read', 'filesystem.stat', 'filesystem.edit', 'tests.run', 'shell.run', 'wsl.run'];
    const profile = resolveAgentTaskProfile({
      prompt: 'fix the failing unit test in the parser and run the test suite in WSL',
      availableTools: selected,
    });
    expect(profile.kind).toBe('repository');
    expect(profile.executionEnvironment).toBe('wsl');
    expect(profile.evidenceRequirement?.tools).toEqual(['filesystem.list', 'filesystem.search', 'filesystem.read', 'filesystem.stat']);
    expect(profile.directive).not.toContain('OPERATIONAL EXECUTION DIRECTIVE');
    expect(profile.directive).toContain('EXECUTION ENVIRONMENT CONSTRAINT');
  });

  it('a plain coding task is a repository profile with no directive', () => {
    const profile = resolveAgentTaskProfile({
      prompt: 'refactor the service layer in the network module',
      availableTools: ['filesystem.list', 'filesystem.read', 'shell.run'],
    });
    expect(profile.kind).toBe('repository');
    expect(profile.executionEnvironment).toBeUndefined();
    expect(profile.evidenceRequirement?.tools).toEqual(['filesystem.list', 'filesystem.read']);
    expect(profile.directive).toBe('');
  });

  it('only advertises live-system tools that were actually selected', () => {
    // wsl.* not selected: the directive must not name it, and the evidence
    // requirement falls back to the live tools that are present.
    const profile = resolveAgentTaskProfile({
      prompt: 'scan the network for hosts',
      availableTools: ['filesystem.list', 'shell.run', 'system.network.info'],
    });
    expect(profile.kind).toBe('operational');
    expect(profile.evidenceRequirement?.tools).toEqual(['shell.run', 'system.network.info']);
    expect(profile.directive).not.toContain('wsl.run');
    expect(profile.directive).toContain('shell.run, system.network.info');
  });

  it('a requested runtime with no selected tool is reported as missing, not silently swapped', () => {
    const profile = resolveAgentTaskProfile({
      prompt: 'use WSL and run uname -a',
      availableTools: ['filesystem.list', 'filesystem.read', 'shell.run'],
    });
    expect(profile.kind).toBe('operational');
    expect(profile.directive).toContain('wsl.run is not selected for this run');
    expect(profile.directive).toContain('Do not substitute another runtime');
    expect(profile.directive).not.toContain('Use wsl.run');
    // Without the requested runtime the remaining live tool is still the only
    // acceptable evidence; repository inspection never becomes a substitute.
    expect(profile.evidenceRequirement?.tools).toEqual(['shell.run']);
  });

  it('an operational task with no live-system tool has no evidence gate instead of a repository one', () => {
    expect(
      evidenceRequirementFor({ kind: 'operational', availableTools: ['filesystem.list', 'filesystem.read'] }),
    ).toBeUndefined();
    expect(
      resolveAgentTaskProfile({ prompt: 'ping the gateway', availableTools: ['filesystem.list'] }).directive,
    ).toContain('No live-system tool is selected');
  });
});

describe('typed execution scopes and target identity', () => {
  it('multiple discovered candidates cannot establish target identity by themselves', () => {
    // A discovery step returned several reachable candidates but nothing that
    // identifies any of them as the requested target.
    const assessment = assertTargetIdentity({
      candidates: ['candidate-a', 'candidate-b', 'candidate-c'],
    });
    expect(assessment.established).toBe(false);
    expect(assessment.reason).toMatch(/reachability is not identity/i);

    // Even a single reachable candidate is not identity on its own.
    const single = assertTargetIdentity({ candidates: ['only-one'] });
    expect(single.established).toBe(false);
    expect(single.reason).toMatch(/reachability is not identity/i);
  });

  it('target identity requires direct target-scoped or authenticated evidence', () => {
    expect(
      assertTargetIdentity({ candidates: ['candidate-a', 'candidate-b'], directTargetEvidence: true }).established,
    ).toBe(true);
    expect(
      assertTargetIdentity({ candidates: ['candidate-a'], authenticatedRemoteExecution: true }).established,
    ).toBe(true);
  });

  it('one action can use an alternate runtime without forcing later actions into it', () => {
    // Each action resolves its own scope from its own runtime; neither binds the
    // other. An earlier alternate-runtime step does not pin a later host step.
    const first = executionScopeForAction({ toolName: 'runner', runtime: 'wsl' });
    const second = executionScopeForAction({ toolName: 'runner', runtime: 'powershell' });
    expect(first).toBe('LOCAL_ALTERNATE_RUNTIME');
    expect(second).toBe('LOCAL_WINDOWS');
    expect(first).not.toBe(second);

    // bash is an alternate local runtime; an established authenticated channel
    // is the only scope that actually reaches the requested target.
    expect(executionScopeForAction({ runtime: 'bash' })).toBe('LOCAL_ALTERNATE_RUNTIME');
    expect(executionScopeForAction({ authenticatedRemoteExecution: true })).toBe('AUTHENTICATED_REMOTE_EXECUTION');
    // Naming a remote target without an authenticated channel still executes locally.
    expect(executionScopeForAction({ runtime: 'powershell' })).toBe('LOCAL_WINDOWS');
  });

  it('local execution evidence is scoped locally and cannot be attributed to another target', () => {
    const windows = classifyEvidenceOrigin({
      command: 'ipconfig',
      output: 'IPv4 Address . . . : 10.0.0.4',
      executionHost: 'local',
    });
    expect(windows.origin).toBe('local-execution-host');
    expect(windows.scope).toBe('LOCAL_WINDOWS');
    expect(windows.requiresTargetScope).toBe(true);

    // The same reasoning holds for an alternate local runtime: still local, still
    // not the requested target.
    const alternate = classifyEvidenceOrigin({
      command: 'ip addr',
      output: 'inet 10.0.0.4/24',
      executionHost: 'local',
      executionRuntime: 'wsl',
    });
    expect(alternate.origin).toBe('local-execution-host');
    expect(alternate.scope).toBe('LOCAL_ALTERNATE_RUNTIME');
    expect(alternate.requiresTargetScope).toBe(true);
  });

  it('only an authenticated channel yields target-scoped evidence', () => {
    const authed = classifyEvidenceOrigin({
      command: 'ssh op@target hostname',
      output: 'target-host',
      targetHost: 'target',
      authenticatedRemoteExecution: true,
    });
    expect(authed.origin).toBe('requested-remote-target');
    expect(authed.scope).toBe('AUTHENTICATED_REMOTE_EXECUTION');
    expect(authed.requiresTargetScope).toBe(false);
  });
});

describe('grounded discovery guidance for the red-team flow', () => {
  const operationalDirective = () =>
    operationalConstraintsInstructions({ operational: true, availableTools: LIVE_TOOLS });

  it('subnet discovery: the actual subnet must be detected, never assumed as 192.168.1.0/24', () => {
    const directive = operationalDirective();
    expect(directive).toContain('LOCAL SUBNET');
    // The exact anti-pattern from the failure trace is named and rejected.
    expect(directive).toContain('Do not assume a subnet such as 192.168.1.0/24');
    // It must require reading real address/mask/gateway before scoping discovery.
    expect(directive).toMatch(/IPv4 address, subnet mask, and default gateway/i);
    expect(directive).toMatch(/derive the local subnet/i);
    expect(directive).toMatch(/Scope any discovery to the observed subnet/i);
  });

  it('an SSID is treated as a Wi-Fi network name, not a target host', () => {
    const directive = operationalDirective();
    expect(directive).toContain('WI-FI SSID IS NOT A HOST');
    expect(directive).toMatch(/never treat an SSID as the target host/i);
    expect(directive).toMatch(/resolve\/scan it as one/i);
  });

  it('non-invasive host discovery is preferred before any active scan', () => {
    const directive = operationalDirective();
    expect(directive).toMatch(/Prefer non-invasive host discovery first/i);
    // Passive methods are named; active scanning is the escalation, not the default.
    expect(directive).toMatch(/arp -a|Get-NetNeighbor/);
    expect(directive).toMatch(/DNS\/mDNS\/NetBIOS/);
    expect(directive).toMatch(/before any active port\/service scan/i);
    expect(directive).toMatch(/Escalate to active scanning only when passive discovery is insufficient/i);
  });

  it('failure-aware branching: diagnose the error and change the plan instead of a verbatim retry', () => {
    const directive = operationalDirective();
    expect(directive).toMatch(/When a command fails or times out/i);
    expect(directive).toMatch(/Do not re-issue the identical tool with identical arguments/i);
    expect(directive).toMatch(/verbatim retry is blocked/i);
    expect(directive).toMatch(/user-mapping error/i);
    expect(directive).toMatch(/materially different next step/i);
  });

  it('the final authorized action uses an existing authenticated Windows admin/remote-management path', () => {
    const directive = operationalDirective();
    expect(directive).toMatch(/RDP, WinRM\/PowerShell Remoting/);
    expect(directive).toMatch(/explicit credentials/i);
    expect(directive).toMatch(/Do not exploit, bypass, brute-force, or work around authentication/i);
    expect(directive).toMatch(/do not use an unauthenticated path/i);
    // The pre-existing no-backdoor guarantee is preserved alongside the new guidance.
    expect(directive).toContain('Never replace authentication with a backdoor or access-control bypass');
  });

  it('none of the new grounding guidance leaks into an ordinary coding run', () => {
    const directive = operationalConstraintsInstructions({
      operational: false,
      executionEnvironment: undefined,
      availableTools: LIVE_TOOLS,
    });
    expect(directive).toBe('');
  });
});
