import { describe, expect, it, vi } from 'vitest';
import { buildProviderInstances } from '../packages/shared/src/config';
import {
  buildSshBaseArgs,
  buildSshTunnelArgs,
  parseRunpodConnection,
  RunpodConnectionError,
} from '../apps/server/src/infrastructure/runpod-connection';
import { parseNvidiaSmi, RunpodService } from '../apps/server/src/infrastructure/runpod-service';
import {
  discoverRunpodSshEndpoint,
  formatRunpodConnection,
  selectSshEndpoint,
} from '../apps/server/src/infrastructure/runpod-discovery';

describe('RunPod SSH connection', () => {
  it('parses supported SSH forms without retaining the source command', () => {
    expect(parseRunpodConnection('ssh gpu-user@example.runpod.io -p 22022')).toEqual({
      username: 'gpu-user', hostname: 'example.runpod.io', port: 22022, identityFile: undefined,
    });
    expect(parseRunpodConnection('ssh root@10.2.3.4 -i "keys/runpod key"')).toEqual({
      username: 'root', hostname: '10.2.3.4', port: 22, identityFile: 'keys/runpod key',
    });
  });

  it('handles missing and invalid values with sanitized errors', () => {
    expect(() => parseRunpodConnection(undefined)).toThrowError(expect.objectContaining({ code: 'missing' }));
    const secret = 'ssh root@secret.example -o StrictHostKeyChecking=no';
    let error: unknown;
    try { parseRunpodConnection(secret); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RunpodConnectionError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('secret.example');
  });

  it('constructs SSH probe and tunnel arguments without a shell', () => {
    const connection = parseRunpodConnection('ssh root@gpu.example -p 22022 -i keyfile');
    const base = buildSshBaseArgs(connection);
    expect(base).toContain('BatchMode=yes');
    expect(base).toContain('ExitOnForwardFailure=yes');
    expect(base).toContain('StrictHostKeyChecking=accept-new');
    expect(base).not.toContain('StrictHostKeyChecking=no');
    expect(base.at(-1)).toBe('root@gpu.example');

    const tunnel = buildSshTunnelArgs(connection, 11435);
    expect(tunnel.slice(-4)).toEqual(['-N', '-L', '127.0.0.1:11435:127.0.0.1:11434', 'root@gpu.example']);
    expect(buildSshTunnelArgs(connection, 18090, 8090).slice(-4)).toEqual([
      '-N', '-L', '127.0.0.1:18090:127.0.0.1:8090', 'root@gpu.example',
    ]);
  });

  it('parses structured NVIDIA inventory', () => {
    expect(parseNvidiaSmi('NVIDIA A40, 46068, 570.10')).toEqual({
      detected: true, model: 'NVIDIA A40', vramMb: 46068, driver: '570.10',
    });
    expect(parseNvidiaSmi('not valid')).toEqual({ detected: false });
  });

  it('never returns SSH stderr or connection details in status errors', async () => {
    const connection = 'ssh root@private-host.example -i private-key-file';
    const run = vi.fn().mockResolvedValue({ code: 255, stdout: '', stderr: connection });
    const status = await new RunpodService(connection, 11435, run).status();
    const serialized = JSON.stringify(status);
    expect(status.configured).toBe(true);
    expect(status.connected).toBe(false);
    expect(serialized).not.toContain('private-host');
    expect(serialized).not.toContain('private-key');
  });

  it('activates the existing remote provider from RUNPOD_CONNECTION only', () => {
    const instances = buildProviderInstances({ RUNPOD_CONNECTION: 'ssh root@gpu.example' }) as Record<
      string,
      { enabled: boolean; baseUrl?: string; transport: string; fallbackInstanceId?: string; requestTimeoutMs?: number }
    >;
    expect(instances.remote_gpu_ollama).toMatchObject({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11435',
      transport: 'ssh-tunnel',
      requestTimeoutMs: 300_000,
    });
    expect(instances.remote_gpu_ollama.fallbackInstanceId).toBe('local_ollama');
    expect(instances.local_ollama.enabled).toBe(true);
  });

  it('activates RunPod discovery from the API key without a stored SSH endpoint', () => {
    const instances = buildProviderInstances({ RUNPOD_API_KEY: 'synthetic-runpod-key' }) as Record<
      string,
      { enabled: boolean; baseUrl?: string; fallbackInstanceId?: string }
    >;

    expect(instances.remote_gpu_ollama).toMatchObject({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11435',
      fallbackInstanceId: 'local_ollama',
    });
  });

  it('recognizes a persistent RunPod Ollama binary and only tunnels to a serving API', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const remote = args.at(-1) ?? '';
      if (remote === 'printf DACAIS_RUNPOD_READY') return { code: 0, stdout: 'DACAIS_RUNPOD_READY', stderr: '' };
      if (remote.includes('nvidia-smi --query-gpu')) return { code: 0, stdout: 'NVIDIA RTX A6000, 49140, 580.1', stderr: '' };
      if (remote.includes('CUDA Version')) return { code: 0, stdout: '13.0', stderr: '' };
      if (remote.includes('python3 --version')) return { code: 0, stdout: 'Python 3.12.3', stderr: '' };
      if (remote.includes('/workspace/ollama/bin/ollama --version')) return { code: 0, stdout: 'ollama version is 0.32.14', stderr: '' };
      if (remote.includes('/api/tags')) return { code: 1, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    const status = await new RunpodService('ssh root@gpu.example', 11435, run).status();
    expect(status.ollama).toEqual({ installed: true, version: 'ollama version is 0.32.14' });
    expect(status.inference.ollama).toBe(false);
    expect(status.tunnelHealthy).toBe(false);
  });

  it('uses the persistent startup script when the pod API is down during initialization', async () => {
    const commands: string[] = [];
    const run = vi.fn(async (_command: string, args: string[]) => {
      const remote = args.at(-1) ?? '';
      commands.push(remote);
      if (remote === 'printf DACAIS_RUNPOD_READY') {
        return { code: 0, stdout: 'DACAIS_RUNPOD_READY', stderr: '' };
      }
      if (remote.includes('nvidia-smi --query-gpu')) {
        return { code: 0, stdout: 'NVIDIA RTX A6000, 49140, 580.1', stderr: '' };
      }
      if (remote.includes('/api/tags')) return { code: 1, stdout: '', stderr: '' };
      if (remote.includes('/workspace/ollama/run-ollama.sh')) return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });

    const status = await new RunpodService('ssh root@gpu.example', 11435, run).initialize();

    expect(commands.some((command) => command.includes('setsid /workspace/ollama/run-ollama.sh'))).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.tunnelHealthy).toBe(false);
  });
});

