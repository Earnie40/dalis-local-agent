import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionEngine } from '@dacai-local-agent/security';
import {
  ENGINEERING_BACKEND_CATALOG,
  PermissionedToolExecutor,
  ToolRegistry,
  createEngineeringTools,
  inspectEngineeringArtifacts,
  inspectEngineeringCapabilities,
  type EngineeringCapabilityReport,
  type EngineeringProbeRuntime,
  type EngineeringToolServices,
} from '@dacai-local-agent/tools';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('engineering capability catalog', () => {
  it('has unique backend ids and distinguishes current from later backends', () => {
    const ids = ENGINEERING_BACKEND_CATALOG.map((backend) => backend.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['cadquery', 'freecad', 'ifcopenshell', 'blender', 'openfoam', 'ros2']));
    expect(ENGINEERING_BACKEND_CATALOG.find((backend) => backend.id === 'cadquery')?.phase).toBe('foundation');
    expect(ENGINEERING_BACKEND_CATALOG.find((backend) => backend.id === 'openfoam')?.phase).toBe('later');
  });

  it('reports verified, unsupported, and indeterminate probes without leaking executable paths', async () => {
    const runtime: EngineeringProbeRuntime = {
      async findExecutable(candidates) {
        if (candidates.includes('dot')) return 'C:\\secret-host\\dot.exe';
        if (candidates.includes('codeql')) throw new Error('probe failed');
        return undefined;
      },
      async hasPythonModule(moduleName) { return moduleName === 'cadquery'; },
      async hasNodeModule() { return false; },
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    };
    const report = await inspectEngineeringCapabilities({ runtime });
    expect(report.probedAt).toBe('2026-08-21T12:00:00.000Z');
    expect(report.capabilities.find((item) => item.id === 'repository-code-graph')?.status).toBe('verified');
    expect(report.capabilities.find((item) => item.id === 'graphviz')?.status).toBe('verified');
    expect(report.capabilities.find((item) => item.id === 'cadquery')?.status).toBe('verified');
    expect(report.capabilities.find((item) => item.id === 'freecad')?.status).toBe('unsupported');
    expect(report.capabilities.find((item) => item.id === 'codeql')?.status).toBe('unknown');
    expect(JSON.stringify(report)).not.toContain('secret-host');
  });
});

