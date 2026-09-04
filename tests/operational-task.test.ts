import { describe, expect, it } from 'vitest';
import {
  detectExecutionEnvironment,
  evidenceRequirementFor,
  isOperationalRequest,
  operationalConstraintsInstructions,
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
