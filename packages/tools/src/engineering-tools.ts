import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, extname, isAbsolute, join, relative } from 'node:path';
import { resolveWithinWorkspace } from '@dacai-local-agent/security';
import { runProcess } from './shell-tools';
import type { ToolDefinition, ToolExecutionContext } from './types';

export type EngineeringBackendId =
  | 'repository-code-graph'
  | 'graphviz'
  | 'tree-sitter'
  | 'ts-morph'
  | 'codeql'
  | 'joern'
  | 'cadquery'
  | 'freecad'
  | 'openscad'
  | 'ifcopenshell'
  | 'ifcconvert'
  | 'blender'
  | 'honeybee-energy'
  | 'energyplus'
  | 'calculix'
  | 'openfoam'
  | 'code-aster'
  | 'openseespy'
  | 'openmodelica'
  | 'project-chrono'
  | 'ros2'
  | 'gazebo'
  | 'isaac-sim'
  | 'mujoco'
  | 'px4'
  | 'ardupilot';

export type EngineeringArea = 'code' | 'cad' | 'bim' | 'scene' | 'simulation' | 'robotics';
export type EngineeringPhase = 'foundation' | 'next' | 'later';

type DiscoverySpec =
  | { kind: 'internal' }
  | { kind: 'executable'; candidates: readonly string[] }
  | { kind: 'python-module'; module: string }
  | { kind: 'node-module'; module: string };

export interface EngineeringBackendDefinition {
  id: EngineeringBackendId;
  title: string;
  area: EngineeringArea;
  phase: EngineeringPhase;
  discovery: DiscoverySpec;
  operations: readonly string[];
  formats: readonly string[];
  professionalReviewRequired?: boolean;
}

