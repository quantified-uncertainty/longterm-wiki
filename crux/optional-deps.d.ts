/**
 * Ambient type declarations for optional dependencies that may not be installed.
 *
 * @mendable/firecrawl-js requires Node >=22.0.0 and is listed as an
 * optionalDependency. On Node <22 environments pnpm skips it, so TypeScript
 * would fail to resolve the module. This stub provides minimal types so the
 * code can be type-checked regardless of whether the package is installed.
 *
 * When the package IS installed (Node >=22), TypeScript resolves the real
 * package types from node_modules and this ambient declaration is ignored.
 */

declare module '@mendable/firecrawl-js' {
  interface ScrapeResponse {
    markdown?: string;
    metadata?: {
      title?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  interface BatchScrapeResponse {
    data?: Array<{
      metadata?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
  }

  export default class FirecrawlApp {
    constructor(opts: { apiKey: string });
    scrapeUrl(url: string, opts?: unknown): Promise<ScrapeResponse>;
    batchScrape(urls: string[], opts?: unknown): Promise<BatchScrapeResponse>;
  }
}
