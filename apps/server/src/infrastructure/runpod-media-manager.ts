import { spawn, type ChildProcess } from 'node:child_process';
import { resolveMediaConnection, type MediaTransport } from '@dacai-local-agent/tools';
import { buildSshBaseArgs, buildSshTunnelArgs, parseRunpodConnection, type RunpodConnection } from './runpod-connection';
import { discoverRunpodSshEndpoint, formatRunpodConnection, type RunpodSshEndpoint } from './runpod-discovery';
import { defaultRunCommand, type RunCommand } from './runpod-service';

export type MediaPhase =
  | 'disabled' | 'initializing' | 'starting-pod' | 'waiting-for-ssh'
  | 'starting-service' | 'connecting-tunnel' | 'ready' | 'error';

export interface RunpodMediaStatus {
  configured: boolean;
  ready: boolean;
  phase: MediaPhase;
  transport?: MediaTransport;
  autoStart: boolean;
  pod?: { id: string; name?: string; connected: boolean };
  service: { healthy: boolean; imageModel: boolean; videoModel: boolean };
  error?: string;
  checkedAt: string;
}

export interface RunpodMediaManagerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runCommand?: RunCommand;
  resolveEndpoint?: () => Promise<RunpodSshEndpoint | undefined>;
  spawnTunnel?: (command: string, args: string[]) => ChildProcess;
  sleep?: (milliseconds: number) => Promise<void>;
  startupPollMs?: number;
  startupAttempts?: number;
  sshAttempts?: number;
  monitorIntervalMs?: number;
}

const RUNPOD_V2 = 'https://api.runpod.io/v2';

function now(): string { return new Date().toISOString(); }
function enabled(value: string | undefined): boolean { return /^(1|true|yes|on)$/i.test(value?.trim() ?? ''); }
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

export async function startRunpodPod(options: {
  apiKey?: string; podId?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<void> {
  const apiKey = options.apiKey?.trim();
  const podId = options.podId?.trim();
  if (!apiKey || !podId) throw new Error('RUNPOD_API_KEY and RUNPOD_ID are required to auto-start media.');
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(podId)) throw new Error('RUNPOD_ID is invalid.');
  const response = await (options.fetchImpl ?? fetch)(`${RUNPOD_V2}/pods/${encodeURIComponent(podId)}/action`, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ action: 'start' }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  // Starting an already-starting pod is harmless; the readiness loop below is authoritative.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Runpod rejected the pod start request (HTTP ${response.status}).`);
  }
}

