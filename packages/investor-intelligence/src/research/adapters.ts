import { assertProfessionalQuery, assertPublicSourceUrl } from '../sources.js';
import {
  ConfigurableProvider,
  ResearchProviderError,
  type DiscoverOptions,
  type FetchedDocument,
  type PublicResearchProvider,
  type SearchHit,
  type SearchOptions,
} from './provider.js';
import {
  extractLinks,
  extractPublishedAt,
  extractText,
  extractTitle,
  publicGet,
} from './http.js';

/**
 * Concrete research adapters.
 *
 * The always-available set (web search, direct page, RSS, sitemap, public
 * GitHub) needs no credentials, which is what keeps the feature working without
 * a paid provider. The credentialed set (Exa, Firecrawl) is implemented against
 * the same interface and reports itself unavailable until configured — it never
 * degrades into invented results.
 */

// ---------------------------------------------------------------------------
// Web search — no credentials required
// ---------------------------------------------------------------------------

/**
 * DuckDuckGo's HTML endpoint, the same surface the existing `web.search` tool
 * uses. It is rate-limited and its markup changes; both are treated as ordinary
 * retrieval failures rather than something to paper over.
 */
export class WebSearchProvider implements PublicResearchProvider {
  readonly id = 'duckduckgo';

  unavailableReason(): string | undefined {
    return undefined;
  }

  available(): boolean {
    return true;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const safe = assertProfessionalQuery(query);
    const limit = Math.max(1, Math.min(options.limit ?? 8, 25));

    const result = await publicGet(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(safe)}`,
      this.id,
      { signal: options.signal },
    );

    const hits: SearchHit[] = [];
    const pattern =
      /result__a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?result__snippet[^>]*>([\s\S]*?)<\/a>/gi;

    for (const match of result.body.matchAll(pattern)) {
      const url = unwrapRedirect(match[1]);
      if (!url) continue;
      hits.push({
        url,
        title: stripTags(match[2]),
        snippet: stripTags(match[3]),
        provider: this.id,
      });
      if (hits.length >= limit) break;
    }

    return hits;
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<FetchedDocument> {
    return fetchReadable(url, this.id, options.signal);
  }

  async discover(): Promise<SearchHit[]> {
    // A search endpoint has no notion of "what else is on this site".
    return [];
  }
}

/** DuckDuckGo wraps results in /l/?uddg=<encoded>. Recover the real target. */
function unwrapRedirect(href: string): string | undefined {
  try {
    const absolute = href.startsWith('//') ? `https:${href}` : href;
    const url = new URL(absolute, 'https://duckduckgo.com');
    const wrapped = url.searchParams.get('uddg');
    const target = wrapped ? new URL(wrapped) : url;
    return target.protocol === 'https:' ? target.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Direct page retrieval
// ---------------------------------------------------------------------------

export class DirectPageProvider implements PublicResearchProvider {
  readonly id = 'direct-page';

  unavailableReason(): string | undefined {
    return undefined;
  }

  available(): boolean {
    return true;
  }

  async search(): Promise<SearchHit[]> {
    // Fetching a known URL is not searching. Saying so is more useful than
    // pretending to search and returning nothing.
    throw new ResearchProviderError(
      'direct-page retrieves known URLs and cannot search. Use the search provider to find candidates first.',
      this.id,
      'not-configured',
    );
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<FetchedDocument> {
    return fetchReadable(url, this.id, options.signal);
  }

  /** Same-host links from a listing page — a team page, a portfolio index. */
  async discover(url: string, options: DiscoverOptions = {}): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const page = await publicGet(url, this.id, { signal: options.signal });
    return extractLinks(page.body, page.url, true)
      .slice(0, limit)
      .map((link) => ({ url: link, title: link, provider: this.id }));
  }
}

async function fetchReadable(url: string, providerId: string, signal?: AbortSignal): Promise<FetchedDocument> {
  const page = await publicGet(url, providerId, { signal });
  const text = extractText(page.body);
  if (!text.trim()) {
    throw new ResearchProviderError(
      `${page.url} returned no extractable text.`,
      providerId,
      'empty',
    );
  }
  return {
    url: page.url,
    title: extractTitle(page.body),
    text,
    contentType: page.contentType,
    publishedAt: extractPublishedAt(page.body) ?? normalizeDate(page.lastModified),
    retrievedAt: new Date().toISOString(),
    provider: providerId,
  };
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------
// RSS / Atom
// ---------------------------------------------------------------------------

/**
 * Feeds are the highest-quality public source available without credentials:
 * the publisher declares the title, the link, and the real publication date.
 */
export class RssProvider implements PublicResearchProvider {
  readonly id = 'rss';

  unavailableReason(): string | undefined {
    return undefined;
  }

  available(): boolean {
    return true;
  }

  async search(): Promise<SearchHit[]> {
    throw new ResearchProviderError(
      'rss reads declared feeds and cannot perform free-text search.',
      this.id,
      'not-configured',
    );
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<FetchedDocument> {
    return fetchReadable(url, this.id, options.signal);
  }

  async discover(feedUrl: string, options: DiscoverOptions = {}): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const feed = await publicGet(feedUrl, this.id, {
      signal: options.signal,
      accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.1',
    });
    return parseFeed(feed.body, this.id).slice(0, limit);
  }
}

/** Both RSS `<item>` and Atom `<entry>`, since publishers use either. */
export function parseFeed(xml: string, provider: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const entries = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ];

  for (const [entry] of entries) {
    const title = tagText(entry, 'title');
    const link =
      /<link[^>]*\bhref=["']([^"']+)["']/i.exec(entry)?.[1] ?? tagText(entry, 'link');
    if (!link || !/^https:\/\//i.test(link)) continue;

    const dateRaw =
      tagText(entry, 'pubDate') ?? tagText(entry, 'published') ?? tagText(entry, 'updated');
    const parsed = dateRaw ? Date.parse(dateRaw) : Number.NaN;

    hits.push({
      url: link.trim(),
      title: title ?? link.trim(),
      snippet: tagText(entry, 'description') ?? tagText(entry, 'summary'),
      publishedAt: Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString(),
      provider,
    });
  }

  return hits;
}

function tagText(source: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(source);
  if (!match) return undefined;
  const cleaned = match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || undefined;
}

// ---------------------------------------------------------------------------
// Public GitHub activity
// ---------------------------------------------------------------------------

/**
 * Public repository metadata through the unauthenticated GitHub API.
 *
 * Anonymous requests are rate-limited to 60/hour, which is a real constraint
 * rather than a bug; when GITHUB_TOKEN is present it is used to raise that
 * limit. Only public repositories, descriptions, topics, and languages are read.
 */
export class PublicGitHubProvider implements PublicResearchProvider {
  readonly id = 'github-public';

  unavailableReason(): string | undefined {
    return undefined;
  }

  available(): boolean {
    return true;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const safe = assertProfessionalQuery(query);
    const limit = Math.max(1, Math.min(options.limit ?? 8, 30));
    const payload = await this.api(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(safe)}&sort=updated&per_page=${limit}`,
      options.signal,
    );