export const ENGINEERING_BACKEND_CATALOG: readonly EngineeringBackendDefinition[] = [
  { id: 'repository-code-graph', title: 'DACAIS repository graph', area: 'code', phase: 'foundation', discovery: { kind: 'internal' }, operations: ['symbol search', 'callers', 'callees', 'impact', 'path trace', 'Mermaid/DOT source'], formats: ['json', 'mermaid', 'dot'] },
  { id: 'graphviz', title: 'Graphviz', area: 'code', phase: 'foundation', discovery: { kind: 'executable', candidates: ['dot'] }, operations: ['render graph'], formats: ['dot', 'svg', 'png', 'pdf'] },
  { id: 'tree-sitter', title: 'Tree-sitter', area: 'code', phase: 'next', discovery: { kind: 'node-module', module: 'tree-sitter' }, operations: ['syntax parsing'], formats: ['code'] },
  { id: 'ts-morph', title: 'ts-morph', area: 'code', phase: 'next', discovery: { kind: 'node-module', module: 'ts-morph' }, operations: ['TypeScript semantic analysis'], formats: ['ts', 'tsx'] },
  { id: 'codeql', title: 'CodeQL', area: 'code', phase: 'later', discovery: { kind: 'executable', candidates: ['codeql'] }, operations: ['dataflow', 'taint analysis'], formats: ['sarif', 'json'] },
  { id: 'joern', title: 'Joern', area: 'code', phase: 'later', discovery: { kind: 'executable', candidates: ['joern'] }, operations: ['code property graph'], formats: ['json', 'dot'] },
  { id: 'cadquery', title: 'CadQuery', area: 'cad', phase: 'foundation', discovery: { kind: 'python-module', module: 'cadquery' }, operations: ['generate parametric model', 'export'], formats: ['py', 'step', 'stl', 'dxf'], professionalReviewRequired: true },
  { id: 'freecad', title: 'FreeCAD command line', area: 'cad', phase: 'foundation', discovery: { kind: 'executable', candidates: ['FreeCADCmd', 'freecadcmd'] }, operations: ['recompute', 'inspect', 'convert', 'validate'], formats: ['fcstd', 'step', 'stl', 'dxf'], professionalReviewRequired: true },
  { id: 'openscad', title: 'OpenSCAD', area: 'cad', phase: 'foundation', discovery: { kind: 'executable', candidates: ['openscad'] }, operations: ['generate deterministic solid', 'export'], formats: ['scad', 'stl', '3mf'], professionalReviewRequired: true },
  { id: 'ifcopenshell', title: 'IfcOpenShell', area: 'bim', phase: 'foundation', discovery: { kind: 'python-module', module: 'ifcopenshell' }, operations: ['generate IFC', 'inspect BIM', 'validate'], formats: ['py', 'ifc'], professionalReviewRequired: true },
  { id: 'ifcconvert', title: 'IfcConvert', area: 'bim', phase: 'next', discovery: { kind: 'executable', candidates: ['IfcConvert', 'ifcconvert'] }, operations: ['convert IFC geometry'], formats: ['ifc', 'obj', 'dae', 'glb'], professionalReviewRequired: true },
  { id: 'blender', title: 'Blender', area: 'scene', phase: 'foundation', discovery: { kind: 'executable', candidates: ['blender'] }, operations: ['scene generation', 'materials', 'camera', 'lighting', 'render', 'animation'], formats: ['blend', 'py', 'png', 'exr', 'mp4', 'glb'] },
  { id: 'honeybee-energy', title: 'Honeybee Energy', area: 'simulation', phase: 'next', discovery: { kind: 'python-module', module: 'honeybee_energy' }, operations: ['building energy model'], formats: ['hbjson', 'idf'], professionalReviewRequired: true },
  { id: 'energyplus', title: 'EnergyPlus', area: 'simulation', phase: 'next', discovery: { kind: 'executable', candidates: ['energyplus'] }, operations: ['building energy simulation'], formats: ['idf', 'epw', 'csv'], professionalReviewRequired: true },
  { id: 'calculix', title: 'CalculiX', area: 'simulation', phase: 'later', discovery: { kind: 'executable', candidates: ['ccx'] }, operations: ['finite-element analysis'], formats: ['inp', 'frd'], professionalReviewRequired: true },
  { id: 'openfoam', title: 'OpenFOAM', area: 'simulation', phase: 'later', discovery: { kind: 'executable', candidates: ['simpleFoam', 'foamRun'] }, operations: ['computational fluid dynamics'], formats: ['foam'], professionalReviewRequired: true },
  { id: 'code-aster', title: 'Code_Aster', area: 'simulation', phase: 'later', discovery: { kind: 'executable', candidates: ['as_run', 'run_aster'] }, operations: ['structural and multiphysics analysis'], formats: ['comm', 'med'], professionalReviewRequired: true },
  { id: 'openseespy', title: 'OpenSeesPy', area: 'simulation', phase: 'later', discovery: { kind: 'python-module', module: 'openseespy' }, operations: ['structural and seismic analysis'], formats: ['py', 'json'], professionalReviewRequired: true },
  { id: 'openmodelica', title: 'OpenModelica', area: 'simulation', phase: 'later', discovery: { kind: 'executable', candidates: ['omc'] }, operations: ['multi-domain system simulation'], formats: ['mo', 'mat'], professionalReviewRequired: true },
  { id: 'project-chrono', title: 'Project Chrono', area: 'simulation', phase: 'later', discovery: { kind: 'python-module', module: 'pychrono' }, operations: ['multibody dynamics'], formats: ['py', 'json'], professionalReviewRequired: true },
  { id: 'ros2', title: 'ROS 2', area: 'robotics', phase: 'later', discovery: { kind: 'executable', candidates: ['ros2'] }, operations: ['robot graph and interfaces'], formats: ['urdf', 'bag', 'yaml'], professionalReviewRequired: true },
  { id: 'gazebo', title: 'Gazebo', area: 'robotics', phase: 'later', discovery: { kind: 'executable', candidates: ['gz', 'gazebo'] }, operations: ['robot simulation'], formats: ['sdf', 'world'], professionalReviewRequired: true },
  { id: 'isaac-sim', title: 'Isaac Sim', area: 'robotics', phase: 'later', discovery: { kind: 'executable', candidates: ['isaac-sim', 'isaac-sim.sh'] }, operations: ['robotics simulation'], formats: ['usd'], professionalReviewRequired: true },
  { id: 'mujoco', title: 'MuJoCo', area: 'robotics', phase: 'later', discovery: { kind: 'python-module', module: 'mujoco' }, operations: ['robot dynamics simulation'], formats: ['xml', 'mjb'], professionalReviewRequired: true },
  { id: 'px4', title: 'PX4', area: 'robotics', phase: 'later', discovery: { kind: 'executable', candidates: ['px4'] }, operations: ['UAV software-in-the-loop'], formats: ['ulog'], professionalReviewRequired: true },
  { id: 'ardupilot', title: 'ArduPilot', area: 'robotics', phase: 'later', discovery: { kind: 'executable', candidates: ['arducopter', 'sim_vehicle.py'] }, operations: ['vehicle software-in-the-loop'], formats: ['bin', 'log'], professionalReviewRequired: true },
] as const;

