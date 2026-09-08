import { spawn } from 'node:child_process';
import { isLoopbackUrl, type ProviderInstance } from '@dacai-local-agent/shared';

export type StartLocalOllama = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>;

export interface LocalOllamaLifecycleOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  startProcess?: StartLocalOllama;
  sleep?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const startDetachedOllama: StartLocalOllama = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    child.once('spawn', () => {
      settled = true;
      // Ollama is the workstation's inference daemon, not a disposable child of
      // the dev server. Leaving it detached avoids killing the local fallback on
      // every tsx-watch restart; an already-running daemon is never restarted.
      child.unref();
      resolve();
    });
    child.once('error', (error) => {
      if (!settled) reject(error);
    });
    child.once('exit', (code) => {
      if (!settled) reject(new Error(`Ollama exited during startup with code ${code ?? 'unknown'}.`));
    });
  });

/**
 * Makes a configured local Ollama endpoint a real fallback rather than only a
 * routing label. It starts only the installed local executable and only for a
 * loopback provider; Runpod and paid providers are outside this lifecycle.
 */
export class LocalOllamaLifecycle {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly startProcess: StartLocalOllama;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private inflight?: Promise<void>;

  constructor(options: LocalOllamaLifecycleOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.startProcess = options.startProcess ?? startDetachedOllama;
    this.sleep = options.sleep ?? wait;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1_000;
  }

  async ensureReady(instance: ProviderInstance): Promise<void> {
    if (instance.usageClass !== 'LOCAL_OLLAMA' || instance.kind !== 'ollama') return;
    if (!instance.baseUrl || !isLoopbackUrl(instance.baseUrl)) {
      throw new Error(`Local Ollama instance "${instance.id}" must use a loopback base URL.`);
    }
    if (await this.isReady(instance.baseUrl)) return;
    if (this.inflight) return this.inflight;

    this.inflight = this.startAndWait(instance).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async startAndWait(instance: ProviderInstance): Promise<void> {
    const baseUrl = instance.baseUrl as string;
    const executable = this.env.OLLAMA_EXECUTABLE?.trim() || 'ollama';
    const ollamaHost = new URL(baseUrl).host;

    try {
      await this.startProcess(executable, ['serve'], { ...this.env, OLLAMA_HOST: ollamaHost });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Local Ollama at ${baseUrl} is unavailable and "${executable} serve" could not be started: ${detail}`,
      );
    }

    const attempts = Math.max(1, Math.ceil(this.startupTimeoutMs / this.pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.isReady(baseUrl)) return;
      if (attempt + 1 < attempts) await this.sleep(this.pollIntervalMs);
    }

    throw new Error(
      `Local Ollama was started but ${baseUrl}/api/tags did not become ready within ${this.startupTimeoutMs} ms.`,
    );
  }

  private async isReady(baseUrl: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