    const items = Array.isArray((payload as { items?: unknown }).items)
      ? ((payload as { items: unknown[] }).items)
      : [];

    return items.flatMap((item) => {
      const repo = item as Record<string, unknown>;
      const url = typeof repo.html_url === 'string' ? repo.html_url : undefined;
      if (!url) return [];
      return [{
        url,
        title: typeof repo.full_name === 'string' ? repo.full_name : url,
        snippet: typeof repo.description === 'string' ? repo.description : undefined,
        publishedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : undefined,
        provider: this.id,
      }];
    });
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<FetchedDocument> {
    return fetchReadable(url, this.id, options.signal);
  }

  /** Public repositories belonging to a public org or user. */
  async discover(ownerUrl: string, options: DiscoverOptions = {}): Promise<SearchHit[]> {
    const owner = /github\.com\/([A-Za-z0-9-]+)\/?$/.exec(ownerUrl)?.[1];
    if (!owner) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));

    const payload = await this.api(
      `https://api.github.com/users/${encodeURIComponent(owner)}/repos?sort=updated&per_page=${limit}&type=owner`,
      options.signal,
    );

    if (!Array.isArray(payload)) return [];
    return payload.flatMap((item) => {
      const repo = item as Record<string, unknown>;
      const url = typeof repo.html_url === 'string' ? repo.html_url : undefined;
      // `private` should never be true on an anonymous response; checked anyway
      // so a token with wider scope cannot widen what this collects.
      if (!url || repo.private === true) return [];
      return [{
        url,
        title: typeof repo.full_name === 'string' ? repo.full_name : url,
        snippet: typeof repo.description === 'string' ? repo.description : undefined,
        publishedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : undefined,
        provider: this.id,
      }];
    });
  }

  private async api(url: string, signal?: AbortSignal): Promise<unknown> {
    const token = process.env.GITHUB_TOKEN?.trim();
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'DacaiLocalAgent/0.1 public research',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }).catch((error: unknown) => {
      throw new ResearchProviderError(
        `GitHub API request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.id,
        'request-failed',
      );
    });

    if (response.status === 403 || response.status === 429) {
      throw new ResearchProviderError(
        'GitHub API rate limit reached for unauthenticated requests. Set GITHUB_TOKEN to raise it.',
        this.id,
        'request-failed',
      );
    }
    if (!response.ok) {
      throw new ResearchProviderError(`GitHub API returned HTTP ${response.status}.`, this.id, 'request-failed');
    }
    return response.json();
  }
}

// ---------------------------------------------------------------------------
// Credentialed providers — implemented, inert until configured
// ---------------------------------------------------------------------------

export class ExaProvider extends ConfigurableProvider {
  readonly id = 'exa';

  protected requiredEnvVar(): string {
    return 'EXA_API_KEY';
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    this.assertAvailable();
    const safe = assertProfessionalQuery(query);
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.EXA_API_KEY!,
      },
      body: JSON.stringify({
        query: safe,
        numResults: Math.max(1, Math.min(options.limit ?? 8, 25)),
        type: 'neural',
      }),
    });
    if (!response.ok) {
      throw new ResearchProviderError(`Exa returned HTTP ${response.status}.`, this.id, 'request-failed');
    }
    const payload = (await response.json()) as { results?: Array<Record<string, unknown>> };
    return (payload.results ?? []).flatMap((entry) => {
      const url = typeof entry.url === 'string' ? entry.url : undefined;
      if (!url) return [];
      return [{
        url,
        title: typeof entry.title === 'string' ? entry.title : url,
        snippet: typeof entry.text === 'string' ? entry.text.slice(0, 500) : undefined,
        publishedAt: typeof entry.publishedDate === 'string' ? entry.publishedDate : undefined,
        provider: this.id,
      }];
    });
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<FetchedDocument> {
    this.assertAvailable();
    return fetchReadable(url, this.id, options.signal);
  }

  async discover(): Promise<SearchHit[]> {
    this.assertAvailable();
    return [];
  }
}

export class FirecrawlProvider extends ConfigurableProvider {
  readonly id = 'firecrawl';

  protected requiredEnvVar(): string {
    return 'FIRECRAWL_API_KEY';
  }

  async search(): Promise<SearchHit[]> {
    this.assertAvailable();
    throw new ResearchProviderError('firecrawl is used for retrieval, not search.', this.id, 'not-configured');
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<FetchedDocument> {
    this.assertAvailable();
    // Routing a request through a third-party fetcher does not widen what may
    // be read: the same collection policy applies as to a direct request.
    try {
      assertPublicSourceUrl(url);
    } catch (error) {
      throw new ResearchProviderError(
        `Refused to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
        this.id,
        'blocked',
      );
    }

    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
      },
      body: JSON.stringify({ url, formats: ['markdown'] }),
    });
    if (!response.ok) {
      throw new ResearchProviderError(`Firecrawl returned HTTP ${response.status}.`, this.id, 'request-failed');
    }
    const payload = (await response.json()) as { data?: { markdown?: string; metadata?: Record<string, unknown> } };
    const text = payload.data?.markdown?.trim();
    if (!text) {
      throw new ResearchProviderError(`Firecrawl returned no content for ${url}.`, this.id, 'empty');
    }
    const metadata = payload.data?.metadata ?? {};
    return {
      url,
      title: typeof metadata.title === 'string' ? metadata.title : undefined,
      text,
      publishedAt: typeof metadata.publishedTime === 'string' ? metadata.publishedTime : undefined,
      retrievedAt: new Date().toISOString(),
      provider: this.id,
    };
  }

  async discover(): Promise<SearchHit[]> {
    this.assertAvailable();
    return [];
  }
}
