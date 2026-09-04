import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import {
  buildSshBaseArgs,
  buildSshTunnelArgs,
  parseRunpodConnection,
  type RunpodConnection,
} from './runpod-connection';
import {
  discoverRunpodSshEndpoint,
  formatRunpodConnection,
  type RunpodSshEndpoint,
} from './runpod-discovery';

interface CommandResult { code: number; stdout: string; stderr: string }
export type RunCommand = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

export interface RunpodStatus {
  configured: boolean;
  connected: boolean;
  tunnelHealthy: boolean;
  gpu: { detected: boolean; model?: string; vramMb?: number; driver?: string };
  cuda?: string;
  python?: string;
  ollama: { installed: boolean; version?: string };
  docker: { installed: boolean; version?: string };
  dacaisServiceRunning: boolean;
  inference: { ollama: boolean; endpointHealthy: boolean; models: string[] };
  error?: string;
}

const EMPTY_STATUS: RunpodStatus = {
  configured: false,
  connected: false,
  tunnelHealthy: false,
  gpu: { detected: false },
  ollama: { installed: false },
  docker: { installed: false },
  dacaisServiceRunning: false,
  inference: { ollama: false, endpointHealthy: false, models: [] },
};

export const defaultRunCommand: RunCommand = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk).slice(0, 16_384); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk).slice(0, 4_096); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });

function cleanVersion(value: string): string | undefined {
  const first = value.trim().split(/\r?\n/, 1)[0]?.trim();
  return first ? first.slice(0, 160) : undefined;
}

export function parseNvidiaSmi(value: string): RunpodStatus['gpu'] {
  const [model, memory, driver] = value.trim().split(',').map((part) => part.trim());
  const vramMb = Number(memory);
  if (!model || !Number.isFinite(vramMb)) return { detected: false };
  return { detected: true, model: model.slice(0, 120), vramMb, driver: driver?.slice(0, 80) };
}

/** Resolves the SSH endpoint of whichever pod is currently running. */
export type EndpointResolver = () => Promise<RunpodSshEndpoint | undefined>;

const defaultEndpointResolver: EndpointResolver = () =>
  discoverRunpodSshEndpoint({ apiKey: process.env.RUNPOD_API_KEY, podId: process.env.RUNPOD_ID });

export class RunpodService {
  private connection?: RunpodConnection;
  private configurationError?: string;
  private tunnel?: ChildProcess;
  private lastEndpoint?: RunpodSshEndpoint;

  constructor(
    connectionValue = process.env.RUNPOD_CONNECTION,
    private readonly localPort = Number(process.env.RUNPOD_LOCAL_OLLAMA_PORT ?? 11435),
    private readonly runCommand: RunCommand = defaultRunCommand,
    private readonly resolveEndpoint: EndpointResolver = defaultEndpointResolver,
  ) {
    try { this.connection = parseRunpodConnection(connectionValue); }
    catch (error) {
      this.configurationError = error instanceof Error ? error.message : 'RunPod configuration is invalid.';
    }
  }

  /**
   * The endpoint in use, rendered back as a RUNPOD_CONNECTION value so a caller
   * can persist it after rediscovery moved the pod.
   */
  connectionString(): string | undefined {
    if (!this.connection) return undefined;
    const { username, hostname, port, identityFile } = this.connection;
    const base = `ssh ${username}@${hostname} -p ${port}`;
    return identityFile ? `${base} -i ${identityFile}` : base;
  }

  /** The pod resolved by the most recent rediscovery, if any. */
  discoveredEndpoint(): RunpodSshEndpoint | undefined {
    return this.lastEndpoint;
  }

  /**
   * Re-resolve the pod's SSH endpoint. RunPod issues a new public host and port
   * on every start, so a stored connection going stale is the ordinary case
   * rather than an exceptional one.
   */
  private async rediscover(): Promise<boolean> {
    const endpoint = await this.resolveEndpoint();
    if (!endpoint) return false;

    const identityFile = this.connection?.identityFile ?? process.env.RUNPOD_SSH_KEY_PATH?.trim();
    try {
      this.connection = parseRunpodConnection(formatRunpodConnection(endpoint, identityFile));
      this.configurationError = undefined;
      this.lastEndpoint = endpoint;
      return true;
    } catch {
      return false;
    }
  }

  private async handshakeOnce(): Promise<boolean> {
    if (!this.connection) return false;
    const result = await this.remote('printf DACAIS_RUNPOD_READY');
    return result.code === 0 && result.stdout.trim() === 'DACAIS_RUNPOD_READY';
  }

  /** Handshake, re-resolving the endpoint once when the stored one is stale. */
  private async handshake(): Promise<boolean> {
    if (await this.handshakeOnce()) return true;
    if (!(await this.rediscover())) return false;
    return this.handshakeOnce();
  }

