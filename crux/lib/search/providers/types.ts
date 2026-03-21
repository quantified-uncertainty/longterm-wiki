/**
 * Shared interface for domain-specific search providers.
 *
 * Each provider (GitHub, Semantic Scholar, Federal Register) implements this
 * interface. The research agent uses entity-type routing to decide which
 * providers to activate for a given page type.
 */

/** A single search result from any provider. */
export interface SearchHit {
  url: string;
  title: string;
  snippet?: string;
  provider: string;
}

/**
 * A search provider that can discover domain-specific resources.
 *
 * Providers are activated based on entity type via entity-type-routing.ts.
 * Each provider handles its own API authentication and rate limiting.
 */
export interface SearchProvider {
  /** Unique provider name (e.g. 'github', 'semantic-scholar'). */
  name: string;

  /**
   * Search for resources matching the query.
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return
   * @param entityType - Optional entity type to specialize the search strategy
   */
  search(query: string, maxResults: number, entityType?: string): Promise<SearchHit[]>;

  /** Check whether this provider can run (e.g. API key available). */
  isAvailable(): boolean;
}
