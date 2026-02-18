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
 *   import { readCitationArchive, writeCitationArchive, extractCitationsFromContent } from './citation-archive.ts';
 *
 * Part of the hallucination risk reduction initiative (issue #200).
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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
  } catch {
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
  } catch {
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

    // Pattern 1: [^N]: [Title](URL) with optional trailing description
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

    // Pattern 2: [^N]: URL (bare URL)
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
      error: 'unverifiable domain (social media)',
    };
  }

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

    if (!response.ok) {
      return {
        httpStatus: status,
        pageTitle: null,
        contentSnippet: null,
        contentLength: 0,
        error: `HTTP ${status}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
    const isPdf = contentType.includes('application/pdf');

    if (isPdf) {
      // PDFs exist but we can't extract content easily — mark as verified by status
      return {
        httpStatus: status,
        pageTitle: '(PDF document)',
        contentSnippet: null,
        contentLength: parseInt(response.headers.get('content-length') || '0', 10),
        error: null,
      };
    }

    if (!isHtml) {
      return {
        httpStatus: status,
        pageTitle: null,
        contentSnippet: `(non-HTML content: ${contentType})`,
        contentLength: parseInt(response.headers.get('content-length') || '0', 10),
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
      error: null,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      httpStatus: 0,
      pageTitle: null,
      contentSnippet: null,
      contentLength: 0,
      error: message.includes('abort') ? 'timeout' : message,
    };
  }
}

/**
 * Verify all citations on a page: fetch each URL, store results.
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
          // For academic publishers: do a HEAD check only
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
