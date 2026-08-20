import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { redactDeep } from './redaction.js';
import type {
  KillSwitchState,
  KillSwitchStateStore,
  LiveValidationAuditEvent,
  LiveValidationAuditSink,
} from './live-validation-types.js';

function redactAuditValue<T>(value: T): T {
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactAuditValue(item)]),
    ) as T;
  }
  return redactDeep(value);
}

export class InMemoryLiveValidationAuditSink implements LiveValidationAuditSink {
  readonly events: LiveValidationAuditEvent[] = [];

  async record(event: LiveValidationAuditEvent): Promise<void> {
    this.events.push(redactAuditValue(structuredClone(event)));
  }
}

/** Append-only, redacted JSONL audit records for production-style validation. */
export class JsonlLiveValidationAuditSink implements LiveValidationAuditSink {
  constructor(private readonly path: string) {}

  async record(event: LiveValidationAuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const sanitized = redactAuditValue(event);
    await appendFile(this.path, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export class InMemoryKillSwitchStateStore implements KillSwitchStateStore {
  private state: KillSwitchState | null = null;

  async load(): Promise<KillSwitchState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: KillSwitchState): Promise<void> {
    this.state = structuredClone(state);
  }

  async clear(): Promise<void> {
    this.state = null;
  }
}

/** Durable latch: a process restart does not silently re-enable live actions. */
export class FileKillSwitchStateStore implements KillSwitchStateStore {
  private readonly configuredPath?: string;

  constructor(path?: string) {
    this.configuredPath = path;
  }

  get path(): string {
    // Resolve lazily because the server loads .env after ESM imports execute.
    return (
      this.configuredPath ||
      process.env.TOMAHAWK1_STOP_STATE_FILE ||
      resolve(process.cwd(), '.tomahawk', 'live-validation-stop.json')
    );
  }

  async load(): Promise<KillSwitchState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Omit<KillSwitchState, 'stoppedAt'> & {
        stoppedAt: string;
      };
      return { ...parsed, stoppedAt: new Date(parsed.stoppedAt) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(state: KillSwitchState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
