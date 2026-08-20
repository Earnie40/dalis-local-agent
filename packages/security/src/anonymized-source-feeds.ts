/**
 * Real, freely-available data sources for AnonymizedSourceDetector.
 *
 * Tor exit-node list: the Tor Project's standard public, unauthenticated feed.
 * "Datacenter range" is a deliberate, weaker substitute for a commercial
 * proxy/VPN IP database (those require a paid feed) — AWS's official,
 * freely-published IP-range file is real, versioned data; a request
 * originating from a cloud provider's published netblock is a real signal
 * ("datacenter origin"), just not the same claim as "known proxy/VPN exit."
 * Swap the fetcher functions below for a different real source if a specific
 * commercial feed is preferred; nothing else needs to change.
 */

import { isIP } from 'node:net';

const TOR_EXIT_LIST_URL = 'https://check.torproject.org/exit-addresses';
const AWS_IP_RANGES_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json';
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export interface AnonymizedSourceFeedSnapshot {
  torExitNodes: string[];
  datacenterRanges: string[];
  fetchedAt: Date;
  /** Non-fatal: a feed that failed to fetch keeps its previous value rather than going empty. */
  warnings: string[];
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

/**
 * Parses the Tor Project's real exit-address list
 * (`ExitAddress <ip> <date>` lines among other fields per relay block).
 * Skips any line that doesn't match rather than failing the whole fetch —
 * the exact field ordering has changed before and may change again.
 */
export function parseTorExitAddresses(body: string): string[] {
  const addresses = new Set<string>();
  for (const line of body.split('\n')) {
    const match = /^ExitAddress\s+(\S+)/.exec(line.trim());
    if (match && isIP(match[1])) addresses.add(match[1]);
  }
  return [...addresses];
}

interface AwsIpRangesResponse {
  prefixes?: Array<{ ip_prefix?: string }>;
}

/** Parses AWS's real, official, freely-published IP-range feed into CIDR strings. */
export function parseAwsIpRanges(body: string): string[] {
  let parsed: AwsIpRangesResponse;
  try {
    parsed = JSON.parse(body) as AwsIpRangesResponse;
  } catch (error) {
    throw new Error(`AWS ip-ranges.json was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ranges = new Set<string>();
  for (const prefix of parsed.prefixes ?? []) {
    if (typeof prefix.ip_prefix === 'string' && prefix.ip_prefix.includes('/')) ranges.add(prefix.ip_prefix);
  }
  return [...ranges];
}

export async function fetchTorExitAddresses(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<string[]> {
  return parseTorExitAddresses(await fetchText(TOR_EXIT_LIST_URL, timeoutMs));
}

export async function fetchAwsDatacenterRanges(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<string[]> {
  return parseAwsIpRanges(await fetchText(AWS_IP_RANGES_URL, timeoutMs));
}

/**
 * Refreshes both feeds. Never throws: a failed fetch logs a warning and keeps
 * `previous`'s value for that feed rather than reverting to an empty (or
 * worse, fabricated) list.
 */
export async function refreshAnonymizedSourceFeeds(
  previous: AnonymizedSourceFeedSnapshot | null,
): Promise<AnonymizedSourceFeedSnapshot> {
  const warnings: string[] = [];
  let torExitNodes = previous?.torExitNodes ?? [];
  let datacenterRanges = previous?.datacenterRanges ?? [];

  try {
    torExitNodes = await fetchTorExitAddresses();
  } catch (error) {
    warnings.push(
      `Tor exit-node fetch failed, keeping ${torExitNodes.length} previously known address(es): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    datacenterRanges = await fetchAwsDatacenterRanges();
  } catch (error) {
    warnings.push(
      `AWS IP-range fetch failed, keeping ${datacenterRanges.length} previously known range(s): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { torExitNodes, datacenterRanges, fetchedAt: new Date(), warnings };
}
