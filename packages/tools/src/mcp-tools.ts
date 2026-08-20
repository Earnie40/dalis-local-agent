import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from './types';

const CONFIG_NAMES = [
  '.mcp.json',
  'mcp.json',
  '.vscode/mcp.json',
  'config/mcp.json',
] as const;

interface McpConfigShape {
  mcpServers?: Record<string, unknown>;
  servers?: Record<string, unknown>;
}

interface McpConfiguredFile {
  path: string;
  servers: string[];
  valid: boolean;
  error?: string;
}

/**
 * Reads approved MCP configuration files from the selected workspace.
 *
 * This tool is inspection-only:
 * - it does not start MCP servers
 * - it does not execute configured commands
 * - it does not inspect arbitrary filesystem paths
 * - it only checks the fixed allowlist in CONFIG_NAMES
 */
export const mcpListTool: ToolDefinition = {
  name: 'mcp.list',

  description:
    'Inspect approved MCP configuration files inside the selected workspace and list configured server names without starting them.',

  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },

  permissionTier: 'safe',
  timeoutMs: 10_000,

  async execute(_input, ctx) {
    if (!ctx.workspaceRoot) {
      throw new Error('A workspace is required.');
    }

    const configuredFiles: McpConfiguredFile[] = [];

    for (const relative of CONFIG_NAMES) {
      const path = join(
        ctx.workspaceRoot,
        relative,
      );

      let raw: string;

      try {
        raw = await readFile(
          path,
          'utf8',
        );
      } catch (error) {
        const code =
          typeof error === 'object' &&
          error !== null &&
          'code' in error
            ? String(
                (error as { code?: unknown }).code,
              )
            : undefined;

        /*
         * Missing files are expected because most workspaces will only use one
         * MCP configuration location.
         */
        if (
          code === 'ENOENT' ||
          code === 'ENOTDIR'
        ) {
          continue;
        }

        configuredFiles.push({
          path,
          servers: [],
          valid: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });

        continue;
      }

      try {
        const parsed =
          JSON.parse(raw) as McpConfigShape;

        const servers =
          parsed.mcpServers ??
          parsed.servers ??
          {};

        configuredFiles.push({
          path,
          servers:
            Object.keys(servers),
          valid: true,
        });
      } catch (error) {
        configuredFiles.push({
          path,
          servers: [],
          valid: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
      }
    }

    return {
      configuredFiles,
    };
  },
};

export const MCP_TOOLS: ToolDefinition[] = [
  mcpListTool,
];