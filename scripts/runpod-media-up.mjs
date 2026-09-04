/**
 * Starts the DACAIS-owned GPU media service on the selected Runpod and holds a
 * loopback-only SSH tunnel open for image/video tools.
 *
 * Usage:
 *   node --import tsx scripts/runpod-media-up.mjs [--pod-id <id>]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

const { discoverRunpodSshEndpoint, formatRunpodConnection } = await import(
  '../apps/server/src/infrastructure/runpod-discovery.ts'
);
const { buildSshBaseArgs, buildSshTunnelArgs, parseRunpodConnection } = await import(
  '../apps/server/src/infrastructure/runpod-connection.ts'
);

const argv = process.argv.slice(2);
const podIndex = argv.indexOf('--pod-id');
const podId = podIndex >= 0 ? argv[podIndex + 1] : process.env.RUNPOD_ID;
const identityIndex = argv.indexOf('--identity-file');
const requestedIdentity = identityIndex >= 0 ? argv[identityIndex + 1] : undefined;
const localPort = Number(process.env.DACAI_MEDIA_LOCAL_PORT ?? 18090);
const endpoint = await discoverRunpodSshEndpoint({ apiKey: process.env.RUNPOD_API_KEY, podId });
if (!endpoint) {
  console.error('No running Runpod with public TCP SSH was found.');
  process.exit(1);
}

let identityFile;
try { identityFile = requestedIdentity || parseRunpodConnection(process.env.RUNPOD_CONNECTION).identityFile; }
catch { /* Use the default below. */ }
identityFile ||= process.env.RUNPOD_SSH_KEY_PATH?.trim() || join(homedir(), '.ssh', 'id_ed25519');
const connection = parseRunpodConnection(formatRunpodConnection(endpoint, identityFile));
const baseArgs = buildSshBaseArgs(connection);

function run(command, args, input, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const remoteSetup = `
set -e
ROOT=/workspace/dacais-media
test -f "$ROOT/service/media_service.py"
cat > "$ROOT/run-media.sh" <<'LAUNCHER'
#!/bin/bash
ROOT=/workspace/dacais-media
export DACAIS_MEDIA_ROOT="$ROOT"
export DACAIS_MEDIA_HOST=127.0.0.1
export DACAIS_MEDIA_PORT=8090
export DACAIS_SDXL_PYTHON="$(command -v python3)"
export DACAIS_SDXL_MODEL_ROOT="$ROOT/models/sdxl-base"
export DACAIS_SVD_PYTHON="$(command -v python3)"
export DACAIS_SVD_MODEL_ROOT="$ROOT/models/svd-xt"
export HF_HOME="$ROOT/cache/huggingface"
exec python3 "$ROOT/service/media_service.py"
LAUNCHER
chmod +x "$ROOT/run-media.sh"
if ! curl -fsS --max-time 2 http://127.0.0.1:8090/v1/health >/dev/null 2>&1; then
  pkill -f '[m]edia_service.py' >/dev/null 2>&1 || true
  setsid "$ROOT/run-media.sh" > "$ROOT/logs/media-service.log" 2>&1 < /dev/null &
fi
for i in $(seq 1 30); do
  curl -fsS --max-time 2 http://127.0.0.1:8090/v1/health >/dev/null 2>&1 && exit 0
  sleep 1
done
exit 1
`;

console.log(`pod             ${endpoint.podId} (${endpoint.name})`);
const setup = await run('ssh', [...baseArgs, 'bash -s'], remoteSetup, 45_000);
if (setup.code !== 0) {
  console.error('The pod-side media service did not become healthy.');
  if (setup.stderr.trim()) console.error(setup.stderr.trim().slice(-800));
  process.exit(1);
}

const tunnel = spawn('ssh', buildSshTunnelArgs(connection, localPort, 8090), {
  shell: false, windowsHide: true, stdio: 'ignore',
});
let healthy = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    const response = await fetch(`http://127.0.0.1:${localPort}/v1/health`, { signal: AbortSignal.timeout(1_500) });
    if (response.ok) { healthy = true; break; }
  } catch { /* Tunnel is still starting. */ }
  if (tunnel.exitCode !== null) break;
}
if (!healthy) {
  tunnel.kill();
  console.error('The local media SSH tunnel did not become healthy.');
  process.exit(1);
}

console.log(`media API       http://127.0.0.1:${localPort}`);
console.log('tunnel healthy  true');
console.log('Press Ctrl+C to close the tunnel; the pod-side service remains installed.');
const close = () => { tunnel.kill(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
await new Promise((resolve) => tunnel.once('exit', resolve));
process.exit(1);
