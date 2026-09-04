/**
 * Deploy the complete DACAIS stack to the existing RunPod without exposing
 * database, model, media, or API ports publicly.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/runpod-app-up.mjs
 *   node --env-file=.env --import tsx scripts/runpod-app-up.mjs --preserve-source
 *
 * Every run deploys the current worktree so a restarted pod cannot execute a
 * stale application revision. --preserve-source is an explicit diagnostic
 * escape hatch; the database remains persistent unless --refresh-db is used.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const APP_ROOT = '/workspace/dacai-app';
const RUNTIME_ROOT = '/workspace/dacai-runtime';
const PG_ROOT = '/workspace/dacai-postgres';
const CONFIG_ROOT = '/etc/dacai';
const argv = new Set(process.argv.slice(2));
const syncRequested = argv.has('--sync') || !argv.has('--preserve-source');
const refreshDatabase = argv.has('--refresh-db');
const localRoot = process.cwd();

const envPath = resolve(localRoot, '.env');
if (!existsSync(envPath)) throw new Error('The local .env file is required.');

// Node's --env-file is authoritative. Reading only the key names lets us copy
// the configured feature set without implementing a second dotenv parser or
// ever printing a secret value.
const envKeys = [...new Set(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter(Boolean),
)];

for (const required of ['DATABASE_URL', 'RUNPOD_API_KEY', 'RUNPOD_ID']) {
  if (!process.env[required]?.trim()) {
    throw new Error(`${required} is required. Run with --env-file=.env.`);
  }
}

const localDatabaseUrl = new URL(process.env.DATABASE_URL);
const dbUsername = decodeURIComponent(localDatabaseUrl.username);
const dbPassword = decodeURIComponent(localDatabaseUrl.password);
const dbName = decodeURIComponent(localDatabaseUrl.pathname.replace(/^\//, ''));
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbUsername)) {
  throw new Error('The configured database username is not a safe PostgreSQL identifier.');
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
  throw new Error('The configured database name is not a safe PostgreSQL identifier.');
}

const remoteDatabaseUrl = new URL(localDatabaseUrl.toString());
remoteDatabaseUrl.hostname = '127.0.0.1';
remoteDatabaseUrl.port = '5433';
remoteDatabaseUrl.search = '';
remoteDatabaseUrl.hash = '';

const { discoverRunpodSshEndpoint, formatRunpodConnection } = await import(
  '../apps/server/src/infrastructure/runpod-discovery.ts'
);
const { parseRunpodConnection, buildSshBaseArgs } = await import(
  '../apps/server/src/infrastructure/runpod-connection.ts'
);

const endpoint = await discoverRunpodSshEndpoint({
  apiKey: process.env.RUNPOD_API_KEY,
  podId: process.env.RUNPOD_ID,
});
if (!endpoint) throw new Error('The configured RunPod is not running with a public SSH endpoint.');

let identityFile;
try {
  identityFile = parseRunpodConnection(process.env.RUNPOD_CONNECTION).identityFile;
} catch {
  identityFile = process.env.RUNPOD_SSH_KEY_PATH?.trim() || undefined;
}
const connection = parseRunpodConnection(formatRunpodConnection(endpoint, identityFile));
const sshArgs = buildSshBaseArgs(connection);

function run(command, args, options = {}) {
  const { input, timeoutMs = 120_000, inherit = false, env = process.env, cwd } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      if (inherit) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (inherit) process.stderr.write(chunk);
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (result.code !== 0) {
        const detail = result.stderr.trim().slice(-1200) || `${command} exited ${result.code}`;
        reject(new Error(detail));
      } else resolvePromise(result);
    });
  });
}

function ssh(command, options = {}) {
  return run('ssh', [...sshArgs, command], options);
}

async function uploadSource() {
  const present = (await ssh(`test -d ${APP_ROOT} && printf present || printf absent`)).stdout.trim() === 'present';
  if (present && !syncRequested) {
    console.log('source          existing persistent worktree preserved');
    return;
  }

  console.log('source          uploading current worktree');
  const stage = `${APP_ROOT}.uploading`;
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const remoteCommand = present
    ? `rm -rf -- ${stage} && install -d -m 755 ${stage} && tar -xzf - -C ${stage} && ` +
      `{ test ! -d ${APP_ROOT}/node_modules || mv ${APP_ROOT}/node_modules ${stage}/node_modules; } && ` +
      `mv ${APP_ROOT} ${APP_ROOT}.backup-${timestamp} && mv ${stage} ${APP_ROOT}`
    : `rm -rf -- ${stage} && install -d -m 755 ${stage} && tar -xzf - -C ${stage} && mv ${stage} ${APP_ROOT}`;

  const remote = spawn('ssh', [...sshArgs, remoteCommand], {
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  const archive = spawn('tar', [
    '-czf', '-',
    '--exclude=./node_modules', '--exclude=*/node_modules',
    '--exclude=./.pnpm-store', '--exclude=*/.pnpm-store',
    '--exclude=./coverage', '--exclude=*/coverage',
    '--exclude=*/dist', '--exclude=*/build', '--exclude=*/.cache',
    '--exclude=./.env', '--exclude=./.env.backup*', '--exclude=*.log',
    '--exclude=./scripts/.runpod_exec.out',
    '.',
  ], { cwd: localRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  archive.stdout.pipe(remote.stdin);

  const archiveErrors = [];
  const remoteErrors = [];
  archive.stderr.on('data', (chunk) => archiveErrors.push(chunk));
  remote.stderr.on('data', (chunk) => remoteErrors.push(chunk));
  const [archiveCode, remoteCode] = await Promise.all([
    new Promise((done, fail) => { archive.once('error', fail); archive.once('close', done); }),
    new Promise((done, fail) => { remote.once('error', fail); remote.once('close', done); }),
  ]);
  if (archiveCode !== 0 || remoteCode !== 0) {
    throw new Error(
      Buffer.concat([...archiveErrors, ...remoteErrors]).toString('utf8').trim().slice(-1600) ||
      `Source upload failed (tar ${archiveCode}, ssh ${remoteCode}).`,
    );
  }
}

