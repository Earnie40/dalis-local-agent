import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { runProcess } from './shell-tools';

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) throw new Error('This tool requires an active workspace root.');
  return resolve(ctx.workspaceRoot);
}

function within(root: string, requested: string): string {
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escaped the workspace.');
  return target;
}

async function testPath(root: string, value: unknown): Promise<string> {
  const requested = String(value ?? '').replace(/\\/g, '/');
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(requested)) throw new Error('testPath must be a .test/.spec JS/TS file.');
  const target = within(root, requested);
  if (!(await stat(target)).isFile()) throw new Error(`Test file does not exist: ${requested}`);
  return requested;
}

async function mutationPath(root: string, value: unknown): Promise<string> {
  const requested = String(value ?? '').replace(/\\/g, '/');
  if (!/\.[cm]?[jt]sx?$/.test(requested) || /\.(?:test|spec)\./.test(requested)) {
    throw new Error('targetPath must be a non-test JS/TS source file.');
  }
  if (requested.includes('node_modules/') || requested.includes('/dist/') || requested.startsWith('dist/')) {
    throw new Error('Mutation target may not be generated/vendor code.');
  }
  const target = within(root, requested);
  if (!(await stat(target)).isFile()) throw new Error(`Mutation target does not exist: ${requested}`);
  return requested;
}

export const qualityTestFileTool: ToolDefinition = {
  name: 'quality.test_file',
  description:
    'Run exactly one workspace test/spec file with a temporary Vitest config. Useful when the root Vitest include pattern would otherwise ignore package-local tests.',
  inputSchema: {
    type: 'object',
    properties: { testPath: { type: 'string', minLength: 1, maxLength: 600 } },
    required: ['testPath'],
    additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 300_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const requested = await testPath(root, input.testPath);
    const tmpDir = resolve(root, '.dacai', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const config = resolve(tmpDir, `vitest-${ctx.taskId ?? Date.now()}.config.ts`);
    await writeFile(
      config,
      `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: [${JSON.stringify(requested)}], environment: "node" } });\n`,
      'utf8',
    );
    try {
      return await runProcess('pnpm', ['exec', 'vitest', 'run', '--config', config], {
        cwd: root, timeoutMs: 300_000, signal: ctx.signal, useShell: false,
      });
    } finally {
      await rm(config, { force: true }).catch(() => undefined);
    }
  },
};

export const qualityMutationTool: ToolDefinition = {
  name: 'quality.mutation',
  description:
    'Run bounded Stryker mutation testing against one source file only. Requires @stryker-mutator/core and vitest runner installed by the parity pack.',
  inputSchema: {
    type: 'object',
    properties: { targetPath: { type: 'string', minLength: 1, maxLength: 600 } },
    required: ['targetPath'],
    additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 900_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const requested = await mutationPath(root, input.targetPath);
    const tmpDir = resolve(root, '.dacai', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const config = resolve(tmpDir, `stryker-${ctx.taskId ?? Date.now()}.config.mjs`);
    await writeFile(
      config,
      [
        'export default {',
        `  mutate: [${JSON.stringify(requested)}],`,
        '  packageManager: "pnpm",',
        '  plugins: ["@stryker-mutator/vitest-runner"],',
        '  testRunner: "vitest",',
        '  vitest: { related: false },',
        '  reporters: ["clear-text", "progress"],',
        '  concurrency: 1,',
        '  timeoutMS: 60000,',
        '  coverageAnalysis: "perTest",',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      return await runProcess('pnpm', ['exec', 'stryker', 'run', config], {
        cwd: root, timeoutMs: 900_000, signal: ctx.signal, useShell: false,
      });
    } finally {
      await rm(config, { force: true }).catch(() => undefined);
    }
  },
};

export const QUALITY_TOOLS: ToolDefinition[] = [qualityTestFileTool, qualityMutationTool];
