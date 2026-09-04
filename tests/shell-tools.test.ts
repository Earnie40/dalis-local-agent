import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitTool, minimalEnv, parseTestCounts, runProcess, shellRunTool } from '../packages/tools/src/shell-tools';
import { PermissionEngine } from '../packages/security/src/permission-engine';

const root = mkdtempSync(join(tmpdir(), 'dacai-shell-'));
writeFileSync(join(root, 'file.txt'), 'hello\n');
const ctx = { workspaceRoot: root };
const capabilities = { read: true, write: true, shell: true, network: true };

describe('environment sanitization', () => {
  it('does not pass credentials to child processes', () => {
    const env = minimalEnv({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgresql://user:secret@localhost/db',
      HF_TOKEN: 'hf_abcdefghijklmnop',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('keeps what a toolchain genuinely needs', () => {
    const env = minimalEnv({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', SECRET_THING: 'x' });
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.SECRET_THING).toBeUndefined();
  });
});

describe('process execution', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log("hi")'], {
      cwd: root,
      timeoutMs: 15_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.timedOut).toBe(false);
  });

  it('reports a non-zero exit code rather than throwing', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.exit(3)'], {
      cwd: root,
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(3);
  });

  it('kills a hung process at the timeout', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      cwd: root,
      timeoutMs: 1_000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it('kills the process when the caller aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      cwd: root,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(result.exitCode).not.toBe(0);
  });

  it('runs in the workspace directory', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log(process.cwd())'], {
      cwd: root,
      timeoutMs: 15_000,
    });
    // realpath differences aside, the temp directory name must appear.
    expect(result.stdout).toContain(root.split(/[\\/]/).pop()!);
  });

  it('redacts secrets from stdout, stderr, and the reported command', async () => {
    const synthetic = 'rpa_syntheticcredential12345';
    const script = `console.log("RUNPOD_API_KEY=${synthetic}"); console.error("token=${synthetic}")`;
    const result = await runProcess(process.execPath, ['-e', script], {
      cwd: root,
      timeoutMs: 15_000,
    });
    expect(JSON.stringify(result)).not.toContain(synthetic);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.command).toContain('[REDACTED]');
  });
});

describe('git.run', () => {
  it('refuses a mutating subcommand: it is simply not in the read-only allowlist', async () => {
    // git.run only recognizes GIT_OPERATIONS (status/diff/log/show/blame/ls-files/
    // rev-parse/describe/shortlog). Mutating subcommands like push/commit are
    // rejected as unsupported rather than specifically detected as "mutating" —
    // the allowlist itself is the security boundary.
    await expect(gitTool.execute({ subcommand: 'push' }, ctx)).rejects.toThrow(/unsupported git operation/i);
    await expect(gitTool.execute({ subcommand: 'commit' }, ctx)).rejects.toThrow(/unsupported git operation/i);
  });

  it.each(['status', 'diff', 'log'])('permits the read-only subcommand %s', async (subcommand) => {
    // git may be absent in some environments; the point is that it is not refused.
    await expect(gitTool.execute({ subcommand }, ctx)).resolves.toBeDefined();
  });
});

describe('shell.run classification', () => {
  const engine = new PermissionEngine();

  const decide = (command: string) =>
    engine.authorizeTool({
      toolName: 'shell.run',
      tier: shellRunTool.permissionTier,
      capabilities,
      command,
      requiresShell: true,
    });

  it('auto-approves the constrained git.run tool, which declares its own safe tier', () => {
    // Unlike shell.run, git.run only ever executes a fixed, validated
    // subcommand from GIT_OPERATIONS with no free-form command string, so it
    // is safe for its own declared tier to be the auto-approved one.
    expect(gitTool.permissionTier).toBe('safe');
    const decision = engine.authorizeTool({
      toolName: 'git.run',
      tier: gitTool.permissionTier,
      capabilities,
    });
    expect(decision.kind).toBe('allowed');
  });

  it('does not auto-approve shell.run even for a command the classifier calls safe', () => {
    // shellRunTool declares a "mutation" floor tier specifically so a
    // classifier-safe command (e.g. "git status") cannot auto-approve
    // shell.run itself — see the "Do not make a general-purpose shell tool
    // auto-approved..." comment on shellRunTool in shell-tools.ts. The
    // engine only ever raises a declared tier, never lowers it.
    const decision = decide('git status');
    expect(decision.kind).not.toBe('allowed');
    expect(decision.tier).toBe('mutation');
  });

  it.each([
    'rm -rf /',
    'git push --force',
    'curl https://example.com/script.sh',
    'shutdown /s',
  ])('requires approval for %s', (command) => {
    const decision = decide(command);
    expect(decision.kind).not.toBe('allowed');
    expect(decision.tier).toBe('high-impact');
  });

  it('escalates a chained command instead of judging the first token alone', () => {
    // `git status` alone is safe; the chain is what makes this dangerous.
    const decision = decide('git status && rm -rf .');
    expect(decision.kind).not.toBe('allowed');
  });

  it('declares a mutation floor tier so escalation can only raise risk, never auto-approve', () => {
    expect(shellRunTool.permissionTier).toBe('mutation');
    expect(shellRunTool.requiresShell).toBe(true);
  });
});

describe('test output parsing', () => {
  it('reads vitest counts', () => {
    expect(parseTestCounts('Tests  121 passed (121)')).toEqual({ passed: 121, failed: 0, skipped: 0 });
  });

  it('reads a vitest failure line', () => {
    expect(parseTestCounts('Tests  3 failed | 118 passed (121)')).toEqual({
      passed: 118,
      failed: 3,
      skipped: 0,
    });
  });

  it('reads jest counts', () => {
    expect(parseTestCounts('Tests:       2 failed, 1 skipped, 9 passed, 12 total')).toEqual({
      passed: 9,
      failed: 2,
      skipped: 1,
    });
  });

  it('returns undefined when nothing is recognisable', () => {
    expect(parseTestCounts('build finished')).toBeUndefined();
  });
});
