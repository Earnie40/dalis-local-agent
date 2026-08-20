export interface ServerStatus {
  ok: boolean;
  service: string;
  uptimeMs: number;
}

export function createServerStatus(): ServerStatus {
  return {
    ok: true,
    service: 'dacai-local-agent-server',
    uptimeMs: Date.now(),
  };
}