export type EngineeringCapabilityStatus = 'verified' | 'unsupported' | 'unknown';

export interface EngineeringCapability {
  id: EngineeringBackendId;
  title: string;
  area: EngineeringArea;
  phase: EngineeringPhase;
  status: EngineeringCapabilityStatus;
  operations: readonly string[];
  formats: readonly string[];
  reason: string;
  professionalReviewRequired: boolean;
}

export interface EngineeringCapabilityReport {
  probedAt: string;
  capabilities: EngineeringCapability[];
  available: EngineeringBackendId[];
  unavailable: EngineeringBackendId[];
}

export interface EngineeringProbeRuntime {
  findExecutable(candidates: readonly string[]): Promise<string | undefined>;
  hasPythonModule(moduleName: string): Promise<boolean | undefined>;
  hasNodeModule(moduleName: string): Promise<boolean | undefined>;
  now(): Date;
}

const require = createRequire(import.meta.url);
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACT_BATCH_BYTES = 1024 * 1024 * 1024;

function executableNames(name: string): string[] {
  if (process.platform !== 'win32') return [name];
  if (extname(name)) return [name];
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`), ...extensions.map((extension) => `${name}${extension.toUpperCase()}`)];
}

export async function findExecutable(candidates: readonly string[]): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const directories = pathValue.split(delimiter).filter(Boolean);
  for (const candidate of candidates) {
    const paths = isAbsolute(candidate)
      ? [candidate]
      : directories.flatMap((directory) => executableNames(candidate).map((name) => join(directory, name)));
    for (const path of paths) {
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        // Continue to the next fixed candidate.
      }
    }
  }
  return undefined;
}

async function defaultHasPythonModule(moduleName: string): Promise<boolean | undefined> {
  const python = await findExecutable(['python', 'python3', 'py']);
  if (!python) return false;
  const result = await runProcess(
    python,
    ['-c', 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 3)', moduleName],
    { cwd: process.cwd(), timeoutMs: 15_000, useShell: false },
  );
  if (result.timedOut || result.cancelled) return undefined;
  return result.exitCode === 0 ? true : result.exitCode === 3 ? false : undefined;
}

const DEFAULT_PROBE_RUNTIME: EngineeringProbeRuntime = {
  findExecutable,
  hasPythonModule: defaultHasPythonModule,
  async hasNodeModule(moduleName) {
    try {
      require.resolve(moduleName);
      return true;
    } catch {
      return false;
    }
  },
  now: () => new Date(),
};

let cachedReport: { expiresAt: number; report: EngineeringCapabilityReport } | undefined;

export async function inspectEngineeringCapabilities(
  options: { refresh?: boolean; runtime?: EngineeringProbeRuntime } = {},
): Promise<EngineeringCapabilityReport> {
  const runtime = options.runtime ?? DEFAULT_PROBE_RUNTIME;
  const canUseCache = runtime === DEFAULT_PROBE_RUNTIME && !options.refresh;
  if (canUseCache && cachedReport && cachedReport.expiresAt > Date.now()) return cachedReport.report;

  const capabilities = await Promise.all(ENGINEERING_BACKEND_CATALOG.map(async (definition): Promise<EngineeringCapability> => {
    let discovered: boolean | undefined;
    try {
      if (definition.discovery.kind === 'internal') discovered = true;
      else if (definition.discovery.kind === 'executable') discovered = Boolean(await runtime.findExecutable(definition.discovery.candidates));
      else if (definition.discovery.kind === 'python-module') discovered = await runtime.hasPythonModule(definition.discovery.module);
      else discovered = await runtime.hasNodeModule(definition.discovery.module);
    } catch {
      discovered = undefined;
    }

    return {
      id: definition.id,
      title: definition.title,
      area: definition.area,
      phase: definition.phase,
      status: discovered === true ? 'verified' : discovered === false ? 'unsupported' : 'unknown',
      operations: definition.operations,
      formats: definition.formats,
      reason: discovered === true
        ? definition.discovery.kind === 'internal' ? 'Built into this repository.' : 'Required executable or module was found by a fixed local probe.'
        : discovered === false
          ? 'Required executable or module was not found on this host.'
          : 'The fixed local probe could not determine availability.',
      professionalReviewRequired: definition.professionalReviewRequired === true,
    };
  }));

  const report: EngineeringCapabilityReport = {
    probedAt: runtime.now().toISOString(),
    capabilities,
    available: capabilities.filter((capability) => capability.status === 'verified').map((capability) => capability.id),
    unavailable: capabilities.filter((capability) => capability.status === 'unsupported').map((capability) => capability.id),
  };
  if (runtime === DEFAULT_PROBE_RUNTIME) cachedReport = { expiresAt: Date.now() + 5 * 60_000, report };
  return report;
}

export interface EngineeringArtifact {
  path: string;
  format: string;
  bytes: number;
  sha256: string;
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('Artifact inspection was cancelled.');
  const digest = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    const onAbort = () => stream.destroy(new Error('Artifact inspection was cancelled.'));
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', (error) => { cleanup(); reject(error); });
    stream.on('end', () => { cleanup(); resolve(); });
  });
  return digest.digest('hex');
}

export async function inspectEngineeringArtifacts(
  workspaceRoot: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<EngineeringArtifact[]> {
  if (!paths.length) throw new Error('At least one artifact path is required.');
  if (paths.length > 50) throw new Error('At most 50 artifact paths may be inspected at once.');
  const realRoot = resolveWithinWorkspace(workspaceRoot, '.');
  const artifacts: EngineeringArtifact[] = [];
  let totalBytes = 0;
  for (const requested of paths) {
    if (signal?.aborted) throw new Error('Artifact inspection was cancelled.');
    if (typeof requested !== 'string' || !requested.trim()) throw new Error('Artifact paths must be non-empty strings.');
    const absolute = resolveWithinWorkspace(realRoot, requested.trim());
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`Artifact "${requested}" is not a file.`);
    if (info.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`Artifact "${requested}" exceeds the ${MAX_ARTIFACT_BYTES} byte inspection limit.`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_ARTIFACT_BATCH_BYTES) {
      throw new Error(`Artifact batch exceeds the ${MAX_ARTIFACT_BATCH_BYTES} byte inspection limit.`);
    }
    artifacts.push({
      path: relative(realRoot, absolute).replace(/\\/g, '/'),
      format: extname(absolute).slice(1).toLowerCase() || 'unknown',
      bytes: info.size,
      sha256: await sha256File(absolute, signal),
    });
  }
  return artifacts;
}

export interface EngineeringExecutionRequest {
  backend: 'cadquery' | 'freecad' | 'openscad' | 'ifcopenshell' | 'blender';
  scriptPath: string;
  sourceSha256: string;
  expectedArtifacts: string[];
  outputPath?: string;
  args: string[];
}

export interface EngineeringToolServices {
  inspect(refresh: boolean): Promise<EngineeringCapabilityReport>;
  inspectArtifacts(paths: string[], ctx: ToolExecutionContext): Promise<EngineeringArtifact[]>;
  execute(request: EngineeringExecutionRequest, ctx: ToolExecutionContext): Promise<Record<string, unknown>>;
}

const SOURCE_EXTENSIONS: Record<EngineeringExecutionRequest['backend'], readonly string[]> = {
  cadquery: ['.py'],
  freecad: ['.py'],
  openscad: ['.scad'],
  ifcopenshell: ['.py'],
  blender: ['.py'],
};

async function defaultExecute(): Promise<Record<string, unknown>> {
  throw new Error(
    'Engineering source execution is disabled until an operator configures an OS-level sandbox adapter that confines filesystem and network access.',
  );
}

const DEFAULT_SERVICES: EngineeringToolServices = {
  inspect: (refresh) => inspectEngineeringCapabilities({ refresh }),
  inspectArtifacts(paths, ctx) {
    if (!ctx.workspaceRoot) throw new Error('A workspace is required.');
    return inspectEngineeringArtifacts(ctx.workspaceRoot, paths, ctx.signal);
  },
  execute: defaultExecute,
};

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required.`);
  if (value.length > 2_000 || value.includes('\0')) throw new Error(`${key} is invalid.`);
  return value.trim();
}

