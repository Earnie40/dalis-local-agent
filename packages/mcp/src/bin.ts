#!/usr/bin/env node
/**
 * stdio entry point for the DacaiLocalAgent MCP server.
 *
 * Register it with:
 *   claude mcp add dacai-local-agent -- node <repo>/packages/mcp/dist/bin.js
 *
 * stdout is the MCP transport, so nothing may be printed to it — diagnostics
 * go to stderr only.
 */
import { startStdioServer } from './server.js';

startStdioServer().catch((error: unknown) => {
  console.error('[dacai-local-agent] failed to start:', error);
  process.exit(1);
});
