import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  delegationApi,
  type Schedule,
  type ScheduleKind,
  type TaskStatus,
  type TaskSummary,
  type WorkerRole,
  type Workspace,
} from './api';
import { useStickToBottom } from './use-stick-to-bottom';

/**
 * Create and supervise delegated agents.
 *
 * A run is either immediate or scheduled; both produce the same kind of task,
 * so the two forms share a role and workspace selection rather than being
 * separate screens.
 */

const REFRESH_MS = 5_000;

/** Statuses that can still change, and so are worth polling for. */
const LIVE_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting_for_user'];

const STATUS_TONE: Record<TaskStatus, string> = {
  completed: 'ok',
  running: 'ok',
  queued: '',
  blocked: 'warn',
  waiting_for_user: 'warn',
  // An interrupted task is not the agent's failure — its process ended — so it
  // is toned apart from a genuine failure rather than shown as an error.
  interrupted: 'warn',
  cancelled: '',
  failed: 'warn',
};

const INTERVAL_PRESETS = [
  { label: 'Every 15 minutes', seconds: 900 },
  { label: 'Every hour', seconds: 3600 },
  { label: 'Every 6 hours', seconds: 21_600 },
  { label: 'Every 24 hours', seconds: 86_400 },
];

function describeRecurrence(schedule: Schedule): string {
  if (schedule.kind === 'once') return 'Once';
  if (schedule.kind === 'daily') return 'Every day';
  const seconds = schedule.intervalSeconds ?? 0;
  const preset = INTERVAL_PRESETS.find((option) => option.seconds === seconds);
  if (preset) return preset.label;
  return seconds % 3600 === 0 ? `Every ${seconds / 3600}h` : `Every ${Math.round(seconds / 60)}m`;
}

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const deltaMs = date.getTime() - Date.now();
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  const relative =
    minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
  return `${date.toLocaleString()} (${deltaMs >= 0 ? `in ${relative}` : `${relative} ago`})`;
}

