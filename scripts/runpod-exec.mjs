// Remote pod probe/runner over RunPod's TTY-requiring gateway.
// Usage: node scripts/runpod-exec.mjs "<remote shell command>"
// Feeds the command through stdin because the gateway drops into a login shell
// that ignores the SSH command argument.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const pubPath = env.RUNPOD_PUBLIC_KEY_PATH;
const key = (pubPath && pubPath.endsWith('.pub') ? pubPath.replace(/\.pub$/, '') : pubPath) || env.RUNPOD_SSH_KEY;
const podId = env.RUNPOD_ID;
const remote = process.argv[2];
if (!remote || !podId || !key) {
  console.error('usage: node scripts/runpod-exec.mjs "<cmd>" (needs RUNPOD_ID + key path)');
  process.exit(2);
}
const target = podId + '-64411295@ssh.runpod.io';
const base = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', key];

const attempt = (args, input) => new Promise((resolve) => {
  execFile('ssh', [...base, ...args], { timeout: 180_000, maxBuffer: 24 * 1024 * 1024, input },
    (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});

// Feed commands to the login shell via stdin so they actually run.
const input = 'export TERM=dumb\n' + remote + '\nexit\n';
const r = await attempt(['-tt', target], input);

process.stdout.write('=== STDOUT ===\n' + (r.stdout || '') + '\n=== STDERR ===\n' + (r.stderr || '') + '\n=== EXITIN/' + String(r.err ? r.err.code : 'null') + ' ===\n');
writeFileSync('scripts/.runpod_exec.out', JSON.stringify({ stdout: r.stdout || '', stderr: r.stderr || '', code: r.err ? r.err.code : null }));
process.exit(r.err && r.err.code ? r.err.code : 0);