function envValue(value) {
  return JSON.stringify(String(value ?? ''));
}

async function writeProtectedRemote(path, content) {
  await ssh(
    `install -d -m 700 ${CONFIG_ROOT} && umask 077 && tee ${path} >/dev/null && chmod 600 ${path}`,
    { input: content },
  );
}

await uploadSource();

const remoteEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key] ?? '']));
Object.assign(remoteEnv, {
  NODE_ENV: 'production',
  DATABASE_URL: remoteDatabaseUrl.toString(),
  DACAI_SERVER_HOST: '127.0.0.1',
  PORT: '3101',
  WEB_PORT: '4173',
  ROUTING_POLICY: 'gpu-preferred',
  OLLAMA_LOCAL_BASE_URL: 'http://127.0.0.1:11434',
  OLLAMA_REMOTE_ENABLED: 'true',
  OLLAMA_REMOTE_BASE_URL: 'http://127.0.0.1:11434',
  OLLAMA_REMOTE_TRANSPORT: 'loopback',
  RUNPOD_LOCAL_OLLAMA_PORT: '11434',
  RUNPOD_OLLAMA_MODEL: 'qwen3-coder:30b',
  RUNPOD_CONNECTION: '',
  RUNPOD_SSH_KEY_PATH: '',
  DACAI_IMAGE_BACKEND: 'dacais-media',
  DACAI_VIDEO_BACKEND: 'dacais-media',
  DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:8090',
  DACAI_MEDIA_TRANSPORT: 'loopback',
  DACAI_MEDIA_AUTOSTART: 'false',
  ALLOWED_WORKSPACE_ROOTS: APP_ROOT,
  MAX_LOCAL_WORKERS: '1',
  MAX_CONCURRENT_MODEL_REQUESTS: '1',
});
const envText = Object.entries(remoteEnv)
  .filter(([key]) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}=${envValue(value)}`)
  .join('\n') + '\n';

const dbConfig = JSON.stringify({
  username: dbUsername,
  password: dbPassword,
  database: dbName,
  localWorkspaceRoot: localRoot,
  remoteWorkspaceRoot: APP_ROOT,
});
await writeProtectedRemote(`${CONFIG_ROOT}/app.env`, envText);
await writeProtectedRemote(`${CONFIG_ROOT}/db-config.json`, dbConfig);
await ssh(
  `rm -f -- ${APP_ROOT}/.env ${RUNTIME_ROOT}/db-config.json && ` +
    `ln -s ${CONFIG_ROOT}/app.env ${APP_ROOT}/.env && ` +
    `for directory in /workspace/dacai-app.backup-*; do ` +
      `test ! -d \"$directory\" || rm -f -- \"$directory/.env\"; ` +
    `done`,
);
console.log('configuration   protected same-pod environment installed');

console.log('bootstrap       installing persistent Node/pnpm and PostgreSQL runtime');
await ssh(`bash ${APP_ROOT}/deploy/runpod-native/bootstrap.sh`, {
  timeoutMs: 2_700_000,
  inherit: true,
});

