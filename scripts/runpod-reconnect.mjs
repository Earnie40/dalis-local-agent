/**
 * Reconnects the RunPod GPU inference path end to end.
 *
 * RunPod issues a new public SSH host and port every time a pod starts, and it
 * recreates /workspace/ollama empty on a replacement pod, so "reconnect" is
 * three chores, not one: re-resolve the endpoint, persist it, and reinstall the
 * pod-side service. This does all three and is safe to re-run.
 *
 * Models are kept under /workspace/dacais-media, which is the part of the
 * network volume observed to survive pod replacement, so an 18GB pull is not
 * repeated on every reconnect.
 *
 * Usage:
 *   node --import tsx scripts/runpod-reconnect.mjs [--pull <model>] [--hold]
 *
 * Prints no credentials.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const ENV_PATH = '.env';
const OLLAMA_ROOT = '/workspace/ollama';
const MODEL_ROOT = '/workspace/dacais-media/ollama-models';

const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  if (match) env[match[1]] = match[2].trim();
}

const { discoverRunpodSshEndpoint, formatRunpodConnection } = await import(
  '../apps/server/src/infrastructure/runpod-discovery.ts'
);
const { parseRunpodConnection, buildSshBaseArgs } = await import(
  '../apps/server/src/infrastructure/runpod-connection.ts'
);
const { RunpodService } = await import('../apps/server/src/infrastructure/runpod-service.ts');

const argv = process.argv.slice(2);
const pullIndex = argv.indexOf('--pull');
const pullModel = pullIndex >= 0 ? argv[pullIndex + 1] : undefined;

// ---------------------------------------------------------------- discovery
const endpoint = await discoverRunpodSshEndpoint({
  apiKey: process.env.RUNPOD_API_KEY,
  podId: process.env.RUNPOD_ID,
});

if (!endpoint) {
  console.error('No RUNNING pod exposes a public TCP port 22. Start a pod, then re-run.');
  process.exit(1);
}

console.log(`pod             ${endpoint.podId}  (${endpoint.name})`);
console.log(`ssh endpoint    ${endpoint.host}:${endpoint.port}`);

// Carry the identity file across from whatever the current value names.
let identityFile;
try {
  identityFile = parseRunpodConnection(process.env.RUNPOD_CONNECTION).identityFile;
} catch {
  identityFile = process.env.RUNPOD_SSH_KEY_PATH?.trim() || undefined;
}
const connectionValue = formatRunpodConnection(endpoint, identityFile);

// ------------------------------------------------------------- persist .env
const lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
let changed = false;
const updated = lines.map((line) => {
  if (/^RUNPOD_ID=/.test(line) && line !== `RUNPOD_ID=${endpoint.podId}`) {
    changed = true;
    return `RUNPOD_ID=${endpoint.podId}`;
  }
  if (/^RUNPOD_CONNECTION=/.test(line) && line !== `RUNPOD_CONNECTION=${connectionValue}`) {
    changed = true;
    return `RUNPOD_CONNECTION=${connectionValue}`;
  }
  return line;
});

if (changed) {
  copyFileSync(ENV_PATH, `${ENV_PATH}.backup-reconnect`);
  writeFileSync(ENV_PATH, updated.join('\n'));
  console.log('env             updated (previous saved to .env.backup-reconnect)');
} else {
  console.log('env             already current');
}
process.env.RUNPOD_ID = endpoint.podId;
process.env.RUNPOD_CONNECTION = connectionValue;

// ------------------------------------------------------------- provisioning
const sshArgs = buildSshBaseArgs(parseRunpodConnection(connectionValue));

function ssh(script, timeoutMs = 1_800_000) {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      [...sshArgs, 'bash -s'],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(script);
  });
}

const provision = `
set -e
mkdir -p ${OLLAMA_ROOT}/logs ${MODEL_ROOT}
if [ ! -x ${OLLAMA_ROOT}/bin/ollama ]; then
  echo "installing ollama..."
  command -v zstd >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq zstd >/dev/null 2>&1; }
  TAG=$(curl -fsSL https://api.github.com/repos/ollama/ollama/releases/latest \
    | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -1)
  echo "  release \${TAG}"
  curl -fsSL --max-time 1800 -o /tmp/ollama.tar.zst \
    "https://github.com/ollama/ollama/releases/download/\${TAG}/ollama-linux-amd64.tar.zst"
  tar --zstd -xf /tmp/ollama.tar.zst -C ${OLLAMA_ROOT}
  rm -f /tmp/ollama.tar.zst
else
  echo "ollama already installed"
fi

cat > ${OLLAMA_ROOT}/run-ollama.sh <<'LAUNCHER'
#!/bin/bash
# Pod-side Ollama service. Weights live under /workspace/dacais-media, the part
# of the network volume that survives pod replacement, so a reconnect does not
# re-download them. The API stays bound to loopback and is reached from the
# workstation only through the SSH tunnel.
export OLLAMA_MODELS=${MODEL_ROOT}
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_KEEP_ALIVE=5m
# The L40S also hosts image/video models. Keep one Ollama model resident and
# serialize inference so switching among the installed Qwen roles cannot
# overcommit VRAM.
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_NUM_PARALLEL=1
export LD_LIBRARY_PATH=${OLLAMA_ROOT}/lib/ollama:\${LD_LIBRARY_PATH}
exec ${OLLAMA_ROOT}/bin/ollama serve
LAUNCHER
chmod +x ${OLLAMA_ROOT}/run-ollama.sh
${OLLAMA_ROOT}/bin/ollama --version 2>/dev/null | head -1 || true
`;

console.log('\n--- provisioning pod ---');
const provisioned = await ssh(provision);
process.stdout.write(provisioned.stdout);
if (provisioned.code !== 0) {
  console.error(provisioned.stderr.slice(0, 800));
  process.exit(1);
}

// --------------------------------------------------------- start + tunnel
console.log('\n--- starting service ---');
const service = new RunpodService();
const status = await service.initialize();

console.log('configured      ', status.configured);
console.log('connected       ', status.connected);
console.log('tunnel healthy  ', status.tunnelHealthy);
console.log('gpu             ', JSON.stringify(status.gpu));
console.log('ollama          ', status.ollama.installed ? status.ollama.version : '(not installed)');
console.log('ollama serving  ', status.inference.ollama);
console.log('models          ', status.inference.models.join(', ') || '(none)');
if (status.error) console.log('error           ', status.error);

if (pullModel && status.connected) {
  console.log(`\n--- pulling ${pullModel} (detached on pod) ---`);
  const log = `${OLLAMA_ROOT}/logs/pull.log`;
  await ssh(
    `setsid env OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=${MODEL_ROOT} ` +
      `${OLLAMA_ROOT}/bin/ollama pull ${pullModel} > ${log} 2>&1 < /dev/null &\n` +
      `sleep 4; tail -c 200 ${log} | tr '\\r' '\\n' | tail -1`,
    120_000,
  ).then((result) => process.stdout.write(result.stdout));
  console.log(`\nPull runs on the pod. Progress: ssh ... 'tail -c 200 ${log}'`);
}

if (argv.includes('--hold') && status.tunnelHealthy) {
  console.log('\nTunnel held open. Ctrl+C to close.');
  await new Promise(() => {});
}
process.exit(status.tunnelHealthy ? 0 : 1);
