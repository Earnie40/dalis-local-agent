import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approvedDownloadTool, webFetchTool, webSearchTool } from '../packages/tools/src/web-tools';

/*
 * These tools sell network access to the agent, so the tests are really
 * security tests. Everything below is verified without a live network so the
 * suite stays deterministic: DNS resolution and fetch are stubbed.
 */
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const dnsLookup = vi.mocked(lookup);

function okResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  } as unknown as Response;
}

const fetchImpl = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchImpl.mockReset();
  fetchImpl.mockResolvedValue(okResponse('hello world'));
  globalThis.fetch = fetchImpl;
  dnsLookup.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
});

describe('web.fetch', () => {
  it('requires HTTPS and rejects URLs carrying credentials', async () => {
    await expect(webFetchTool.execute({ url: 'http://example.com/' }, {})).rejects.toThrow(/Only HTTPS URLs are allowed/);
    await expect(webFetchTool.execute({ url: 'https://user:sekret@example.com/' }, {})).rejects.toThrow(/credentials/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks localhost, metadata and .internal hosts before any DNS lookup', async () => {
    await expect(webFetchTool.execute({ url: 'https://localhost/' }, {})).rejects.toThrow(/Private and metadata hosts/);
    await expect(webFetchTool.execute({ url: 'https://metadata.google.internal/' }, {})).rejects.toThrow(/Private and metadata hosts/);
    await expect(webFetchTool.execute({ url: 'https://db.internal/' }, {})).rejects.toThrow(/Private and metadata hosts/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a literal private address without resolving it', async () => {
    await expect(webFetchTool.execute({ url: 'https://127.0.0.1/' }, {})).rejects.toThrow(/private or link-local/i);
    await expect(webFetchTool.execute({ url: 'https://192.168.1.10/' }, {})).rejects.toThrow(/private or link-local/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address (SSRF guard)', async () => {
    dnsLookup.mockImplementation(async () => [{ address: '10.0.0.7', family: 4 }]);
    await expect(webFetchTool.execute({ url: 'https://stealth.example.com/' }, {})).rejects.toThrow(/private or link-local/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches an allowed public URL and returns the body', async () => {
    fetchImpl.mockResolvedValue(okResponse('<h1>ok</h1>'));
    const result = (await webFetchTool.execute({ url: 'https://example.com/' }, {})) as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(result.body).toContain('<h1>ok</h1>');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps and marks a very large response rather than returning it whole', async () => {
    fetchImpl.mockResolvedValue(okResponse('x'.repeat(60_000)));
    const result = (await webFetchTool.execute({ url: 'https://example.com/' }, {})) as { body: string };
    expect(result.body).toMatch(/\[response truncated\]$/);
    expect(result.body.length).toBeLessThan(51_000);
  });

  it('sends no credentials in the request headers', async () => {
    await webFetchTool.execute({ url: 'https://example.com/' }, {});
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toBeDefined();
    expect(JSON.stringify(init.headers)).not.toMatch(/(authorization|token|password|secret)/i);
  });
});

describe('web.search', () => {
  it('returns parsed results from the DuckDuckGo HTML page', async () => {
    fetchImpl.mockResolvedValue(
      okResponse(
        '<div class="result__a" href="https://example.com/a">Alpha</a>' +
          '<a class="result__snippet">first snippet</a>',
      ),
    );
    const result = (await webSearchTool.execute({ query: 'alpha' }, {})) as { results: Array<{ title: string }> };
    expect(Array.isArray(result.results)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty or over-long query', async () => {
    await expect(webSearchTool.execute({ query: '' }, {})).rejects.toThrow(/1–300/);
    await expect(webSearchTool.execute({ query: 'x'.repeat(301) }, {})).rejects.toThrow(/1–300/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('download.approved', () => {
  it('neutralizes a path-traversal filename and keeps the download inside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dacai-web-'));
    const result = (await approvedDownloadTool.execute(
      { url: 'https://example.com/file.bin', filename: '../../evil.bin' },
      { workspaceRoot: root },
    )) as { path: string; bytes: number };
    // The '../' traversal is sanitized away, so the file lands in <root>/downloads
    // and never escapes the workspace.
    expect(result.path).toBe(join(root, 'downloads', '.._.._evil.bin'));
    expect(result.path.startsWith(resolve(root, 'downloads'))).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('requires a workspace to download into', async () => {
    await expect(
      approvedDownloadTool.execute({ url: 'https://example.com/file.bin', filename: 'a.bin' }, {}),
    ).rejects.toThrow(/workspace is required/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('permission tiers', () => {
  it('classifies reads as safe and downloads as mutation with network/write requirements', () => {
    expect(webFetchTool.permissionTier).toBe('safe');
    expect(webFetchTool.requiresNetwork).toBe(true);
    expect(webSearchTool.permissionTier).toBe('safe');
    expect(webSearchTool.requiresNetwork).toBe(true);
    expect(approvedDownloadTool.permissionTier).toBe('mutation');
    expect(approvedDownloadTool.requiresNetwork).toBe(true);
    expect(approvedDownloadTool.requiresWrite).toBe(true);
  });
});