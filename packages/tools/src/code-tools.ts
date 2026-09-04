import { runProcess } from './shell-tools';
import type { ToolDefinition } from './types';

export const codeDiagnosticsTool: ToolDefinition = {
  name: 'code.diagnostics',

  description:
    'Run the project TypeScript diagnostics without editing files and return compiler output.',

  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },

  permissionTier: 'safe',
  requiresRead: true,
  requiresShell: true,
  timeoutMs: 120_000,

  async execute(_input, ctx) {
    if (!ctx.workspaceRoot) {
      throw new Error('A workspace is required.');
    }

    return runProcess(
      'pnpm',
      ['typecheck'],
      {
        cwd: ctx.workspaceRoot,
        timeoutMs: 120_000,
        signal: ctx.signal,
        useShell: false,
      },
    );
  },
};

export const CODE_TOOLS: ToolDefinition[] = [
  codeDiagnosticsTool,
];
