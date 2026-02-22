/**
 * Citation Archive — per-page citation verification records
 *
 * Stores metadata about every citation URL in a wiki page:
 * when it was fetched, what HTTP status it returned, what page title
 * was found, a content snippet for human verification, and the claim
 * context from the wiki page where the citation is used.
 *
 * Data is stored in data/citation-archive/<page-id>.yaml.
 *
 * Usage:
 *   import { readCitationArchive, writeCitationArchive, extractCitationsFromContent, saveFetchResultToPostgres } from './citation-archive.ts';
 *
 * Part of the hallucination risk reduction initiative (issue #200).
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { citationContent } from './knowledge-db.ts';
import { upsertCitationContent } from './wiki-server/citations.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationStatus = 'verified' | 'broken' | 'unverifiable' | 'pending';

export interface CitationRecord {
  /** Footnote number, e.g. 1 for [^1] */
  footnote: number;
  /** The citation URL */
  url: string;
  /** The title text from the footnote definition, e.g. [Title](url) → Title */
  linkText: string;
  /** Surrounding text from the wiki page where this citation is referenced */
  claimContext: string;
  /** ISO timestamp when the URL was fetched */
  fetchedAt: string | null;
  /** HTTP status code from fetch attempt */
  httpStatus: number | null;
  /** Page title extracted from the fetched HTML */
  pageTitle: string | null;
  /** First ~500 chars of text content from the fetched page */
  contentSnippet: string | null;
  /** Byte length of the fetched content */
  contentLength: number | null;
  /** Overall verification status */
  status: VerificationStatus;
  /** Human or automated note about verification */
  note: string | null;
}

export interface CitationArchiveFile {
  pageId: string;
  verifiedAt: string;
  totalCitations: number;
  verified: number;
  broken: number;
  unverifiable: number;
  citations: CitationRecord[];
}

