/**
 * Footnote Parser — extracts footnote definitions from MDX content
 * and maps them to URLs, deduplicating by unique source.
 *
 * Used by:
 *   - build-data.mjs to compute the footnoteIndex
 *   - crux citations register-resources to auto-create YAML entries
 */

export interface ParsedFootnote {
  /** Footnote number (e.g. 1, 2, 3) */
  number: number;
  /** Raw text of the footnote definition (everything after `[^N]:`) */
  rawText: string;
  /** Extracted URL, if any */
  url: string | null;
  /** Display title — link text if available, otherwise first sentence */
  title: string | null;
}

export interface FootnoteSource {
  /** Canonical URL for this source */
  url: string;
  /** Display title */
  title: string;
  /** Domain name (e.g. "kalshi.com") */
  domain: string;
  /** All footnote numbers that reference this URL */
  footnoteNumbers: number[];
  /** Matched resource ID from YAML data, if any */
  resourceId: string | null;
}

export interface FootnoteParseResult {
  /** All individual footnotes extracted */
  footnotes: ParsedFootnote[];
  /** Deduplicated sources, grouped by URL */
  sources: FootnoteSource[];
  /** Total footnote count */
  totalFootnotes: number;
  /** Unique source URL count */
  uniqueUrls: number;
}

/**
 * Extract the URL from a footnote definition line.
 * Handles formats:
 *   [^1]: [Title](https://example.com)
 *   [^1]: https://example.com
 *   [^1]: [Title](https://example.com) — extra text
 */
function extractUrlFromFootnote(text: string): { url: string | null; title: string | null } {
  // Format: [Title](URL) — markdown link
  const mdLink = text.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  if (mdLink) {
    return { url: cleanUrl(mdLink[2]), title: mdLink[1] };
  }

  // Format: bare URL
  const bareUrl = text.match(/(https?:\/\/[^\s,)"']+)/);
  if (bareUrl) {
    return { url: cleanUrl(bareUrl[1]), title: null };
  }

  return { url: null, title: null };
}

/**
 * Clean trailing punctuation from URLs.
 */
function cleanUrl(url: string): string {
  return url.replace(/[.),:;]+$/, "");
}

/**
 * Normalize a URL for deduplication: strips protocol, www, trailing slashes,
 * and lowercases. This groups footnotes that reference the same source.
 */
export function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(url);
    return (
      u.host.replace(/^www\./, "") +
      u.pathname.replace(/\/+$/, "") +
      u.search
    ).toLowerCase();
  } catch {
    return url.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Extract domain from a URL.
 */
function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Parse all footnote definitions from MDX content.
 *
 * Handles multi-line footnotes where continuation lines are indented.
 * Standard Markdown footnote format:
 *   [^1]: First line content
 *         Continuation line (indented by 2+ spaces or tab)
 */
export function parseFootnotes(content: string): ParsedFootnote[] {
  const footnotes: ParsedFootnote[] = [];
  const lines = content.split("\n");

  let currentFootnote: { number: number; lines: string[] } | null = null;

  for (const line of lines) {
    // Match footnote definition start: [^N]: content
    const fnMatch = line.match(/^\[\^(\d+)\]:\s*(.*)/);

    if (fnMatch) {
      // Save previous footnote if any
      if (currentFootnote) {
        const rawText = currentFootnote.lines.join(" ").trim();
        const { url, title } = extractUrlFromFootnote(rawText);
        footnotes.push({
          number: currentFootnote.number,
          rawText,
          url,
          title: title || extractTitleFromText(rawText),
        });
      }

      currentFootnote = {
        number: parseInt(fnMatch[1], 10),
        lines: [fnMatch[2]],
      };
    } else if (currentFootnote && /^[\t ]{2,}/.test(line)) {
      // Continuation line (indented)
      currentFootnote.lines.push(line.trim());
    } else if (currentFootnote) {
      // Non-continuation line — finalize current footnote
      const rawText = currentFootnote.lines.join(" ").trim();
      const { url, title } = extractUrlFromFootnote(rawText);
      footnotes.push({
        number: currentFootnote.number,
        rawText,
        url,
        title: title || extractTitleFromText(rawText),
      });
      currentFootnote = null;
    }
  }

  // Finalize last footnote
  if (currentFootnote) {
    const rawText = currentFootnote.lines.join(" ").trim();
    const { url, title } = extractUrlFromFootnote(rawText);
    footnotes.push({
      number: currentFootnote.number,
      rawText,
      url,
      title: title || extractTitleFromText(rawText),
    });
  }

  return footnotes;
}

/**
 * Extract a reasonable title from footnote text when no markdown link is found.
 * Takes the first sentence, capped at 120 chars.
 */
function extractTitleFromText(text: string): string | null {
  if (!text) return null;
  // Strip any markdown link syntax
  const cleaned = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  if (!cleaned) return null;
  // If the text is mostly a URL, return it as-is
  if (/^https?:\/\//.test(cleaned)) return cleaned;
  // First sentence — find period followed by space or end (not mid-URL periods)
  const sentence = cleaned.match(/^.+?(?:\.\s|[!?]|$)/)?.[0]?.trim() || cleaned;
  return sentence.length > 120 ? sentence.slice(0, 117) + "..." : sentence;
}

/**
 * Parse footnotes and group them by unique source URL.
 *
 * @param content - Raw MDX content
 * @param urlToResourceId - Optional map of URL → resource ID for matching
 */
export function parseFootnoteSources(
  content: string,
  urlToResourceId?: Map<string, string>
): FootnoteParseResult {
  const footnotes = parseFootnotes(content);

  // Group by normalized URL
  const sourceMap = new Map<string, FootnoteSource>();
  const urlNormToCanonical = new Map<string, string>();

  for (const fn of footnotes) {
    if (!fn.url) continue;

    const normUrl = normalizeUrlForDedup(fn.url);

    if (!sourceMap.has(normUrl)) {
      urlNormToCanonical.set(normUrl, fn.url);

      // Try to find matching resource
      let resourceId: string | null = null;
      if (urlToResourceId) {
        resourceId =
          urlToResourceId.get(fn.url) ??
          urlToResourceId.get(fn.url.replace(/\/$/, "")) ??
          urlToResourceId.get(fn.url.replace(/\/$/, "") + "/") ??
          null;
      }

      sourceMap.set(normUrl, {
        url: fn.url,
        title: fn.title || getDomain(fn.url),
        domain: getDomain(fn.url),
        footnoteNumbers: [fn.number],
        resourceId,
      });
    } else {
      const source = sourceMap.get(normUrl)!;
      source.footnoteNumbers.push(fn.number);
      // Use the better title if this footnote has one
      if (fn.title && source.title === source.domain) {
        source.title = fn.title;
      }
    }
  }

  const sources = [...sourceMap.values()].sort(
    (a, b) => a.footnoteNumbers[0] - b.footnoteNumbers[0]
  );

  return {
    footnotes,
    sources,
    totalFootnotes: footnotes.length,
    uniqueUrls: sources.length,
  };
}
