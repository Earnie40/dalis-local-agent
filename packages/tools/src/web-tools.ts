import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ToolDefinition } from './types';

const MAX_RESPONSE_CHARS = 50_000;
const MAX_DOWNLOAD_BYTES = 10_000_000;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

async function assertPublicHttps(urlText: string): Promise<URL> {
  let url: URL;
  try { url = new URL(urlText); } catch { throw new Error('URL must be valid.'); }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === 'metadata.google.internal' || host.endsWith('.internal')) {
    throw new Error('Private and metadata hosts are not allowed.');
  }
  const records = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const record of records) {
    if (isPrivateIpv4(record.address) || isPrivateIpv6(record.address)) {
      throw new Error(`URL resolves to a private or link-local address (${record.address}).`);
    }
  }
  return url;
}

export const webFetchTool: ToolDefinition = {
  name: 'web.fetch',
  description:
    'PUBLIC INTERNET ONLY: fetch a specific public HTTPS page and return capped text for agent research. ' +
    'Do not use this for local files, workspace source code, localhost, private networks, or repository identifiers; ' +
    'use filesystem.read/filesystem.search for workspace content. Blocks private/localhost/metadata destinations and redirects.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Public HTTPS URL to fetch.' } },
    required: ['url'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresNetwork: true,
  timeoutMs: 20_000,
  async execute(input, ctx) {
    const url = await assertPublicHttps(String(input.url ?? ''));
    const response = await fetch(url, {
      redirect: 'error',
      signal: ctx.signal,
      headers: { Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1', 'User-Agent': 'DacaiLocalAgent/0.1 research' },
    });
    const text = await response.text();
    return {
      url: url.toString(),
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