/** Supervises the DACAIS media connection for both local development and production. */
export class RunpodMediaManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly runCommand: RunCommand;
  private readonly resolveEndpoint: () => Promise<RunpodSshEndpoint | undefined>;
  private readonly spawnTunnel: (command: string, args: string[]) => ChildProcess;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly startupPollMs: number;
  private readonly startupAttempts: number;
  private readonly sshAttempts: number;
  private readonly monitorIntervalMs: number;
  private state: RunpodMediaStatus;
  private connection?: RunpodConnection;
  private tunnel?: ChildProcess;
  private initializing?: Promise<RunpodMediaStatus>;
  private monitor?: NodeJS.Timeout;
  private startRequested = false;
  private stopped = false;

  constructor(options: RunpodMediaManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.resolveEndpoint = options.resolveEndpoint ?? (() => discoverRunpodSshEndpoint({
      apiKey: this.env.RUNPOD_API_KEY, podId: this.env.RUNPOD_ID,
    }));
    this.spawnTunnel = options.spawnTunnel ?? ((command, args) => spawn(command, args, {
      shell: false, windowsHide: true, stdio: 'ignore',
    }));
    this.sleep = options.sleep ?? wait;
    this.startupPollMs = options.startupPollMs ?? 5_000;
    this.startupAttempts = options.startupAttempts ?? 120;
    this.sshAttempts = options.sshAttempts ?? 60;
    this.monitorIntervalMs = options.monitorIntervalMs ?? 15_000;
    const configured = this.mediaEnabled();
    this.state = {
      configured,
      ready: false,
      phase: configured ? 'initializing' : 'disabled',
      autoStart: enabled(this.env.DACAI_MEDIA_AUTOSTART),
      service: { healthy: false, imageModel: false, videoModel: false },
      checkedAt: now(),
    };
  }

  private mediaEnabled(): boolean {
    return this.env.DACAI_IMAGE_BACKEND?.trim().toLowerCase() === 'dacais-media'
      || this.env.DACAI_VIDEO_BACKEND?.trim().toLowerCase() === 'dacais-media';
  }

  status(): RunpodMediaStatus { return structuredClone(this.state); }

  /**
   * Image requests must not wait for an unrelated video model to warm up.
   * The normal supervisor still tracks readiness for every configured backend.
   */
  async ensureImageReady(): Promise<RunpodMediaStatus> {
    let media;
    try { media = resolveMediaConnection(this.env); }
    catch { return this.initialize(); }

    let health = await this.health(media.baseUrl, media.headers);
    if (health.healthy && health.imageModel) {
      return { ...this.status(), ready: true, service: health, error: undefined, checkedAt: now() };
    }

    void this.initialize();
    const attempts = Math.min(this.startupAttempts, 24);
    for (let attempt = 0; attempt < attempts && !this.stopped; attempt += 1) {
      await this.sleep(this.startupPollMs);
      health = await this.health(media.baseUrl, media.headers);
      if (health.healthy && health.imageModel) {
        return { ...this.status(), ready: true, service: health, error: undefined, checkedAt: now() };
      }
    }

    const status = this.status();
    return {
      ...status,
      ready: false,
      service: health,
      error: status.error ?? 'The media endpoint did not advertise an image model before the startup timeout.',
      checkedAt: now(),
    };
  }

  start(): void {
    if (!this.state.configured || this.monitor) return;
    this.stopped = false;
    void this.initialize();
    this.monitor = setInterval(() => void this.monitorOnce(), this.monitorIntervalMs);
    this.monitor.unref?.();
  }

  async initialize(): Promise<RunpodMediaStatus> {
    if (!this.state.configured || this.stopped) return this.status();
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce()
      .catch((error) => {
        this.state = {
          ...this.state, ready: false, phase: 'error',
          service: { healthy: false, imageModel: false, videoModel: false },
          error: error instanceof Error ? error.message : 'Media initialization failed.', checkedAt: now(),
        };
        return this.status();
      })
      .finally(() => { this.initializing = undefined; });
    return this.initializing;
  }

  private update(patch: Partial<RunpodMediaStatus>): void {
    this.state = { ...this.state, ...patch, checkedAt: now() };
  }

  private async initializeOnce(): Promise<RunpodMediaStatus> {
    const media = resolveMediaConnection(this.env);
    this.update({ phase: 'initializing', transport: media.transport, error: undefined });
    if (media.transport === 'https' || media.transport === 'loopback') {
      let health = await this.health(media.baseUrl, media.headers);
      if (!health.healthy) {
        throw new Error(
          media.transport === 'loopback'
            ? 'The same-host media loopback endpoint is not healthy.'
            : 'The production media HTTPS endpoint is not healthy.',
        );
      }
      health = await this.waitForConfiguredModels(media.baseUrl, media.headers, health);
      this.requireConfiguredModels(health);
      this.markReady(health);
      return this.status();
    }

    const endpoint = await this.runningEndpoint();
    this.update({ pod: { id: endpoint.podId, name: endpoint.name, connected: false } });
    const identityFile = this.identityFile();
    this.connection = parseRunpodConnection(formatRunpodConnection(endpoint, identityFile));
    this.update({ phase: 'waiting-for-ssh' });
    let connected = false;
    for (let attempt = 0; attempt < this.sshAttempts && !this.stopped; attempt += 1) {
      const probe = await this.remote('printf DACAIS_MEDIA_SSH_READY', 15_000);
      if (probe.code === 0 && probe.stdout.trim() === 'DACAIS_MEDIA_SSH_READY') { connected = true; break; }
      await this.sleep(this.startupPollMs);
    }
    if (!connected) throw new Error('The Runpod started, but its SSH service did not become ready.');
    this.update({ pod: { id: endpoint.podId, name: endpoint.name, connected: true }, phase: 'starting-service' });

    const remoteReady = await this.remote(
      "test -x /workspace/dacais-media/run-media.sh || exit 2; " +
      "curl -fsS --max-time 3 http://127.0.0.1:8090/v1/health >/dev/null 2>&1 || " +
      "setsid /workspace/dacais-media/run-media.sh > /workspace/dacais-media/logs/media-service.log 2>&1 < /dev/null & " +
      "for i in $(seq 1 60); do curl -fsS --max-time 2 http://127.0.0.1:8090/v1/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1",
      70_000,
    );
    if (remoteReady.code === 2) {
      throw new Error('The pod is missing /workspace/dacais-media/run-media.sh; bootstrap the persistent media volume first.');
    }
    if (remoteReady.code !== 0) throw new Error('The media service did not become healthy on the Runpod.');

    this.update({ phase: 'connecting-tunnel' });
    let localHealth = await this.ensureTunnel(media.baseUrl, media.headers);
    if (!localHealth.healthy) throw new Error('The managed media SSH tunnel did not become healthy.');
    localHealth = await this.waitForConfiguredModels(media.baseUrl, media.headers, localHealth);
    this.requireConfiguredModels(localHealth);
    this.startRequested = false;
    this.markReady(localHealth);
    return this.status();
  }

  private async runningEndpoint(): Promise<RunpodSshEndpoint> {
    let endpoint = await this.resolveEndpoint();
    if (endpoint) return endpoint;
    if (!this.state.autoStart) throw new Error('No running media pod was found and DACAI_MEDIA_AUTOSTART is disabled.');
    if (!this.startRequested) {
      this.update({ phase: 'starting-pod' });
      await startRunpodPod({ apiKey: this.env.RUNPOD_API_KEY, podId: this.env.RUNPOD_ID, fetchImpl: this.fetchImpl });
      this.startRequested = true;
    }
    this.update({ phase: 'waiting-for-ssh', pod: this.env.RUNPOD_ID ? { id: this.env.RUNPOD_ID, connected: false } : undefined });
    for (let attempt = 0; attempt < this.startupAttempts && !this.stopped; attempt += 1) {
      await this.sleep(this.startupPollMs);
      endpoint = await this.resolveEndpoint();
      if (endpoint) return endpoint;
    }
    throw new Error('The Runpod did not expose a public TCP SSH endpoint before the startup timeout.');
  }

  private identityFile(): string | undefined {
    try { return parseRunpodConnection(this.env.RUNPOD_CONNECTION).identityFile ?? this.env.RUNPOD_SSH_KEY_PATH?.trim(); }
    catch { return this.env.RUNPOD_SSH_KEY_PATH?.trim(); }
  }

  private async remote(command: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this.connection) return { code: -1, stdout: '', stderr: '' };
    return this.runCommand('ssh', [...buildSshBaseArgs(this.connection), command], timeoutMs);
  }

  private async ensureTunnel(baseUrl: string, headers: Record<string, string>): Promise<HealthResult> {
    const existing = await this.health(baseUrl, headers);
    if (existing.healthy) return existing;
    this.tunnel?.kill();
    const localPort = Number(new URL(baseUrl).port || (baseUrl.startsWith('https:') ? 443 : 80));
    const remotePort = Number(this.env.DACAI_MEDIA_REMOTE_PORT ?? 8090);
    if (!this.connection) return { healthy: false, imageModel: false, videoModel: false };
    this.tunnel = this.spawnTunnel('ssh', buildSshTunnelArgs(this.connection, localPort, remotePort));
    this.tunnel.once('exit', () => { this.tunnel = undefined; });
    for (let attempt = 0; attempt < 40 && !this.stopped; attempt += 1) {
      await this.sleep(250);
      const result = await this.health(baseUrl, headers);
      if (result.healthy) return result;
      if (!this.tunnel || this.tunnel.exitCode !== null) break;
    }
    this.tunnel?.kill();
    this.tunnel = undefined;
    return { healthy: false, imageModel: false, videoModel: false };
  }

  private async health(baseUrl: string, headers: Record<string, string>): Promise<HealthResult> {
    try {
      const response = await this.fetchImpl(`${baseUrl}/v1/health`, {
        method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return { healthy: false, imageModel: false, videoModel: false };
      const body = await response.json() as { backdropModel?: unknown; backdropVideoModel?: unknown };
      return { healthy: true, imageModel: typeof body.backdropModel === 'string', videoModel: typeof body.backdropVideoModel === 'string' };
    } catch { return { healthy: false, imageModel: false, videoModel: false }; }
  }

  private markReady(health: HealthResult): void {
    this.update({ ready: true, phase: 'ready', service: health, error: undefined });
  }

  private configuredModelsReady(health: HealthResult): boolean {
    const imageRequired = this.env.DACAI_IMAGE_BACKEND?.trim().toLowerCase() === 'dacais-media';
    const videoRequired = this.env.DACAI_VIDEO_BACKEND?.trim().toLowerCase() === 'dacais-media';
    return (!imageRequired || health.imageModel) && (!videoRequired || health.videoModel);
  }

  /** A healthy process may still be loading diffusion weights; wait for the advertised model. */
  private async waitForConfiguredModels(
    baseUrl: string,
    headers: Record<string, string>,
    initial: HealthResult,
  ): Promise<HealthResult> {
    let health = initial;
    const attempts = Math.min(this.startupAttempts, 24);
    for (let attempt = 0; attempt < attempts && !this.stopped; attempt += 1) {
      if (this.configuredModelsReady(health)) return health;
      this.update({ phase: 'starting-service', service: health });
      await this.sleep(this.startupPollMs);
      health = await this.health(baseUrl, headers);
    }
    return health;
  }

  private requireConfiguredModels(health: HealthResult): void {
    if (!this.configuredModelsReady(health)) {
      const imageRequired = this.env.DACAI_IMAGE_BACKEND?.trim().toLowerCase() === 'dacais-media';
      if (imageRequired && !health.imageModel) throw new Error('The media endpoint is healthy, but its image model is unavailable.');
      throw new Error('The media endpoint is healthy, but its video model is unavailable.');
    }
  }

  private async monitorOnce(): Promise<void> {
    if (this.initializing || !this.state.configured || this.stopped) return;
    let media;
    try { media = resolveMediaConnection(this.env); }
    catch { await this.initialize(); return; }
    const health = await this.health(media.baseUrl, media.headers);
    if (health.healthy) {
      try { this.requireConfiguredModels(health); this.markReady(health); return; }
      catch { /* Reinitialize below so the UI reports the missing model. */ }
    }
    this.update({ ready: false, phase: 'initializing', service: health });
    this.tunnel?.kill();
    this.tunnel = undefined;
    await this.initialize();
  }

  stop(): void {
    this.stopped = true;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    this.tunnel?.kill();
    this.tunnel = undefined;
  }
}

interface HealthResult { healthy: boolean; imageModel: boolean; videoModel: boolean }