/** Raw citation extracted from MDX content (before verification) */
export interface ExtractedCitation {
  footnote: number;
  url: string;
  linkText: string;
  claimContext: string;
  /** Line number of the footnote reference in the body */
  refLine: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const ARCHIVE_DIR = path.join(ROOT, 'data/citation-archive');

function archiveFilePath(pageId: string): string {
  return path.join(ARCHIVE_DIR, `${pageId}.yaml`);
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function readCitationArchive(pageId: string): CitationArchiveFile | null {
  const filePath = archiveFilePath(pageId);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parseYaml(raw) as CitationArchiveFile;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: failed to read citation archive ${filePath}: ${msg}`);
    return null;
  }
}

export function writeCitationArchive(archive: CitationArchiveFile): void {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const yaml = stringifyYaml(archive, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });
  fs.writeFileSync(archiveFilePath(archive.pageId), yaml, 'utf-8');
}

export function listArchivedPages(): string[] {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  try {
    return fs.readdirSync(ARCHIVE_DIR)
      .filter((f: string) => f.endsWith('.yaml'))
      .map((f: string) => f.replace(/\.yaml$/, ''))
      .sort();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: failed to list citation archives: ${msg}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Citation extraction from MDX content
// ---------------------------------------------------------------------------

/**
 * Extract all footnote citations from MDX content.
 *
 * Finds footnote definitions like:
 *   [^1]: [Title](https://example.com/path)
 *   [^2]: https://example.com/bare-url
 *
 * Then locates where each footnote is referenced in the body to capture
 * the surrounding claim context.
 */
export function extractCitationsFromContent(body: string): ExtractedCitation[] {
  const lines = body.split('\n');
  const citations: ExtractedCitation[] = [];

  // Step 1: Parse footnote definitions
  const footnoteDefinitions = new Map<number, { url: string; linkText: string; defLine: number }>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern 1: [^N]: [Title](URL) optional-description
    // Captures: (1) footnote number, (2) link title, (3) URL, (4) optional trailing text
    const titledMatch = line.match(/^\[\^(\d+)\]:\s*\[([^\]]*)\]\((https?:\/\/[^)]+)\)(?:\s+(.+))?/);
    if (titledMatch) {
      const desc = titledMatch[4]?.trim();
      footnoteDefinitions.set(parseInt(titledMatch[1], 10), {
        url: titledMatch[3],
        linkText: titledMatch[2] + (desc ? ` — ${desc}` : ''),
        defLine: i,
      });
      continue;
    }

    // Pattern 2: [^N]: ...text... [Title](URL) ...text...
    // Academic style: Author, "[Title](URL)," Source, Year.
    // The link is embedded within descriptive text, not at the start.
    const embeddedMatch = line.match(/^\[\^(\d+)\]:\s*(.+?)\[([^\]]*)\]\((https?:\/\/[^)]+)\)(.*)/);
    if (embeddedMatch) {
      const prefix = embeddedMatch[2].trim();
      const linkTitle = embeddedMatch[3];
      const suffix = embeddedMatch[5]?.trim().replace(/^[,.]?\s*/, '') || '';
      const fullText = [prefix, linkTitle, suffix].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim();
      footnoteDefinitions.set(parseInt(embeddedMatch[1], 10), {
        url: embeddedMatch[4],
        linkText: fullText || linkTitle,
        defLine: i,
      });
      continue;
    }

    // Pattern 3: [^N]: Descriptive text https://bare-url
    // Text followed by a bare URL (common in academic citations and informal footnotes)
    // e.g. [^1]: TransformerLens GitHub repository: https://github.com/...
    // e.g. [^3]: Author et al. (2021). "Title." Journal. https://example.com/paper
    const textThenUrlMatch = line.match(/^\[\^(\d+)\]:\s*(.+?)\s+(https?:\/\/[^\s]+)\s*$/);
    if (textThenUrlMatch) {
      const description = textThenUrlMatch[2].replace(/[:.]\s*$/, '').trim();
      footnoteDefinitions.set(parseInt(textThenUrlMatch[1], 10), {
        url: textThenUrlMatch[3],
        linkText: description,
        defLine: i,
      });
      continue;
    }

    // Pattern 4: [^N]: URL (bare URL, no title)
    // Captures: (1) footnote number, (2) URL
    const bareMatch = line.match(/^\[\^(\d+)\]:\s*(https?:\/\/[^\s]+)/);
    if (bareMatch) {
      footnoteDefinitions.set(parseInt(bareMatch[1], 10), {
        url: bareMatch[2],
        linkText: '',
        defLine: i,
      });
      continue;
    }
  }

  // Step 2: For each footnote, find where it's referenced and capture context
  for (const [footnoteNum, def] of footnoteDefinitions) {
    const refPattern = new RegExp(`\\[\\^${footnoteNum}\\](?!:)`, 'g');
    let claimContext = '';
    let refLine = 0;

    for (let i = 0; i < lines.length; i++) {
      // Skip footnote definition lines
      if (lines[i].trim().startsWith(`[^${footnoteNum}]:`)) continue;

      if (refPattern.test(lines[i])) {
        refLine = i + 1; // 1-indexed
        // Capture surrounding context: the line with the reference + prev/next lines
        const contextLines: string[] = [];
        if (i > 0) contextLines.push(lines[i - 1].trim());
        contextLines.push(lines[i].trim());
        if (i < lines.length - 1) contextLines.push(lines[i + 1].trim());

        claimContext = contextLines
          .filter(l => l.length > 0)
          .join(' ')
          .replace(/\s+/g, ' ')
          .slice(0, 300);
        break;
      }
    }

    if (!claimContext) {
      // Fallback: use text around the definition if no reference found
      claimContext = `(footnote definition only, no inline reference found)`;
    }

    citations.push({
      footnote: footnoteNum,
      url: def.url,
      linkText: def.linkText,
      claimContext,
      refLine,
    });
  }

  // Sort by footnote number
  citations.sort((a, b) => a.footnote - b.footnote);

  return citations;
}

// ---------------------------------------------------------------------------
// Claim sentence extraction (more precise than claimContext)
// ---------------------------------------------------------------------------

/**
 * Extract the specific sentence containing a footnote reference [^N].
 *
 * Unlike `extractCitationsFromContent()` which captures ~300 chars of surrounding
 * context, this function isolates just the sentence(s) containing the footnote
 * marker. This is better input for LLM quote extraction.
 */
export function extractClaimSentence(body: string, footnoteNum: number): string {
  const lines = body.split('\n');
  const refPattern = new RegExp(`\\[\\^${footnoteNum}\\](?!:)`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip footnote definition lines
    if (line.trim().startsWith(`[^${footnoteNum}]:`)) continue;

    if (refPattern.test(line)) {
      const trimmed = line.trim();

      // Detect if this line is part of a list item:
      // - Direct list item (starts with - or * or N.)
      // - Continuation of a list item (indented, preceded by a list item)
      const isDirectListItem = /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line);
      let isListContinuation = false;
      let listItemStartLine = i;

      if (!isDirectListItem && /^\s+/.test(line)) {
        // Check if this is a continuation line of a list item above
        for (let j = i - 1; j >= 0; j--) {
          const above = lines[j];
          if (above.trim() === '') break;
          if (/^\s*[-*]\s/.test(above) || /^\s*\d+\.\s/.test(above)) {
            isListContinuation = true;
            listItemStartLine = j;
            break;
          }
          // If we hit a non-indented, non-list line, it's not a continuation
          if (!/^\s+/.test(above)) break;
        }
      }

      if (isDirectListItem || isListContinuation) {
        // Collect the full list item from its start through continuations
        const itemLines: string[] = [];
        for (let j = listItemStartLine; j < lines.length; j++) {
          const l = lines[j];
          const lt = l.trim();
          if (j > listItemStartLine) {
            // Stop at blank lines, headings, new list items, or block elements
            if (
              lt === '' ||
              lt.startsWith('#') ||
              /^[-*]\s/.test(lt) ||
              /^\d+\.\s/.test(lt) ||
              lt.startsWith('|') ||
              lt.startsWith('---') ||
              lt.startsWith('```')
            ) break;
          }
          itemLines.push(lt);
        }

        return itemLines
          .join(' ')
          .replace(/\[\^\d+\]/g, '') // Strip footnote markers
          .replace(/\s+/g, ' ')
          .trim();
      }

      // For non-list text: build paragraph as before
      const paragraphLines: string[] = [];

      // Collect lines in the current paragraph (backward from reference line)
      for (let j = i; j >= 0; j--) {
        const l = lines[j].trim();
        if (l === '' || l.startsWith('#') || l.startsWith('|') || l.startsWith('---') || l.startsWith('```')) break;
        paragraphLines.unshift(l);
      }
      // Collect lines in the current paragraph (forward from reference line)
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l === '' || l.startsWith('#') || l.startsWith('|') || l.startsWith('---') || l.startsWith('```')) break;
        paragraphLines.push(l);
      }

      const paragraph = paragraphLines.join(' ').replace(/\s+/g, ' ');

      // Split paragraph into sentences (crude but effective)
      // Use regex to split on period/question mark/exclamation followed by space or end
      const sentences = paragraph.split(/(?<=[.!?])\s+/);

      // Find the sentence(s) containing the footnote marker
      const refRegex = new RegExp(`\\[\\^${footnoteNum}\\]`);
      const matchingSentences = sentences.filter((s) => refRegex.test(s));

      if (matchingSentences.length > 0) {
        return matchingSentences
          .join(' ')
          .replace(/\[\^\d+\]/g, '') // Strip footnote markers for cleaner claim text
          .replace(/\s+/g, ' ')
          .trim();
      }

      // Fallback: return the whole reference line
      return line
        .replace(/\[\^\d+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Content fetching
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15000;
const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; LongtermWikiCitationVerifier/1.0)';

/** Domains that block automated access — mark as unverifiable */
const UNVERIFIABLE_DOMAINS = [
  'twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 't.co',
  'instagram.com', 'tiktok.com',
];

/** Domains known to be reliable but that block scraping */
const SKIP_SCRAPE_DOMAINS = [
  'academic.oup.com', 'jstor.org', 'dl.acm.org', 'ieee.org',
  'proceedings.neurips.cc', 'cambridge.org',
];

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function isUnverifiable(url: string): boolean {
  const domain = getDomain(url);
  return UNVERIFIABLE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

function isSkipScrape(url: string): boolean {
  const domain = getDomain(url);
  return SKIP_SCRAPE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

/** Extract <title> from HTML */
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip HTML tags and extract text content */
function extractTextContent(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FetchResult {
  httpStatus: number;
  pageTitle: string | null;
  contentSnippet: string | null;
  contentLength: number;
  contentType: string | null;
  fullHtml: string | null;
  fullText: string | null;
  error: string | null;
}

/**
 * Fetch a URL and extract metadata for citation verification.
 * Returns page title, content snippet, and HTTP status.
 */
export async function fetchCitationUrl(url: string): Promise<FetchResult> {
  if (isUnverifiable(url)) {
    return {
      httpStatus: -1,
      pageTitle: null,
      contentSnippet: null,
      contentLength: 0,
      contentType: null,
      fullHtml: null,
      fullText: null,
      error: 'unverifiable domain (social media)',
    };
  }

  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': FETCH_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });

      const status = response.status;
      const contentType = response.headers.get('content-type') || '';

      // Retry on 5xx server errors and 429 rate limits
      if ((status >= 500 || status === 429) && attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        return {
          httpStatus: status,
          pageTitle: null,
          contentSnippet: null,
          contentLength: 0,
          contentType,
          fullHtml: null,
          fullText: null,
          error: `HTTP ${status}`,
        };
      }

      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const isPdf = contentType.includes('application/pdf');

      if (isPdf) {
        return {
          httpStatus: status,
          pageTitle: '(PDF document)',
          contentSnippet: null,
          contentLength: parseInt(response.headers.get('content-length') || '0', 10),
          contentType,
          fullHtml: null,
          fullText: null,
          error: null,
        };
      }

      if (!isHtml) {
        return {
          httpStatus: status,
          pageTitle: null,
          contentSnippet: `(non-HTML content: ${contentType})`,
          contentLength: parseInt(response.headers.get('content-length') || '0', 10),
          contentType,
          fullHtml: null,
          fullText: null,
          error: null,
        };
      }

      const html = await response.text();
      const title = extractTitle(html);
      const text = extractTextContent(html);
      const snippet = text.slice(0, 500);

      return {
        httpStatus: status,
        pageTitle: title,
        contentSnippet: snippet || null,
        contentLength: html.length,
        contentType,
        fullHtml: html,
        fullText: text,
        error: null,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isTransient = message.includes('abort') || message.includes('ECONNRESET')
        || message.includes('socket hang up') || message.includes('timeout');

      // Retry transient network errors
      if (isTransient && attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return {
        httpStatus: 0,
        pageTitle: null,
        contentSnippet: null,
        contentLength: 0,
        contentType: null,
        fullHtml: null,
        fullText: null,
        error: message.includes('abort') ? 'timeout' : message,
      };
    }
  }

  // Unreachable, but TypeScript needs it
  return {
    httpStatus: 0, pageTitle: null, contentSnippet: null, contentLength: 0,
    contentType: null, fullHtml: null, fullText: null, error: 'max retries exceeded',
  };
}

/**
 * Store full fetched content in the SQLite knowledge database.
 * knowledge-db uses lazy initialization, so this is safe to call without
 * triggering DB creation until the upsert actually runs.
 */
function storeCitationContent(
  url: string,
  pageId: string,
  footnote: number,
  result: FetchResult,
) {
  try {
    citationContent.upsert({
      url,
      pageId,
      footnote,
      fetchedAt: new Date().toISOString(),
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      pageTitle: result.pageTitle,
      fullHtml: result.fullHtml,
      fullText: result.fullText,
      contentLength: result.contentLength,
    });
  } catch {
    // SQLite storage is best-effort — don't fail verification if DB is unavailable
  }
}

/**
 * Fire-and-forget write of fetched content to PostgreSQL (wiki-server).
 * Mirrors source-fetcher.ts::saveToPostgres — errors are silently ignored
 * so the calling operation isn't blocked when the wiki-server is unavailable.
 *
 * Exported so extract-quotes and verify-quotes can also push content to PG.
 */
export function saveFetchResultToPostgres(url: string, result: FetchResult): void {
  if (!result.fullText && !result.fullHtml) return;
  const text = result.fullText || '';
  if (text.length === 0) return;

  upsertCitationContent({
    url,
    fetchedAt: new Date().toISOString(),
    httpStatus: result.httpStatus,
    contentType: result.contentType ?? null,
    pageTitle: result.pageTitle ?? null,
    fullText: text,
    contentLength: result.contentLength,
  }).catch(() => {
    // Best-effort — don't fail verification if wiki-server is unavailable
  });
}

/**
 * Verify all citations on a page: fetch each URL, store results.
 * Metadata is saved to YAML (in git). Full content is stored in SQLite (.cache/knowledge.db)
 * and PostgreSQL (wiki-server) for cross-environment access.
 */
export async function verifyCitationsForPage(
  pageId: string,
  body: string,
  opts: { concurrency?: number; delayMs?: number; verbose?: boolean } = {},
): Promise<CitationArchiveFile> {
  const concurrency = opts.concurrency ?? 5;
  const delayMs = opts.delayMs ?? 1000;
  const verbose = opts.verbose ?? false;

  const extracted = extractCitationsFromContent(body);
  const citations: CitationRecord[] = [];

  // Process in batches with concurrency limit
  for (let i = 0; i < extracted.length; i += concurrency) {
    const batch = extracted.slice(i, i + concurrency);

    const results = await Promise.all(
      batch.map(async (ext) => {
        if (verbose) {
          process.stdout.write(`  [^${ext.footnote}] ${ext.url.slice(0, 60)}...`);
        }

        let record: CitationRecord;

        if (isUnverifiable(ext.url)) {
          record = {
            footnote: ext.footnote,
            url: ext.url,
            linkText: ext.linkText,
            claimContext: ext.claimContext,
            fetchedAt: new Date().toISOString(),
            httpStatus: null,
            pageTitle: null,
            contentSnippet: null,
            contentLength: null,
            status: 'unverifiable',
            note: 'Social media domain — cannot verify automatically',
          };
        } else if (isSkipScrape(ext.url)) {
          const result = await fetchCitationUrl(ext.url);
          record = {
            footnote: ext.footnote,
            url: ext.url,
            linkText: ext.linkText,
            claimContext: ext.claimContext,
            fetchedAt: new Date().toISOString(),
            httpStatus: result.httpStatus,
            pageTitle: result.pageTitle,
            contentSnippet: null,
            contentLength: result.contentLength,
            status: result.httpStatus >= 200 && result.httpStatus < 400 ? 'verified' : 'broken',
            note: result.error ? `Academic publisher: ${result.error}` : 'Academic publisher — URL accessible',
          };
          // Store whatever content we got from academic publishers
          storeCitationContent(ext.url, pageId, ext.footnote, result);
          saveFetchResultToPostgres(ext.url, result);
        } else {
          const result = await fetchCitationUrl(ext.url);
          const status: VerificationStatus =
            result.httpStatus >= 200 && result.httpStatus < 400 ? 'verified' :
            result.httpStatus === 0 && result.error === 'timeout' ? 'unverifiable' :
            'broken';

          record = {
            footnote: ext.footnote,
            url: ext.url,
            linkText: ext.linkText,
            claimContext: ext.claimContext,
            fetchedAt: new Date().toISOString(),
            httpStatus: result.httpStatus,
            pageTitle: result.pageTitle,
            contentSnippet: result.contentSnippet,
            contentLength: result.contentLength,
            status,
            note: result.error,
          };
          // Store full HTML + text content in SQLite + PostgreSQL
          if (result.fullHtml || result.fullText) {
            storeCitationContent(ext.url, pageId, ext.footnote, result);
            saveFetchResultToPostgres(ext.url, result);
          }
        }

        if (verbose) {
          const icon = record.status === 'verified' ? ' ✓' :
                       record.status === 'broken' ? ' ✗' :
                       record.status === 'unverifiable' ? ' ?' : ' …';
          console.log(icon);
        }

        return record;
      }),
    );

    citations.push(...results);

    // Delay between batches to be polite
    if (i + concurrency < extracted.length && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const archive: CitationArchiveFile = {
    pageId,
    verifiedAt: new Date().toISOString().slice(0, 10),
    totalCitations: citations.length,
    verified: citations.filter(c => c.status === 'verified').length,
    broken: citations.filter(c => c.status === 'broken').length,
    unverifiable: citations.filter(c => c.status === 'unverifiable').length,
    citations,
  };

  writeCitationArchive(archive);

  return archive;
}
