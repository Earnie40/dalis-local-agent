import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { assertPublicHttps } from '@dacai-local-agent/security';
import type { ToolDefinition } from './types';

const MAX_RESPONSE_CHARS = 50_000;
const MAX_DOWNLOAD_BYTES = 10_000_000;

export const webFetchTool: ToolDefinition = {
  name: 'web.fetch',
  description:
    'PUBLIC INTERNET READ ONLY: GET or HEAD a specific public HTTPS page and return capped text or metadata for agent research. ' +
    'Do not use this for local files, workspace source code, localhost, private networks, or repository identifiers; ' +
    'use filesystem.read/filesystem.search for workspace content. Blocks private/localhost/metadata destinations and redirects.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Public HTTPS URL to fetch.' },
      method: { type: 'string', enum: ['GET', 'HEAD'], description: 'Read-only HTTP method. Defaults to GET.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresNetwork: true,
  timeoutMs: 20_000,
  async execute(input, ctx) {
    const url = await assertPublicHttps(String(input.url ?? ''));
    const requestedMethod = String(input.method ?? 'GET').toUpperCase();
    if (requestedMethod !== 'GET' && requestedMethod !== 'HEAD') {
      throw new Error('web.fetch only permits read-only GET and HEAD requests.');
    }
    const method = requestedMethod as 'GET' | 'HEAD';
    const response = await fetch(url, {
      method,
      redirect: 'error',
      signal: ctx.signal,
      headers: { Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1', 'User-Agent': 'DacaiLocalAgent/0.1 research' },
    });
    const text = method === 'HEAD' ? '' : await response.text();
    return {
      url: url.toString(),
      method,
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: text.length > MAX_RESPONSE_CHARS ? `${text.slice(0, MAX_RESPONSE_CHARS)}\n[response truncated]` : text,
    };
  },
};

export const webSearchTool: ToolDefinition = {
  name: 'web.search',
  description:
    'PUBLIC INTERNET ONLY: search external public web pages through DuckDuckGo and return titles, URLs, and snippets. ' +
    'Do not use this to search the active repository, local files, class/function names, SQL table names, or workspace text; ' +
    'use filesystem.search for those.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 300 } },
    required: ['query'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresNetwork: true,
  timeoutMs: 20_000,
  async execute(input, ctx) {
    const query = String(input.query ?? '').trim();
    if (!query || query.length > 300) throw new Error('Search query must be 1–300 characters.');
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      redirect: 'error', signal: ctx.signal, headers: { 'User-Agent': 'DacaiLocalAgent/0.1 research' },
    });
    const html = await response.text();
    const results = [...html.matchAll(/result__a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?result__snippet[^>]*>([\s\S]*?)<\/a>/gi)]
      .slice(0, 8)
      .map((match) => ({ url: match[1], title: match[2].replace(/<[^>]+>/g, '').trim(), snippet: match[3].replace(/<[^>]+>/g, '').trim() }));
    return { query, results };
  },
};

export const approvedDownloadTool: ToolDefinition = {
  name: 'download.approved',
  description:
    'PUBLIC INTERNET DOWNLOAD: download a specific public HTTPS file into the workspace downloads folder. ' +
    'Use only for an external file the agent intentionally needs; never use this to access local/workspace files. ' +
    'Requires write and network permission; size is capped at 10 MB.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' }, filename: { type: 'string' } },
    required: ['url'], additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresNetwork: true,
  requiresWrite: true,
  timeoutMs: 60_000,
  async execute(input, ctx) {
    if (!ctx.workspaceRoot) throw new Error('A workspace is required for downloads.');
    const url = await assertPublicHttps(String(input.url ?? ''));
    const requested = String(input.filename ?? (basename(url.pathname) || 'download.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destination = resolve(ctx.workspaceRoot, 'downloads', requested);
    if (!destination.startsWith(resolve(ctx.workspaceRoot) + '\\') && !destination.startsWith(resolve(ctx.workspaceRoot) + '/')) throw new Error('Download path escaped the workspace.');
    const response = await fetch(url, { redirect: 'error', signal: ctx.signal, headers: { 'User-Agent': 'DacaiLocalAgent/0.1' } });
    if (!response.ok) throw new Error(`Download returned HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds the 10 MB limit.');
    await mkdir(join(ctx.workspaceRoot, 'downloads'), { recursive: true });
    await writeFile(destination, buffer, { flag: 'wx' }).catch(() => { throw new Error('Destination exists; choose a new filename.'); });
    const info = await stat(destination);
    return { url: url.toString(), path: destination, bytes: info.size };
  },
};

export const WEB_TOOLS: ToolDefinition[] = [webFetchTool, webSearchTool, approvedDownloadTool];
