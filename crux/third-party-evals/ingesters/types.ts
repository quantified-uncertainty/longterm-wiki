/**
 * Shared types for third-party evaluation ingesters (QUA-692).
 *
 * Each ingester returns a list of `IngestCandidate` rows describing reports
 * it discovered. The CLI then fetches + extracts each candidate via the
 * shared LLM extractor pipeline.
 */

export interface IngestCandidate {
  /** The canonical report URL (HTML page, not PDF). */
  url: string;
  /** Optional title hint from the listing page (used as a fallback if extraction fails). */
  title?: string | null;
  /** Optional ISO date hint from the listing page (`lastmod`, `pubDate`, etc.). */
  publishedDate?: string | null;
  /**
   * Where this row came from:
   *   - `sitemap`     UK AISI `/sitemap.xml`
   *   - `rss`         METR feed.xml
   *   - `html-scrape` Apollo / CAISI manual scrape
   */
  sourceSystem: "sitemap" | "rss" | "html-scrape" | "manual";
}

export interface IngestResult {
  evaluator: string;
  candidates: IngestCandidate[];
  /** Errors encountered during ingestion — non-fatal so callers can resume. */
  errors: string[];
}
