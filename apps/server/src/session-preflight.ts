const PREFLIGHT_INTERVAL_MS = 2 * 60 * 60 * 1000;

interface SessionState {
  lastActivityAt: number;
  lastPreflightAt: number;
}

const sessions = new Map<string, SessionState>();

/**
 * Cheap session boundary gate. It never calls a provider; it only decides
 * whether the next request should refresh the RunPod control-plane status.
 */
export function beginSessionActivity(key: string, now = Date.now()): { refreshPreflight: boolean; lastActivityAt?: string } {
  const previous = sessions.get(key);
  const refreshPreflight = !previous || now - previous.lastPreflightAt >= PREFLIGHT_INTERVAL_MS;
  sessions.set(key, {
    lastActivityAt: now,
    lastPreflightAt: refreshPreflight ? now : previous.lastPreflightAt,
  });
  return {
    refreshPreflight,
    lastActivityAt: previous ? new Date(previous.lastActivityAt).toISOString() : undefined,
  };
}

/** Update the activity clock after a model/tool run completes. */
export function touchSessionActivity(key: string, now = Date.now()): void {
  const previous = sessions.get(key);
  sessions.set(key, {
    lastActivityAt: now,
    lastPreflightAt: previous?.lastPreflightAt ?? now,
  });
}

export function sessionPreflightIntervalMs(): number {
  return PREFLIGHT_INTERVAL_MS;
}
