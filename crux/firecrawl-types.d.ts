/**
 * Module declaration for @mendable/firecrawl-js (optional dependency).
 *
 * This package is an optionalDependency and may not be installed in all
 * environments (e.g. Node <22 due to engine requirements). All code that
 * imports it uses try-catch runtime guards, but TypeScript still needs a
 * type declaration to avoid TS2307 "Cannot find module" errors.
 */
declare module '@mendable/firecrawl-js' {
  interface ScrapeOptions {
    formats?: string[];
    [key: string]: unknown;
  }

  interface ScrapeResult {
    markdown?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface BatchScrapeResult {
    data?: Array<{ metadata?: Record<string, unknown>; [key: string]: unknown }>;
    [key: string]: unknown;
  }

  class FirecrawlApp {
    constructor(options: { apiKey: string });
    scrapeUrl(url: string, options?: ScrapeOptions): Promise<ScrapeResult>;
    batchScrape(urls: string[], options?: unknown): Promise<BatchScrapeResult>;
  }

  export default FirecrawlApp;
}
