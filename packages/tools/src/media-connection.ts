export type MediaTransport = 'ssh-tunnel' | 'loopback' | 'https';

export interface MediaConnection {
  baseUrl: string;
  transport: MediaTransport;
  headers: Record<string, string>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Resolve the media API without weakening the local-first boundary.
 * Workstation development traffic stays on a loopback SSH tunnel. When the
 * app and media service share one host, direct loopback is also safe.
 * Internet-facing production traffic must use authenticated HTTPS.
 */
export function resolveMediaConnection(env: NodeJS.ProcessEnv): MediaConnection {
  const transport = (env.DACAI_MEDIA_TRANSPORT?.trim().toLowerCase() || 'ssh-tunnel') as MediaTransport;
  if (transport !== 'ssh-tunnel' && transport !== 'loopback' && transport !== 'https') {
    throw new Error('DACAI_MEDIA_TRANSPORT must be ssh-tunnel, loopback, or https.');
  }

  const raw = env.DACAI_MEDIA_BASE_URL?.trim() || 'http://127.0.0.1:18090';
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('The DACAIS media URL is invalid.'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The DACAIS media URL must not contain credentials, a query, or a fragment.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (transport === 'ssh-tunnel' || transport === 'loopback') {
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(host)) {
      throw new Error(`${transport} media transport requires an HTTP(S) loopback URL.`);
    }
  } else {
    if (url.protocol !== 'https:') throw new Error('https media transport requires an HTTPS URL.');
    if (!env.DACAI_MEDIA_TOKEN?.trim()) {
      throw new Error('DACAI_MEDIA_TOKEN is required for https media transport.');
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const token = env.DACAI_MEDIA_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return { baseUrl: raw.replace(/\/+$/, ''), transport, headers };
}