const restored = (await ssh(`test -f ${PG_ROOT}/.local-db-restored && printf yes || printf no`)).stdout.trim() === 'yes';
if (!restored || refreshDatabase) {
  const pgDumpCandidates = [
    'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
  ];
  const pgDump = pgDumpCandidates.find(existsSync);
  if (!pgDump) throw new Error('A local pg_dump binary was not found.');

  console.log('database        streaming local PostgreSQL snapshot to persistent storage');
  const remoteDump = `${PG_ROOT}/incoming-local.dump`;
  const receiver = spawn('ssh', [...sshArgs, `umask 077 && tee ${remoteDump} >/dev/null`], {
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  const dump = spawn(pgDump, [
    '--format=custom', '--no-privileges',
    '--host', localDatabaseUrl.hostname,
    '--port', localDatabaseUrl.port || '5432',
    '--username', dbUsername,
    '--dbname', dbName,
  ], {
    windowsHide: true,
    env: { ...process.env, PGPASSWORD: dbPassword },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dump.stdout.pipe(receiver.stdin);
  const dumpErrors = [];
  const receiverErrors = [];
  dump.stderr.on('data', (chunk) => dumpErrors.push(chunk));
  receiver.stderr.on('data', (chunk) => receiverErrors.push(chunk));
  const [dumpCode, receiverCode] = await Promise.all([
    new Promise((done, fail) => { dump.once('error', fail); dump.once('close', done); }),
    new Promise((done, fail) => { receiver.once('error', fail); receiver.once('close', done); }),
  ]);
  if (dumpCode !== 0 || receiverCode !== 0) {
    throw new Error(
      Buffer.concat([...dumpErrors, ...receiverErrors]).toString('utf8').trim().slice(-1600) ||
      `Database snapshot failed (pg_dump ${dumpCode}, ssh ${receiverCode}).`,
    );
  }

  await ssh(
    `runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_restore ` +
      `-h /var/run/postgresql -p 5433 -d ${dbName} ` +
      `--clean --if-exists --no-privileges --exit-on-error ${remoteDump}`,
    { timeoutMs: 900_000, inherit: true },
  );
  await ssh(`bash ${APP_ROOT}/deploy/runpod-native/post-restore.sh`, {
    timeoutMs: 600_000,
    inherit: true,
  });
} else {
  console.log('database        existing persistent RunPod database preserved');
}

console.log('services        starting the complete same-pod stack');
await ssh(`bash ${APP_ROOT}/deploy/runpod-native/start.sh`, {
  timeoutMs: 420_000,
  inherit: true,
});

async function remoteJson(url) {
  const response = await ssh(`curl -fsS --max-time 30 ${url}`);
  return JSON.parse(response.stdout);
}

const [health, gpu, media, tags, workspaces] = await Promise.all([
  remoteJson('http://127.0.0.1:3101/health'),
  remoteJson('http://127.0.0.1:3101/api/infrastructure/gpu-routing?refresh=1'),
  remoteJson('http://127.0.0.1:3101/api/infrastructure/media/status'),
  remoteJson('http://127.0.0.1:11434/api/tags'),
  remoteJson('http://127.0.0.1:3101/api/workspaces'),
]);
await ssh('curl -fsS --max-time 30 http://127.0.0.1:4173/ >/dev/null');

const installedTags = new Set(tags.models.map((model) => model.name));
const requiredTags = [
  'qwen3-coder:30b',
  'qwen3:8b',
  'huihui_ai/qwen3-abliterated:8b',
  'phi3:mini',
  'phi4-mini:latest',
  'nomic-embed-text:latest',
];
const missingTags = requiredTags.filter((model) => !installedTags.has(model));
if (health.status !== 'ok') throw new Error('The remote DACAIS health endpoint is not healthy.');
if (!gpu.availability?.usable) {
  throw new Error(`GPU routing is not usable: ${gpu.detail ?? gpu.availability?.reason ?? 'unknown reason'}`);
}
if (!media.ready) throw new Error(`Media is not ready: ${media.error ?? media.phase}`);
if (missingTags.length) throw new Error(`RunPod is missing required models: ${missingTags.join(', ')}`);
if (!workspaces.workspaces.some((workspace) => workspace.rootPath === APP_ROOT)) {
  throw new Error(`The migrated workspace was not remapped to ${APP_ROOT}.`);
}

console.log(`verified        API=${health.status}, GPU=${gpu.availability.usable}, media=${media.ready}`);
console.log(`models          ${requiredTags.join(', ')}`);
console.log(`workspace       ${APP_ROOT}`);
console.log('next            establish an SSH-only local tunnel to web 4173 and API 3101');