describe('engineering artifacts', () => {
  it('returns workspace-relative hashes and rejects containment escapes', async () => {
    const root = join(tmpdir(), `engineering-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    temporaryRoots.push(root);
    await mkdir(join(root, 'output'), { recursive: true });
    await writeFile(join(root, 'output', 'part.step'), 'synthetic-step');

    const [artifact] = await inspectEngineeringArtifacts(root, ['output/part.step']);
    expect(artifact).toMatchObject({ path: 'output/part.step', format: 'step', bytes: 14 });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(inspectEngineeringArtifacts(root, ['../outside.step'])).rejects.toThrow(/escapes the workspace root/i);
  });
});

describe('permissioned engineering tools', () => {
  function report(): EngineeringCapabilityReport {
    return { probedAt: new Date(0).toISOString(), capabilities: [], available: [], unavailable: [] };
  }

  function services() {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      artifacts: [{ path: 'output/part.step', format: 'step', bytes: 42, sha256: 'a'.repeat(64) }],
      validation: { processPassed: true, declaredArtifactsPresent: true },
    }));
    const value: EngineeringToolServices = {
      inspect: async () => report(),
      inspectArtifacts: async (paths) => paths.map((path) => ({
        path,
        format: path.split('.').pop() ?? 'unknown',
        bytes: 12,
        sha256: 'a'.repeat(64),
      })),
      execute,
    };
    return { value, execute };
  }

  it('uses explicit names and honest static permission tiers', () => {
    const { value } = services();
    const tools = createEngineeringTools(value);
    expect(tools.map((tool) => tool.name)).toEqual([
      'engineering.capabilities.inspect',
      'engineering.artifact.inspect',
      'cad.execute',
      'bim.execute',
      'scene.render',
    ]);
    expect(tools.find((tool) => tool.name === 'engineering.capabilities.inspect')).toMatchObject({ permissionTier: 'safe', requiresShell: true });
    expect(tools.find((tool) => tool.name === 'engineering.artifact.inspect')).toMatchObject({ permissionTier: 'safe', requiresRead: true });
    expect(tools.find((tool) => tool.name === 'cad.execute')).toMatchObject({ permissionTier: 'high-impact', requiresRead: true, requiresShell: true, requiresWrite: true });
  });

  it('denies artifact inspection when workspace read authority is absent', async () => {
    const { value } = services();
    const registry = new ToolRegistry();
    registry.register(createEngineeringTools(value).find((tool) => tool.name === 'engineering.artifact.inspect')!);
    const executor = new PermissionedToolExecutor({
      registry,
      capabilities: { read: false, write: false, shell: false, network: false },
      context: { workspaceRoot: 'C:\\workspace' },
    });
    const result = await executor.execute({
      id: 'read-denied',
      name: 'engineering.artifact.inspect',
      arguments: { paths: ['output/part.step'] },
    });
    expect(result).toMatchObject({ success: false, denied: true });
  });

  it('denies execution without workspace write authority before asking for approval', async () => {
    const { value, execute } = services();
    const registry = new ToolRegistry();
    registry.register(createEngineeringTools(value).find((tool) => tool.name === 'cad.execute')!);
    const approvals = { request: vi.fn(async () => true) };
    const executor = new PermissionedToolExecutor({
      registry,
      capabilities: { read: true, write: false, shell: true, network: false },
      context: { workspaceRoot: 'C:\\workspace' },
      approvals,
    });
    const result = await executor.execute({ id: '1', name: 'cad.execute', arguments: {
      backend: 'cadquery', scriptPath: 'part.py', sourceSha256: 'a'.repeat(64), expectedArtifacts: ['output/part.step'],
    } });
    expect(result.denied).toBe(true);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires approval, runs once, and emits objective artifact and validation evidence', async () => {
    const { value, execute } = services();
    const registry = new ToolRegistry();
    registry.register(createEngineeringTools(value).find((tool) => tool.name === 'cad.execute')!);
    const executor = new PermissionedToolExecutor({
      registry,
      engine: new PermissionEngine({ autoApprove: ['safe'], requireApproval: ['mutation', 'high-impact'], deny: [] }),
      capabilities: { read: true, write: true, shell: true, network: false },
      context: { workspaceRoot: 'C:\\workspace' },
      approvals: { request: async () => true },
    });
    const result = await executor.execute({ id: '1', name: 'cad.execute', arguments: {
      backend: 'cadquery', scriptPath: 'part.py', sourceSha256: 'a'.repeat(64), expectedArtifacts: ['output/part.step'], args: ['--width', '120'],
    } });
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'exit_code' }),
      expect.objectContaining({ kind: 'artifact_hash', detail: expect.objectContaining({ path: 'output/part.step' }) }),
      expect.objectContaining({ kind: 'validation_result' }),
    ]));
  });

  it('refuses execution when the approved source hash no longer matches', async () => {
    const { value, execute } = services();
    const registry = new ToolRegistry();
    registry.register(createEngineeringTools(value).find((tool) => tool.name === 'cad.execute')!);
    const executor = new PermissionedToolExecutor({
      registry,
      capabilities: { read: true, write: true, shell: true, network: false },
      context: { workspaceRoot: 'C:\\workspace' },
      approvals: { request: async () => true },
    });
    const result = await executor.execute({ id: 'hash-mismatch', name: 'cad.execute', arguments: {
      backend: 'cadquery', scriptPath: 'part.py', sourceSha256: 'b'.repeat(64), expectedArtifacts: ['output/part.step'],
    } });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no longer matches/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['../outside.step', /escapes the workspace root/i],
    ['C:\\outside.step', /workspace-relative/i],
  ])('rejects an uncontained declared output path: %s', async (artifactPath, message) => {
    const { value, execute } = services();
    const registry = new ToolRegistry();
    registry.register(createEngineeringTools(value).find((tool) => tool.name === 'cad.execute')!);
    const executor = new PermissionedToolExecutor({
      registry,
      capabilities: { read: true, write: true, shell: true, network: false },
      context: { workspaceRoot: 'C:\\workspace' },
      approvals: { request: async () => true },
    });
    const result = await executor.execute({ id: 'escape', name: 'cad.execute', arguments: {
      backend: 'cadquery', scriptPath: 'part.py', sourceSha256: 'a'.repeat(64), expectedArtifacts: [artifactPath],
    } });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(message);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a pre-existing engineering artifact', async () => {
    const root = join(tmpdir(), `engineering-overwrite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    temporaryRoots.push(root);
    await mkdir(join(root, 'output'), { recursive: true });
    await writeFile(join(root, 'output', 'part.step'), 'existing design');
    const { value, execute } = services();
    const registry = new ToolRegistry();
    registry.register(createEngineeringTools(value).find((tool) => tool.name === 'cad.execute')!);
    const executor = new PermissionedToolExecutor({
      registry,
      capabilities: { read: true, write: true, shell: true, network: false },
      context: { workspaceRoot: root },
      approvals: { request: async () => true },
    });
    const result = await executor.execute({ id: 'overwrite', name: 'cad.execute', arguments: {
      backend: 'cadquery', scriptPath: 'part.py', sourceSha256: 'a'.repeat(64), expectedArtifacts: ['output/part.step'],
    } });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/refuses overwrite/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps production engineering execution disabled until an OS sandbox adapter is configured', async () => {
    const root = join(tmpdir(), `engineering-default-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    temporaryRoots.push(root);
    const source = 'import cadquery as cq\nresult = cq.Workplane("XY")\n';
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'part.py'), source);
    const registry = new ToolRegistry();
    registry.register(createEngineeringTools().find((tool) => tool.name === 'cad.execute')!);
    const executor = new PermissionedToolExecutor({
      registry,
      capabilities: { read: true, write: true, shell: true, network: false },
      context: { workspaceRoot: root },
      approvals: { request: async () => true },
    });
    const result = await executor.execute({ id: 'sandbox-required', name: 'cad.execute', arguments: {
      backend: 'cadquery',
      scriptPath: 'part.py',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      expectedArtifacts: ['output/part.step'],
    } });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/disabled.*OS-level sandbox/i);
  });
});