describe('RunPod endpoint discovery', () => {
  const runningPod = (ports: unknown[]) => [
    { id: 'pod-running', name: 'gpu-pod', desiredStatus: 'RUNNING', runtime: { ports } },
  ];

  it('selects the TCP mapping for port 22 and never the UDP one', () => {
    // RunPod's REST portMappings collapses these to a single entry that can be
    // the UDP port; connecting there is refused and looks like a dead pod.
    expect(
      selectSshEndpoint(
        runningPod([
          { ip: '194.68.0.1', isIpPublic: true, privatePort: 22, publicPort: 22105, type: 'udp' },
          { ip: '194.68.0.1', isIpPublic: true, privatePort: 22, publicPort: 22104, type: 'tcp' },
        ]),
      ),
    ).toEqual([{ podId: 'pod-running', name: 'gpu-pod', host: '194.68.0.1', port: 22104 }]);
  });

  it('ignores pods that are not running, private IPs, and non-SSH ports', () => {
    expect(
      selectSshEndpoint([
        {
          id: 'stopped',
          desiredStatus: 'EXITED',
          runtime: { ports: [{ ip: '1.2.3.4', isIpPublic: true, privatePort: 22, publicPort: 22104, type: 'tcp' }] },
        },
        ...runningPod([
          { ip: '100.65.18.213', isIpPublic: false, privatePort: 22, publicPort: 60418, type: 'tcp' },
          { ip: '194.68.0.1', isIpPublic: true, privatePort: 8888, publicPort: 22104, type: 'tcp' },
        ]),
      ]),
    ).toEqual([]);
  });

  it('prefers the configured pod and falls back to another running one', async () => {
    const pods = [
      { id: 'other', desiredStatus: 'RUNNING', runtime: { ports: [{ ip: '1.1.1.1', isIpPublic: true, privatePort: 22, publicPort: 101, type: 'tcp' }] } },
      { id: 'wanted', desiredStatus: 'RUNNING', runtime: { ports: [{ ip: '2.2.2.2', isIpPublic: true, privatePort: 22, publicPort: 202, type: 'tcp' }] } },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { myself: { pods } } }),
    }) as unknown as typeof fetch;

    expect(await discoverRunpodSshEndpoint({ apiKey: 'k', podId: 'wanted', fetchImpl })).toMatchObject({ podId: 'wanted', port: 202 });
    expect(await discoverRunpodSshEndpoint({ apiKey: 'k', podId: 'gone', fetchImpl })).toMatchObject({ podId: 'other', port: 101 });
  });

  it('resolves to undefined instead of throwing when the API is unusable', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    expect(await discoverRunpodSshEndpoint({ apiKey: 'k', fetchImpl: failing })).toBeUndefined();
    expect(await discoverRunpodSshEndpoint({ apiKey: undefined })).toBeUndefined();
  });

  it('renders a connection string the parser accepts', () => {
    const value = formatRunpodConnection({ podId: 'p', name: 'p', host: 'gpu.example', port: 22104 }, 'keyfile');
    expect(parseRunpodConnection(value)).toEqual({
      username: 'root', hostname: 'gpu.example', port: 22104, identityFile: 'keyfile',
    });
  });

  it('re-resolves a stale endpoint and reports the pod it moved to', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const remote = args.at(-1) ?? '';
      const target = args.find((arg) => arg.startsWith('root@'));
      if (remote === 'printf DACAIS_RUNPOD_READY' && target === 'root@new.example') {
        return { code: 0, stdout: 'DACAIS_RUNPOD_READY', stderr: '' };
      }
      if (remote === 'printf DACAIS_RUNPOD_READY') return { code: 255, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    const service = new RunpodService('ssh root@stale.example -p 1 -i keyfile', 11435, run, async () => ({
      podId: 'pod-new', name: 'gpu-pod', host: 'new.example', port: 22104,
    }));

    const status = await service.status();

    expect(status.connected).toBe(true);
    expect(service.discoveredEndpoint()?.podId).toBe('pod-new');
    // The identity file carries across so the rediscovered endpoint stays usable.
    expect(service.connectionString()).toBe('ssh root@new.example -p 22104 -i keyfile');
  });
});