  private sshArgs(remoteCommand?: string): string[] {
    if (!this.connection) return [];
    const args = buildSshBaseArgs(this.connection);
    if (remoteCommand) args.push(remoteCommand);
    return args;
  }

  private async remote(command: string, timeoutMs = 15_000): Promise<CommandResult> {
    return this.runCommand('ssh', this.sshArgs(command), timeoutMs);
  }

  /**
   * Restore the persistent pod-side Ollama service after a container restart,
   * then establish its local-only SSH tunnel. This is an infrastructure startup
   * action; the read-only status endpoint does not invoke it.
   */
  async initialize(): Promise<RunpodStatus> {
    if (!(await this.handshake())) return this.status();
    const ready = await this.remote('curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1');
    if (ready.code !== 0) {
      const started = await this.remote(
        'test -x /workspace/ollama/run-ollama.sh || exit 1; ' +
        'setsid /workspace/ollama/run-ollama.sh > /workspace/ollama/logs/serve.log 2>&1 < /dev/null &',
      );
      if (started.code === 0) {
        await this.remote(
          'for i in $(seq 1 45); do ' +
          'curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && exit 0; ' +
          'sleep 1; done; exit 1',
          50_000,
        );
      }
    }
    return this.status();
  }

  async status(): Promise<RunpodStatus> {
    if (!(await this.handshake())) {
      return this.connection
        ? { ...EMPTY_STATUS, configured: true, error: 'RunPod SSH connection failed.' }
        : { ...EMPTY_STATUS, error: this.configurationError };
    }

    const [gpu, cuda, python, ollama, ollamaApi, docker, dacais] = await Promise.all([
      this.remote('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits'),
      this.remote("nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: \\([^ ]*\\).*/\\1/p' | head -n 1"),
      this.remote('python3 --version 2>&1 || python --version 2>&1'),
      this.remote(
        'if command -v ollama >/dev/null 2>&1; then ollama --version; ' +
        'elif [ -x /workspace/ollama/bin/ollama ]; then /workspace/ollama/bin/ollama --version; else exit 1; fi',
      ),
      this.remote('curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1'),
      this.remote('command -v docker >/dev/null 2>&1 && docker --version'),
      this.remote("pgrep -f '[d]acai' >/dev/null 2>&1"),
    ]);

    const ollamaInstalled = ollama.code === 0;
    const ollamaServing = ollamaApi.code === 0;
    let tunnelHealthy = false;
    let models: string[] = [];
    if (ollamaServing) {
      tunnelHealthy = await this.ensureTunnel();
      if (tunnelHealthy) models = await this.fetchModels();
    }

    return {
      configured: true,
      connected: true,
      tunnelHealthy,
      gpu: gpu.code === 0 ? parseNvidiaSmi(gpu.stdout) : { detected: false },
      cuda: cuda.code === 0 ? cleanVersion(cuda.stdout) : undefined,
      python: python.code === 0 ? cleanVersion(python.stdout) : undefined,
      ollama: { installed: ollamaInstalled, version: ollamaInstalled ? cleanVersion(ollama.stdout) : undefined },
      docker: { installed: docker.code === 0, version: docker.code === 0 ? cleanVersion(docker.stdout) : undefined },
      dacaisServiceRunning: dacais.code === 0,
      inference: { ollama: ollamaServing, endpointHealthy: tunnelHealthy, models },
    };
  }

  async ensureTunnel(): Promise<boolean> {
    if (!this.connection || !Number.isInteger(this.localPort) || this.localPort < 1 || this.localPort > 65535) return false;
    if (await this.endpointHealthy()) return true;
    if (this.tunnel && this.tunnel.exitCode === null) this.tunnel.kill();
    this.tunnel = spawn('ssh', buildSshTunnelArgs(this.connection, this.localPort), {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    this.tunnel.once('exit', () => { this.tunnel = undefined; });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await this.endpointHealthy()) return true;
      if (!this.tunnel || this.tunnel.exitCode !== null) break;
    }
    this.stop();
    return false;
  }

  private async endpointHealthy(): Promise<boolean> {
    const socketReachable = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: this.localPort });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (!socketReachable) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${this.localPort}/api/tags`, { signal: AbortSignal.timeout(1_500) });
      return response.ok;
    } catch { return false; }
  }

  private async fetchModels(): Promise<string[]> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.localPort}/api/tags`, { signal: AbortSignal.timeout(2_000) });
      const payload = await response.json() as { models?: Array<{ name?: unknown }> };
      return (payload.models ?? []).map((model) => model.name).filter((name): name is string => typeof name === 'string');
    } catch { return []; }
  }

  stop(): void {
    this.tunnel?.kill();
    this.tunnel = undefined;
  }
}