/** Datetime-local wants a local-time string, not the ISO/UTC form. */
function toLocalInputValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function DelegationPanel() {
  const [roles, setRoles] = useState<WorkerRole[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  const [role, setRole] = useState('repo-explorer');
  const [workspaceId, setWorkspaceId] = useState('');
  const [objective, setObjective] = useState('');
  const [when, setWhen] = useState<'now' | ScheduleKind>('now');
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const [firstRunAt, setFirstRunAt] = useState(() => toLocalInputValue(new Date(Date.now() + 5 * 60_000)));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const bodyScroll = useStickToBottom<HTMLDivElement>([tasks, schedules]);

  const selectedRole = useMemo(() => roles.find((entry) => entry.id === role), [roles, role]);

  const refresh = useCallback(async () => {
    try {
      const [taskList, scheduleList] = await Promise.all([delegationApi.tasks(), delegationApi.schedules()]);
      setTasks(taskList.tasks);
      setSchedules(scheduleList.schedules);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [roleList, workspaceList] = await Promise.all([delegationApi.roles(), delegationApi.workspaces()]);
        setRoles(roleList.roles);
        setWorkspaces(workspaceList.workspaces);
        if (workspaceList.workspaces.length > 0) setWorkspaceId((current) => current || workspaceList.workspaces[0].id);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    void refresh();
  }, [refresh]);

  // Poll only while something can still change, so an idle screen is quiet.
  const hasLiveWork = tasks.some((task) => LIVE_STATUSES.includes(task.status));
  useEffect(() => {
    if (!hasLiveWork && schedules.length === 0) return undefined;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasLiveWork, schedules.length, refresh]);

  async function act<T>(work: () => Promise<T>, success: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
      setNotice(success);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (!objective.trim() || !workspaceId) return;

    if (when === 'now') {
      void act(
        () => delegationApi.createTask({ objective, workspaceId, role }),
        'Task queued.',
      ).then(() => setObjective(''));
      return;
    }

    void act(
      () =>
        delegationApi.createSchedule({
          objective,
          role,
          workspaceId,
          kind: when,
          intervalSeconds: when === 'interval' ? intervalSeconds : undefined,
          firstRunAt: new Date(firstRunAt).toISOString(),
        }),
      'Schedule created.',
    ).then(() => setObjective(''));
  }

  return (
    <div className="intel-body" ref={bodyScroll.ref} onScroll={bodyScroll.onScroll}>
      <section className="intel-card">
        <h3>Delegate to an agent</h3>
        <p className="muted small">
          Work runs in the background and survives a restart: the task is written to the database before it starts,
          and is picked back up from there.
        </p>

        <form className="intel-form" onSubmit={submit}>
          <div className="intel-form-inline">
            <label className="field">
              <span className="muted small">Agent role</span>
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                {roles.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id} · {entry.alias} {entry.readOnly ? '(read-only)' : '(can edit)'}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="muted small">Workspace</span>
              <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selectedRole && (
            <p className="muted small">
              Runs on <strong>{selectedRole.alias}</strong>, up to {selectedRole.maxTurns} turns.{' '}
              {selectedRole.readOnly
                ? 'This role cannot modify files, regardless of workspace permissions.'
                : 'This role may modify files where the workspace allows it.'}
            </p>
          )}

          <label className="field">
            <span className="muted small">Objective</span>
            <textarea
              rows={3}
              value={objective}
              placeholder="What should the agent do? Be specific about scope and what counts as done."
              onChange={(event) => setObjective(event.target.value)}
            />
          </label>

          <div className="intel-form-inline">
            <label className="field">
              <span className="muted small">When</span>
              <select value={when} onChange={(event) => setWhen(event.target.value as typeof when)}>
                <option value="now">Run now</option>
                <option value="once">Once, at a set time</option>
                <option value="interval">Repeat on an interval</option>
                <option value="daily">Repeat daily</option>
              </select>
            </label>

            {when === 'interval' && (
              <label className="field">
                <span className="muted small">Frequency</span>
                <select
                  value={intervalSeconds}
                  onChange={(event) => setIntervalSeconds(Number(event.target.value))}
                >
                  {INTERVAL_PRESETS.map((preset) => (
                    <option key={preset.seconds} value={preset.seconds}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {when !== 'now' && (
              <label className="field">
                <span className="muted small">{when === 'once' ? 'Run at' : 'First run'}</span>
                <input
                  type="datetime-local"
                  value={firstRunAt}
                  onChange={(event) => setFirstRunAt(event.target.value)}
                />
              </label>
            )}
          </div>

          <button className="primary" type="submit" disabled={busy || !objective.trim() || !workspaceId}>
            {when === 'now' ? 'Run now' : 'Create schedule'}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
        {notice && <p className="muted small">{notice}</p>}
      </section>

      <section className="intel-card">
        <h3>Schedules</h3>
        {schedules.length === 0 ? (
          <p className="muted small">No schedules yet. Recurring work created above appears here.</p>
        ) : (
          <ul className="intel-list plain">
            {schedules.map((schedule) => (
              <li key={schedule.id}>
                <div className="intel-actions-row">
                  <strong>{schedule.name}</strong>
                  <span className={`badge ${schedule.enabled ? 'ok' : ''}`}>
                    {schedule.enabled ? 'enabled' : 'paused'}
                  </span>
                  <span className="badge">{describeRecurrence(schedule)}</span>
                  <span className="badge">{schedule.role}</span>
                </div>
                <p className="muted small">{schedule.objective}</p>
                <p className="muted small">
                  Next: {schedule.enabled ? formatWhen(schedule.nextRunAt) : 'paused'} · run {schedule.runCount}{' '}
                  {schedule.runCount === 1 ? 'time' : 'times'}
                  {schedule.lastRunAt ? ` · last ${formatWhen(schedule.lastRunAt)}` : ''}
                </p>
                <div className="intel-actions-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => delegationApi.updateSchedule(schedule.id, { enabled: !schedule.enabled }),
                        schedule.enabled ? 'Schedule paused.' : 'Schedule resumed.',
                      )
                    }
                  >
                    {schedule.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => delegationApi.runScheduleNow(schedule.id), 'Run queued.')}
                  >
                    Run now
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => delegationApi.deleteSchedule(schedule.id), 'Schedule deleted.')}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="intel-card">
        <h3>Recent tasks</h3>
        {tasks.length === 0 ? (
          <p className="muted small">Nothing delegated yet.</p>
        ) : (
          <ul className="intel-list plain">
            {tasks.slice(0, 20).map((task) => (
              <li key={task.id}>
                <div className="intel-actions-row">
                  <span className={`badge ${STATUS_TONE[task.status] ?? ''}`}>{task.status.replace(/_/g, ' ')}</span>
                  <span className="badge">{task.agentId}</span>
                  {task.scheduleId && <span className="badge">scheduled</span>}
                  <span className="muted small">{formatWhen(task.createdAt)}</span>
                </div>
                <p className="muted small">{task.objective}</p>
                {task.status === 'interrupted' && (
                  <p className="muted small">
                    The worker process ended before this finished. It was not run again automatically, because the
                    agent may already have made changes.
                  </p>
                )}
                {task.result && <p className="muted small">{task.result.slice(0, 300)}</p>}
                {LIVE_STATUSES.includes(task.status) && (
                  <div className="intel-actions-row">
                    <button disabled={busy} onClick={() => void act(() => delegationApi.cancelTask(task.id), 'Cancelled.')}>
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
