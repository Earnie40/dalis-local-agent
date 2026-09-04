import { assertPublicHttps } from '@dacai-local-agent/security';
import { assertPublicSourceUrl } from '../sources.js';
import { ResearchProviderError } from './provider.js';

/**
 * Shared HTTP retrieval for every research adapter.
 *
 * Two gates run before any request leaves the process:
 *
 *   1. `assertPublicSourceUrl` — collection *policy*. Is this the kind of
 *      surface we are permitted to look at at all?
 *   2. `assertPublicHttps` — network *safety*. Does it actually resolve
 *      somewhere public, or is it an SSRF attempt wearing a public hostname?
 *
 * Both must pass. They answer different questions and neither substitutes for
 * the other.
 */

const USER_AGENT = 'DacaiLocalAgent/0.1 (+public research; contact via repository)';
const MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface HttpGetResult {
  url: string;
  status: number;
  contentType?: string;
  body: string;
  /** Server-reported publication or modification date, when present. */
  lastModified?: string;
}

export async function publicGet(
  rawUrl: string,
  providerId: string,
  options: { signal?: AbortSignal; timeoutMs?: number; accept?: string } = {},
): Promise<HttpGetResult> {
  assertPublicSourceUrl(rawUrl);
  let url: URL;
  try {
    url = await assertPublicHttps(rawUrl);
  } catch (error) {
    throw new ResearchProviderError(
      `Refused to fetch ${rawUrl}: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      'blocked',
    );
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      // Redirects are not followed: a redirect can land somewhere the two gates
      // above never evaluated. A moved page is re-admitted explicitly.
      redirect: 'error',
      signal,
      headers: {
        Accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (error) {
    throw new ResearchProviderError(
      `Request to ${url.hostname} failed: ${error instanceof Error ? error.message : String(error)}`,
      providerId,
      'request-failed',
    );
  }

  if (!response.ok) {
    throw new ResearchProviderError(
      `${url.hostname} returned HTTP ${response.status}.`,
      providerId,
      'request-failed',
    );
  }

  const raw = await response.text();
  return {
    url: url.toString(),
    status: response.status,
    contentType: response.headers.get('content-type') ?? undefined,
    body: raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw,
    lastModified: response.headers.get('last-modified') ?? undefined,
  };
}

const BLOCK_ELEMENTS = /<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|br)\s*>/gi;

/**
 * Readable text from HTML.
 *
 * Deliberately simple and dependency-free: script, style, nav, and template
 * content is dropped, block boundaries become newlines, entities are decoded.
 * This is not a reader-mode implementation — it is enough to give the model
 * prose to summarize while keeping the raw markup out of the corpus.
 */
export function extractText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  return decodeEntities(
    withoutNoise
      .replace(BLOCK_ELEMENTS, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    // Collapses runs of ASCII space, tab, and non-breaking space (U+00A0,
    // which appears often in scraped HTML from `&nbsp;` decoded above).
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTitle(html: string): string | undefined {
  const explicit =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = explicit ? decodeEntities(explicit.replace(/<[^>]+>/g, '')).trim() : undefined;
  return title || undefined;
}

/**
 * Publication date from standard metadata only.
 *
 * When a page does not declare one, the result is undefined and the signal is
 * stored with a null published_at. Guessing a date from page text would put a
 * fabricated timestamp into time-decay scoring.
 */
export function extractPublishedAt(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["'](?:date|pubdate|publish-date|DC\.date)["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const raw = pattern.exec(html)?.[1];
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', trade: '™',
  copy: '©', reg: '®', deg: '°', middot: '·',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[String(name).toLowerCase()] ?? match);
}

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return '';
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

/** Absolute HTTPS links found in a page, de-duplicated and same-origin aware. */
export function extractLinks(html: string, baseUrl: string, sameHostOnly = false): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const found = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    let resolved: URL;
    try {
      resolved = new URL(match[1], base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:') continue;
    if (sameHostOnly && resolved.hostname !== base.hostname) continue;
    found.add(`${resolved.origin}${resolved.pathname}${resolved.search}`);
  }
  return [...found];
}
