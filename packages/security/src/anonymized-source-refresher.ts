/**
 * Owns the periodic real refresh of AnonymizedSourceDetector's Tor/datacenter
 * feeds and exposes the current config to build a detector from. Failed
 * refreshes keep the last-known-good snapshot; the initial fetch happens once
 * at construction but a failure there does not throw — it starts from an
 * empty (not fabricated) snapshot and tries again on the next interval.
 */

import { DEFAULT_DETECTION_CONFIG } from './anonymized-source-detector.js';
import { refreshAnonymizedSourceFeeds, type AnonymizedSourceFeedSnapshot } from './anonymized-source-feeds.js';
import type { AnonymizedSourceDetectionConfig } from './defensive-testing-types.js';

export interface AnonymizedSourceRefresherOptions {
  intervalMs?: number;
  onRefresh?: (snapshot: AnonymizedSourceFeedSnapshot) => void;
  onWarning?: (warning: string) => void;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours — this data changes slowly.

export class AnonymizedSourceFeedRefresher {
  private snapshot: AnonymizedSourceFeedSnapshot | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;

  constructor(private readonly options: AnonymizedSourceRefresherOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** Real fetch, real (bounded) refresh interval — matches the codebase's one existing
   *  setInterval+.unref() precedent (LiveValidationSafetyController.startMonitor). */
  async start(): Promise<void> {
    await this.refreshOnce();
    this.timer = setInterval(() => {
      void this.refreshOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async refreshOnce(): Promise<void> {
    const next = await refreshAnonymizedSourceFeeds(this.snapshot);
    this.snapshot = next;
    for (const warning of next.warnings) this.options.onWarning?.(warning);
    this.options.onRefresh?.(next);
  }

  /** A fresh config object reflecting the latest fetched feeds, for building a detector. */
  getConfig(): AnonymizedSourceDetectionConfig {
    return {
      ...DEFAULT_DETECTION_CONFIG,
      knownTorExitNodes: this.snapshot?.torExitNodes ?? [],
      knownDatacenterRanges: this.snapshot?.datacenterRanges ?? [],
    };
  }

  getSnapshot(): AnonymizedSourceFeedSnapshot | null {
    return this.snapshot;
  }
}
