/**
 * Type declarations for the optional @mendable/firecrawl-js package.
 *
 * This package is listed in optionalDependencies and may not be installed in
 * all environments (e.g. CI without FIRECRAWL_KEY). All call sites guard with
 * a try/catch so missing-module errors are handled at runtime. These
 * declarations satisfy TypeScript's static analysis without requiring the
 * package to be installed.
 */
declare module '@mendable/firecrawl-js' {
  interface ScrapeResponse {
    markdown?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface BatchScrapeResponse {
    data?: Array<{ metadata?: Record<string, unknown>; [key: string]: unknown }>;
    [key: string]: unknown;
  }

  class FirecrawlApp {
    constructor(opts: { apiKey: string });
    scrapeUrl(url: string, opts?: unknown): Promise<ScrapeResponse>;
    batchScrape(urls: string[], opts?: unknown): Promise<BatchScrapeResponse>;
  }

  export default FirecrawlApp;
}
