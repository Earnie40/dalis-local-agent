import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTorOnlyLocalDatabase,
  createTorOnlyFetch,
  installTorOnlyFetch,
  isLoopbackHttpUrl,
  loadTorNetworkPolicy,
  verifyTorRoute,
} from '@dacai-local-agent/providers';

const originalFetch = globalThis.fetch;
const originalTorProxy = process.env.TOR_SOCKS_PROXY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTorProxy === undefined) delete process.env.TOR_SOCKS_PROXY;
  else process.env.TOR_SOCKS_PROXY = originalTorProxy;
  vi.restoreAllMocks();
});

describe('Tor-only network policy', () => {
  it('requires proxy-side DNS resolution', () => {
    expect(() => loadTorNetworkPolicy({ TOR_SOCKS_PROXY: 'socks5://127.0.0.1:9050' })).toThrow(
      'must use socks5h://',
    );
    expect(loadTorNetworkPolicy({}).proxyUrl.toString()).toBe('socks5h://127.0.0.1:9050');
  });

  it('recognizes only explicit loopback HTTP hosts', () => {
    expect(isLoopbackHttpUrl(new URL('http://127.0.0.1:11434/api/tags'))).toBe(true);
    expect(isLoopbackHttpUrl(new URL('http://localhost:3001/health'))).toBe(true);
    expect(isLoopbackHttpUrl(new URL('https://example.com/'))).toBe(false);
    expect(isLoopbackHttpUrl(new URL('https://10.0.0.5/'))).toBe(false);
  });

  it('blocks raw remote database sockets while allowing local PostgreSQL', () => {
    expect(() => assertTorOnlyLocalDatabase('postgresql://user:pw@localhost:5433/db')).not.toThrow();
    expect(() => assertTorOnlyLocalDatabase('postgresql://user:pw@db.example.com:5432/db')).toThrow(
      'remote database sockets are blocked',
    );
  });

  it('sends public requests only to the SOCKS transport and strips route headers', async () => {
    const directFetch = vi.fn(async () => new Response('direct')) as unknown as typeof fetch;
    const proxyFetch = vi.fn(async (_url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get('x-forwarded-for')).toBeNull();
      expect(headers.get('referer')).toBeNull();
      expect(headers.get('authorization')).toBe('Bearer retained');
      return new Response('tor');
    });
    const fetchImpl = createTorOnlyFetch(loadTorNetworkPolicy({}), {
      directFetch,
      proxyFetch,
    });

    const response = await fetchImpl('https://example.com/data', {
      headers: {
        authorization: 'Bearer retained',
        referer: 'http://localhost/private',
        'x-forwarded-for': '192.0.2.10',
      },
    });

    expect(await response.text()).toBe('tor');
    expect(proxyFetch).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('keeps loopback local and never hands it to the proxy', async () => {
    const directFetch = vi.fn(async () => new Response('local')) as unknown as typeof fetch;
    const proxyFetch = vi.fn(async () => new Response('tor'));
    const fetchImpl = createTorOnlyFetch(loadTorNetworkPolicy({}), {
      directFetch,
      proxyFetch,
    });

    expect(await (await fetchImpl('http://127.0.0.1:3001/health')).text()).toBe('local');
    expect(directFetch).toHaveBeenCalledOnce();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('rejects public native Request objects instead of using a direct fallback', async () => {
    const directFetch = vi.fn(async () => new Response('direct')) as unknown as typeof fetch;
    const proxyFetch = vi.fn(async () => new Response('tor'));
    const fetchImpl = createTorOnlyFetch(loadTorNetworkPolicy({}), {
      directFetch,
      proxyFetch,
    });

    await expect(fetchImpl(new Request('https://example.com/'))).rejects.toThrow('rejected fail-closed');
    expect(directFetch).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('blocks startup when the verification endpoint does not confirm Tor', async () => {
    const installed = installTorOnlyFetch({}, {
      directFetch: originalFetch,
      proxyFetch: async () => new Response(JSON.stringify({ IsTor: false }), { status: 200 }),
    });

    await expect(verifyTorRoute(installed)).rejects.toThrow('not a verified Tor exit');
    installed.restore();
  });

  it('accepts a positively verified Tor route', async () => {
    const installed = installTorOnlyFetch({}, {
      directFetch: originalFetch,
      proxyFetch: async () => new Response(JSON.stringify({ IsTor: true }), { status: 200 }),
    });

    await expect(verifyTorRoute(installed)).resolves.toBeUndefined();
    installed.restore();
  });
});
