import nodeFetch, { type RequestInit as NodeFetchRequestInit } from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

const DEFAULT_TOR_SOCKS_PROXY = 'socks5h://127.0.0.1:9050';
const DEFAULT_TOR_CHECK_URL = 'https://check.torproject.org/api/ip';

export interface TorNetworkPolicy {
  readonly mode: 'tor-only';
  readonly proxyUrl: URL;
  readonly checkUrl: URL;
}

export interface InstalledTorNetworkPolicy {
  readonly policy: TorNetworkPolicy;
  /** Restore the fetch implementation that was active before installation. */
  restore(): void;
}

export interface TorFetchServices {
  directFetch?: typeof globalThis.fetch;
  proxyFetch?: (
    url: URL,
    init: RequestInit,
    agent: SocksProxyAgent,
  ) => Promise<Response>;
}

function readUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

/**
 * Load the mandatory public-network policy.
 *
 * Behavioral constraint, requested by the owner: public fetch traffic is Tor
 * only and fails closed. There is deliberately no direct/clearnet mode in this
 * runtime. Loopback remains direct because local Ollama and the local UI are
 * not public-network traffic.
 */
export function loadTorNetworkPolicy(
  env: NodeJS.ProcessEnv = process.env,
): TorNetworkPolicy {
  const proxyUrl = readUrl(
    env.TOR_SOCKS_PROXY?.trim() || DEFAULT_TOR_SOCKS_PROXY,
    'TOR_SOCKS_PROXY',
  );

  // socks5h makes the proxy, rather than the host resolver, resolve destination
  // names. Accepting socks5:// here would reintroduce a DNS-leak path.
  if (proxyUrl.protocol !== 'socks5h:') {
    throw new Error(
      'TOR_SOCKS_PROXY must use socks5h:// so destination DNS is resolved through Tor.',
    );
  }

  const checkUrl = readUrl(
    env.TOR_CHECK_URL?.trim() || DEFAULT_TOR_CHECK_URL,
    'TOR_CHECK_URL',
  );
  if (checkUrl.protocol !== 'https:') {
    throw new Error('TOR_CHECK_URL must use HTTPS.');
  }

  return { mode: 'tor-only', proxyUrl, checkUrl };
}

function isLoopbackHostname(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

export function isLoopbackHttpUrl(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url);
}

/** Raw PostgreSQL sockets cannot use the HTTP SOCKS adapter, so keep them local. */
export function assertTorOnlyLocalDatabase(databaseUrl: string): void {
  const url = readUrl(databaseUrl, 'DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !isLoopbackHostname(url)) {
    throw new Error(
      'Tor-only mode requires DATABASE_URL to use localhost, 127.0.0.0/8, or ::1; remote database sockets are blocked.',
    );
  }
}

function urlFromFetchInput(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return readUrl(input, 'fetch URL');
  if (input instanceof URL) return input;
  return readUrl(input.url, 'fetch request URL');
}

function privacyHeaders(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit);

  // Do not forward network-path or page-origin metadata to public services.
  // Authentication and provider-specific headers are intentionally preserved:
  // Tor hides the network route, not the identity of an API account.
  for (const name of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'via', 'referer']) {
    headers.delete(name);
  }
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'Mozilla/5.0');
  }
  return headers;
}

async function defaultProxyFetch(
  url: URL,
  init: RequestInit,
  agent: SocksProxyAgent,
): Promise<Response> {
  return (await nodeFetch(url, {
    ...init,
    headers: privacyHeaders(init.headers),
    agent,
  } as unknown as NodeFetchRequestInit)) as unknown as Response;
}

/** Create a fetch implementation which has no public clearnet fallback. */
export function createTorOnlyFetch(
  policy: TorNetworkPolicy,
  services: TorFetchServices = {},
): typeof globalThis.fetch {
  const directFetch = (services.directFetch ?? globalThis.fetch).bind(globalThis);
  const proxyFetch = services.proxyFetch ?? defaultProxyFetch;
  const agent = new SocksProxyAgent(policy.proxyUrl);

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlFromFetchInput(input);
    if (isLoopbackHttpUrl(url)) {
      return directFetch(input, init);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Tor-only fetch rejects unsupported protocol "${url.protocol}".`);
    }

    // A native Request can contain a consumed or streaming body whose semantics
    // cannot be losslessly transferred to node-fetch. Reject it instead of ever
    // falling back to the native clearnet transport. Repository call sites use
    // URL/string inputs and an explicit RequestInit.
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new Error(
        'Tor-only public fetch requires a URL/string plus RequestInit; native Request objects are rejected fail-closed.',
      );
    }

    return proxyFetch(
      url,
      { ...init, headers: privacyHeaders(init?.headers) },
      agent,
    );
  }) as typeof globalThis.fetch;
}

/** Install Tor routing before providers, tools, or background jobs can fetch. */
export function installTorOnlyFetch(
  env: NodeJS.ProcessEnv = process.env,
  services: TorFetchServices = {},
): InstalledTorNetworkPolicy {
  const policy = loadTorNetworkPolicy(env);
  // Child-process tooling receives this non-secret route through minimalEnv().
  // Setting the normalized value also prevents a conflicting inherited proxy
  // from sending supported CLI traffic somewhere other than Tor.
  env.TOR_SOCKS_PROXY = policy.proxyUrl.toString();
  const previous = globalThis.fetch;
  globalThis.fetch = createTorOnlyFetch(policy, {
    ...services,
    directFetch: services.directFetch ?? previous,
  });

  return {
    policy,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

/**
 * Prove the configured proxy currently exits through Tor.
 *
 * Startup must not proceed when the proxy is absent, the check is unreachable,
 * or the endpoint says the exit is not Tor. This is the fail-closed gate for
 * the transport; it never retries through a direct connection.
 */
export async function verifyTorRoute(
  installed: InstalledTorNetworkPolicy,
  options: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;

  try {
    response = await fetchImpl(installed.policy.checkUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    throw new Error(
      `Tor route verification failed through ${installed.policy.proxyUrl.hostname}:${installed.policy.proxyUrl.port || '9050'}. ` +
        'Start Tor and confirm its SOCKS listener is reachable; clearnet fallback is disabled.',
      { cause },
    );
  }

  if (!response.ok) {
    throw new Error(`Tor route verification returned HTTP ${response.status}; clearnet fallback is disabled.`);
  }

  let payload: { IsTor?: unknown };
  try {
    payload = (await response.json()) as { IsTor?: unknown };
  } catch (cause) {
    throw new Error('Tor route verification returned invalid JSON; clearnet fallback is disabled.', {
      cause,
    });
  }

  if (payload.IsTor !== true) {
    throw new Error('Configured SOCKS route is not a verified Tor exit; server startup is blocked.');
  }
}
