import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The single SSRF guard for outbound agent/research traffic.
 *
 * Extracted from web-tools so the agent's `web.fetch` tool and the investor
 * intelligence research adapters enforce byte-identical rules. Two
 * implementations of this check would eventually disagree, and the one that
 * disagreed in the permissive direction would be the one that mattered.
 *
 * The check is deliberately DNS-aware: a public-looking hostname that resolves
 * to a private address is the whole point of an SSRF attempt, so resolution
 * happens here rather than being left to the request.
 */

export function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

/**
 * Resolves and validates a public HTTPS destination.
 *
 * Throws rather than returning a result flag: a caller that forgets to check a
 * boolean makes the request anyway, whereas a caller that forgets to catch does
 * not.
 */
export async function assertPublicHttps(urlText: string): Promise<URL> {
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
    // Each address is checked against the guard for ITS OWN family only.
    // isPrivateIpv4 fails closed (returns true) on anything that doesn't parse
    // as four dotted octets, so calling it unconditionally on an IPv6 address
    // -- which every dual-stack host resolves to -- always finds it "private"
    // and blocks a perfectly public site. isIP() (0 | 4 | 6) is the source of
    // truth for which check actually applies to this address.
    const family = isIP(record.address);
    const isPrivate = family === 6 ? isPrivateIpv6(record.address) : isPrivateIpv4(record.address);
    if (isPrivate) {
      throw new Error(`URL resolves to a private or link-local address (${record.address}).`);
    }
  }
  return url;
}
