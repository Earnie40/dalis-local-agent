/**
 * Public research provider contract.
 *
 * Adapters differ in how they find and fetch pages; they do not differ in what
 * they are allowed to reach. Every adapter routes through the policy checks in
 * ../sources.ts, so adding a provider cannot widen the collection boundary.
 *
 * The contract has one unusual property worth stating plainly: **a provider that
 * cannot retrieve something returns nothing and says why.** There is no path
 * where an adapter substitutes a plausible-looking result for a real one, and
 * `available()` returning false is a normal, reportable state rather than an
 * error to route around.
 */

export interface SearchHit {
  url: string;
  title: string;
  snippet?: string;
  /** Provider-reported publication date, when it exposes one. */
  publishedAt?: string;
  /** Which adapter produced this, for provenance. */
  provider: string;
}

export interface FetchedDocument {
  url: string;
  title?: string;
  /** Extracted readable text. Never raw markup. */
  text: string;
  contentType?: string;
  publishedAt?: string;
  retrievedAt: string;
  provider: string;
}

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface DiscoverOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface PublicResearchProvider {
  /** Stable adapter id, recorded on every signal for provenance. */
  readonly id: string;

  /** Human-readable reason this provider is unusable, when it is. */
  unavailableReason(): string | undefined;

  available(): boolean;

  /** Free-text search over public pages. */
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;

  /** Retrieve and extract one specific public page. */
  fetch(url: string, options?: { signal?: AbortSignal }): Promise<FetchedDocument>;

  /**
   * Enumerate further public URLs reachable from a known one — a feed, a
   * sitemap, a listing page. Providers that cannot do this return an empty
   * array rather than guessing at URLs that may not exist.
   */
  discover(url: string, options?: DiscoverOptions): Promise<SearchHit[]>;
}

export class ResearchProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly code: 'not-configured' | 'request-failed' | 'blocked' | 'empty',
  ) {
    super(message);
    this.name = 'ResearchProviderError';
  }
}

/** Base for adapters that are configured by an API key that may be absent. */
export abstract class ConfigurableProvider implements PublicResearchProvider {
  abstract readonly id: string;

  protected abstract requiredEnvVar(): string | undefined;

  unavailableReason(): string | undefined {
    const variable = this.requiredEnvVar();
    if (!variable) return undefined;
    return process.env[variable]?.trim()
      ? undefined
      : `${this.id} is not configured: ${variable} is not set.`;
  }

  available(): boolean {
    return this.unavailableReason() === undefined;
  }

  protected assertAvailable(): void {
    const reason = this.unavailableReason();
    if (reason) throw new ResearchProviderError(reason, this.id, 'not-configured');
  }

  abstract search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  abstract fetch(url: string, options?: { signal?: AbortSignal }): Promise<FetchedDocument>;
  abstract discover(url: string, options?: DiscoverOptions): Promise<SearchHit[]>;
}
