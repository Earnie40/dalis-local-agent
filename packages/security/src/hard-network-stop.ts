import { spawn } from 'node:child_process';
import type { HardNetworkStopProvider, HardNetworkStopResult } from './live-validation-types.js';

export interface ProcessHardNetworkStopConfig {
  /** Trusted firewall/network-isolation executable; never interpreted by a shell. */
  executable: string;
  args: string[];
  timeoutMs: number;
}

/**
 * Invokes an independently privileged firewall/network containment helper.
 * The helper is configured by infrastructure and receives no untrusted shell text.
 */
export class ProcessHardNetworkStopProvider implements HardNetworkStopProvider {
  constructor(private readonly config: ProcessHardNetworkStopConfig) {
    if (!config.executable.trim()) throw new Error('HARD_NETWORK_STOP executable is required.');
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error('HARD_NETWORK_STOP timeout must be positive.');
    }
  }

  async isolate(reason: string): Promise<HardNetworkStopResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.executable, [...this.config.args, '--reason', reason], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const timer = setTimeout(() => child.kill(), this.config.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ isolated: true, details: Buffer.concat(stdout).toString('utf8').trim() });
        } else {
          reject(
            new Error(
              `HARD_NETWORK_STOP helper exited ${code ?? 'without a code'}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
            ),
          );
        }
      });
    });
  }
}