function stringArray(input: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}): string[] {
  const value = input[key];
  if (value === undefined && !options.required) return [];
  if (!Array.isArray(value) || (options.required && !value.length)) throw new Error(`${key} must be a non-empty array.`);
  if (value.length > (options.max ?? 20)) throw new Error(`${key} contains too many entries.`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 2_000 || entry.includes('\0')) {
      throw new Error(`${key} entries must be bounded non-empty strings.`);
    }
    return entry.trim();
  });
}

function containedRelativePath(workspaceRoot: string, requestedPath: string, label: string): {
  absolute: string;
  relative: string;
} {
  if (isAbsolute(requestedPath)) throw new Error(`${label} must be workspace-relative.`);
  const realRoot = resolveWithinWorkspace(workspaceRoot, '.');
  const absolute = resolveWithinWorkspace(realRoot, requestedPath);
  const normalized = relative(realRoot, absolute).replace(/\\/g, '/');
  if (!normalized || normalized === '.') throw new Error(`${label} must identify a file inside the workspace.`);
  return { absolute, relative: normalized };
}

async function assertNewArtifact(path: string, requestedPath: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`Expected artifact "${requestedPath}" already exists; engineering V1 refuses overwrite.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function executionTool(
  services: EngineeringToolServices,
  definition: {
    name: 'cad.execute' | 'bim.execute' | 'scene.render';
    description: string;
    backends: readonly EngineeringExecutionRequest['backend'][];
  },
): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: {
      type: 'object',
      properties: {
        backend: { type: 'string', enum: definition.backends },
        scriptPath: { type: 'string', description: 'Workspace-relative source script. Running authored scripts is high-impact and requires approval.' },
        sourceSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'SHA-256 shown to and bound into the approval request.' },
        expectedArtifacts: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'New workspace-relative artifacts that must exist after exit 0.' },
        outputPath: { type: 'string', description: 'Required for OpenSCAD; must be a new workspace-relative path.' },
        args: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      },
      required: ['backend', 'scriptPath', 'sourceSha256', 'expectedArtifacts'],
      additionalProperties: false,
    },
    permissionTier: 'high-impact',
    requiresRead: true,
    requiresWrite: true,
    requiresShell: true,
    timeoutMs: 10 * 60_000,
    async execute(input, ctx) {
      if (!ctx.workspaceRoot) throw new Error('A workspace is required.');
      const backend = requiredString(input, 'backend') as EngineeringExecutionRequest['backend'];
      if (!definition.backends.includes(backend)) throw new Error(`Backend "${backend}" is not valid for ${definition.name}.`);
      const scriptPath = containedRelativePath(ctx.workspaceRoot, requiredString(input, 'scriptPath'), 'scriptPath').relative;
      if (!SOURCE_EXTENSIONS[backend].includes(extname(scriptPath).toLowerCase())) {
        throw new Error(`Backend "${backend}" requires ${SOURCE_EXTENSIONS[backend].join(' or ')} source.`);
      }
      const sourceSha256 = requiredString(input, 'sourceSha256').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('sourceSha256 must be a SHA-256 digest.');
      const args = stringArray(input, 'args', { max: 20 });
      if ((backend === 'freecad' || backend === 'openscad') && args.length) {
        throw new Error(`${backend} does not accept model-supplied extra arguments in V1.`);
      }
      const requestedArtifacts = stringArray(input, 'expectedArtifacts', { required: true, max: 20 });
      const artifactPaths = requestedArtifacts.map((path) => containedRelativePath(ctx.workspaceRoot!, path, 'expectedArtifacts entry'));
      if (new Set(artifactPaths.map((path) => path.relative.toLowerCase())).size !== artifactPaths.length) {
        throw new Error('expectedArtifacts must not contain duplicate paths.');
      }
      const requestedOutputPath = typeof input.outputPath === 'string' && input.outputPath.trim()
        ? containedRelativePath(ctx.workspaceRoot, input.outputPath.trim(), 'outputPath').relative
        : undefined;
      if (backend === 'openscad' && !requestedOutputPath) throw new Error('outputPath is required for OpenSCAD.');
      if (requestedOutputPath && !artifactPaths.some((path) => path.relative.toLowerCase() === requestedOutputPath.toLowerCase())) {
        throw new Error('outputPath must also be listed in expectedArtifacts.');
      }
      for (const artifact of artifactPaths) await assertNewArtifact(artifact.absolute, artifact.relative);

      const [sourceBefore] = await services.inspectArtifacts([scriptPath], ctx);
      if (!sourceBefore || sourceBefore.sha256.toLowerCase() !== sourceSha256) {
        throw new Error('The source file no longer matches the SHA-256 bound to this approval. Inspect it again before retrying.');
      }

      const result = await services.execute({
        backend,
        scriptPath,
        sourceSha256,
        expectedArtifacts: artifactPaths.map((path) => path.relative),
        outputPath: requestedOutputPath,
        args,
      }, ctx);
      if (result.exitCode !== 0) throw new Error('The sandboxed engineering backend did not exit successfully.');
      const [sourceAfter] = await services.inspectArtifacts([scriptPath], ctx);
      if (!sourceAfter || sourceAfter.sha256.toLowerCase() !== sourceSha256) {
        throw new Error('The approved source file changed during execution; artifact provenance is invalid.');
      }
      const artifacts = await services.inspectArtifacts(artifactPaths.map((path) => path.relative), ctx);
      return {
        ...result,
        artifacts,
        sourceArtifact: sourceAfter,
        validation: {
          ...(result.validation && typeof result.validation === 'object' ? result.validation : {}),
          processPassed: true,
          declaredArtifactsPresent: artifacts.length === artifactPaths.length,
          contentHashed: artifacts.every((artifact) => /^[a-f0-9]{64}$/i.test(artifact.sha256)),
        },
      };
    },
  };
}

export function createEngineeringTools(services: EngineeringToolServices = DEFAULT_SERVICES): ToolDefinition[] {
  const capabilityTool: ToolDefinition = {
    name: 'engineering.capabilities.inspect',
    description: 'Probe the fixed engineering backend catalog and report verified, unavailable, or indeterminate local capabilities without exposing host executable paths.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } }, additionalProperties: false },
    permissionTier: 'safe',
    requiresShell: true,
    timeoutMs: 60_000,
    execute: (input) => services.inspect(input.refresh === true),
  };

  const artifactTool: ToolDefinition = {
    name: 'engineering.artifact.inspect',
    description: 'Hash and inventory declared engineering artifacts inside the workspace for objective evidence. This does not validate geometry, physics, code compliance, or certification.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } },
      required: ['paths'],
      additionalProperties: false,
    },
    permissionTier: 'safe',
    requiresRead: true,
    timeoutMs: 60_000,
    async execute(input, ctx) {
      const artifacts = await services.inspectArtifacts(stringArray(input, 'paths', { required: true, max: 50 }), ctx);
      return { artifacts, validation: { filesPresent: true, contentHashed: true } };
    },
  };

  return [
    capabilityTool,
    artifactTool,
    executionTool(services, {
      name: 'cad.execute',
      description: 'Execute an approved workspace CadQuery, FreeCAD, or OpenSCAD source model only through a configured OS sandbox, with approval bound to the source SHA-256 and new hashed artifacts required.',
      backends: ['cadquery', 'freecad', 'openscad'],
    }),
    executionTool(services, {
      name: 'bim.execute',
      description: 'Execute an approved workspace IfcOpenShell source model only through a configured OS sandbox, with source hash binding and applicable building-code and professional review.',
      backends: ['ifcopenshell'],
    }),
    executionTool(services, {
      name: 'scene.render',
      description: 'Execute an approved workspace Blender scene only through a configured OS sandbox, with source hash binding and new hashed render or scene artifacts required.',
      backends: ['blender'],
    }),
  ];
}

export const ENGINEERING_TOOLS: ToolDefinition[] = createEngineeringTools();
