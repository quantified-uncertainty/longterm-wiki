/**
 * Domain-Aware Content Fetch Strategies
 *
 * Routes URLs to specialized fetching strategies based on domain.
 * Used by source-fetcher.ts to improve fetch success rates for domains
 * that block generic HTTP requests (403), require API access, or are dead (404).
 *
 * Strategies:
 *   - forum-api: LessWrong, Alignment Forum, EA Forum → GraphQL API
 *   - doi: Academic publishers (Nature, Science, etc.) → CrossRef DOI resolution
 *   - firecrawl-priority: Bot-blocked domains (OpenAI, Reuters, etc.) → Firecrawl first
 *   - wayback: Dead domains / 404s → Wayback Machine archived content
 *   - default: Standard Firecrawl → built-in fetch
 *
 * See: https://github.com/quantified-uncertainty/longterm-wiki/issues/3457
 */

import { forumGraphql, type Forum } from '../forum-api.ts';
import { extractDOI as extractDOIFromUtils } from '../../resource-utils.ts';

// ---------------------------------------------------------------------------
// Strategy Types
// ---------------------------------------------------------------------------

export type ContentFetchStrategy =
  | 'forum-api'
  | 'doi'
  | 'firecrawl-priority'
  | 'wayback-only'
  | 'default';

export interface StrategyResult {
  title: string;
  content: string;
  httpStatus: number;
  fetchMethod: string;
  /** If DOI was resolved, the resolved URL */
  resolvedUrl?: string;
  /** If Wayback was used, the archive URL */
  archiveUrl?: string;
}

// ---------------------------------------------------------------------------
// Domain Lists
// ---------------------------------------------------------------------------

/** Domains where Firecrawl should be tried first (known to block bots). */
const FIRECRAWL_PRIORITY_DOMAINS = [
  'openai.com',
  'rand.org',
  'reuters.com',
  'bloomberg.com',
  'cnas.org',
  'medium.com',
  'wired.com',
  'nytimes.com',
  'washingtonpost.com',
  'theguardian.com',
  'bbc.com',
  'techcrunch.com',
  'cnbc.com',
  'arstechnica.com',
  'technologyreview.com',
  'time.com',
  'ft.com',
];

/** Academic publisher domains where DOI resolution works better than HTTP. */
const DOI_DOMAINS = [
  'nature.com',
  'science.org',
  'springer.com',
  'wiley.com',
  'sciencedirect.com',
  'tandfonline.com',
  'pnas.org',
  'cell.com',
  'sagepub.com',
  'academic.oup.com',
  'doi.org',
];

/** Forum domains that support GraphQL content fetching. */
const FORUM_DOMAINS = [
  'lesswrong.com',
  'alignmentforum.org',
  'forum.effectivealtruism.org',
];

/** Domains known to be permanently dead (site shut down). */
const DEAD_DOMAINS = [
  'fhi.ox.ac.uk',
  'ftxfuturefund.org',
  'safesecureai.org',
  'maliciousaireport.com',
  'thefilterbubble.com',
  'redqueenbio.com',
  'saferai.uk',
  'apollo-research.ai',
  'sparprogram.org',
  'deepfakedetectionchallenge.com',
];

// ---------------------------------------------------------------------------
// Domain Classification
// ---------------------------------------------------------------------------

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function matchesDomainList(hostname: string, domains: string[]): boolean {
  return domains.some(d => hostname === d || hostname.endsWith('.' + d));
}

/**
 * Determine the best content-fetch strategy for a URL.
 */
export function getContentFetchStrategy(url: string): ContentFetchStrategy {
  const hostname = getHostname(url);
  if (!hostname) return 'default';

  if (matchesDomainList(hostname, FORUM_DOMAINS)) return 'forum-api';
  if (matchesDomainList(hostname, DEAD_DOMAINS)) return 'wayback-only';
  if (matchesDomainList(hostname, DOI_DOMAINS)) return 'doi';
  if (matchesDomainList(hostname, FIRECRAWL_PRIORITY_DOMAINS)) return 'firecrawl-priority';

  return 'default';
}

/**
 * Check if a domain is known to be permanently dead (for Wayback-only routing).
 */
export function isDeadDomain(url: string): boolean {
  return matchesDomainList(getHostname(url), DEAD_DOMAINS);
}

/**
 * Check if a domain should prioritize Firecrawl over built-in HTTP.
 */
export function isFirecrawlPriorityDomain(url: string): boolean {
  return matchesDomainList(getHostname(url), FIRECRAWL_PRIORITY_DOMAINS);
}

// ---------------------------------------------------------------------------
// Forum GraphQL Content Fetching
// ---------------------------------------------------------------------------

const FORUM_CONFIGS: Record<string, Forum> = {
  'www.lesswrong.com': { name: 'LessWrong', graphqlUrl: 'https://www.lesswrong.com/graphql', baseUrl: 'https://www.lesswrong.com' },
  'lesswrong.com': { name: 'LessWrong', graphqlUrl: 'https://www.lesswrong.com/graphql', baseUrl: 'https://www.lesswrong.com' },
  'www.alignmentforum.org': { name: 'Alignment Forum', graphqlUrl: 'https://www.alignmentforum.org/graphql', baseUrl: 'https://www.alignmentforum.org' },
  'alignmentforum.org': { name: 'Alignment Forum', graphqlUrl: 'https://www.alignmentforum.org/graphql', baseUrl: 'https://www.alignmentforum.org' },
  'forum.effectivealtruism.org': { name: 'EA Forum', graphqlUrl: 'https://forum.effectivealtruism.org/graphql', baseUrl: 'https://forum.effectivealtruism.org' },
};

/**
 * Extract post ID from a forum URL.
 * Handles: /posts/{id}/{slug}, /posts/{id}, /s/{id}/p/{id}
 */
function extractForumPostId(url: string): string | null {
  // Standard post URL: /posts/{postId}/{slug}
  const postMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/);
  if (postMatch) return postMatch[1];

  // Sequence post URL: /s/{seqId}/p/{postId}
  const seqMatch = url.match(/\/s\/[a-zA-Z0-9]+\/p\/([a-zA-Z0-9]+)/);
  if (seqMatch) return seqMatch[1];

  return null;
}

/**
 * Fetch forum post content via GraphQL API.
 * Returns markdown content directly from the forum's API.
 */
export async function fetchForumContent(url: string): Promise<StrategyResult | null> {
  const hostname = getHostname(url);
  const forum = FORUM_CONFIGS[hostname];
  if (!forum) return null;

  const postId = extractForumPostId(url);
  if (!postId) return null;

  try {
    const data = await forumGraphql(forum.graphqlUrl, `
      query GetPostContent($id: String!) {
        post(input: { selector: { _id: $id } }) {
          result {
            title
            contents {
              markdown
            }
            user { displayName }
            coauthors { displayName }
            postedAt
          }
        }
      }
    `, { id: postId }) as {
      data?: {
        post?: {
          result?: {
            title: string;
            contents?: { markdown?: string };
            user?: { displayName: string };
            coauthors?: { displayName: string }[];
            postedAt?: string;
          };
        };
      };
    };

    const post = data?.data?.post?.result;
    if (!post) return null;

    const markdown = post.contents?.markdown;
    if (!markdown || markdown.length === 0) return null;

    // Build a content string with metadata header
    const authors = [
      post.user?.displayName,
      ...(post.coauthors?.map(c => c.displayName) ?? []),
    ].filter(Boolean).join(', ');

    const header = [
      `# ${post.title}`,
      authors ? `By ${authors}` : '',
      post.postedAt ? `Published: ${post.postedAt.split('T')[0]}` : '',
      '',
    ].filter(Boolean).join('\n');

    const content = (header + '\n' + markdown).slice(0, 100_000);

    return {
      title: post.title,
      content,
      httpStatus: 200,
      fetchMethod: 'forum-api',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fetch-strategies] Forum API failed for ${url}: ${msg.slice(0, 200)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// DOI Resolution Content Fetching
// ---------------------------------------------------------------------------

const CROSSREF_BASE = 'https://api.crossref.org';
const CROSSREF_USER_AGENT = 'LongtermWiki/1.0 (mailto:contact@longtermwiki.com)';

/**
 * Extract a DOI from a URL. Tries the shared extractDOI utility first,
 * then falls back to a broader regex for publisher URLs with embedded DOIs.
 */
function extractDoi(url: string): string | null {
  const fromUtils = extractDOIFromUtils(url);
  if (fromUtils && fromUtils.startsWith('10.')) return fromUtils;

  // Broader match for DOIs embedded in publisher URL paths (e.g., pnas.org/doi/full/10.1073/...)
  const pathMatch = url.match(/(10\.\d{4,}\/[^\s?#]+)/);
  if (pathMatch) return pathMatch[1];

  return null;
}

interface CrossrefWork {
  DOI: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  abstract?: string;
  'container-title'?: string[];
  'published-print'?: { 'date-parts': number[][] };
  'published-online'?: { 'date-parts': number[][] };
  issued?: { 'date-parts': number[][] };
}

/**
 * Fetch content via DOI resolution through CrossRef.
 * Gets structured metadata (title, abstract, authors) which is more
 * reliable than scraping publisher pages that block bots.
 */
export async function fetchDoiContent(url: string): Promise<StrategyResult | null> {
  const doi = extractDoi(url);
  if (!doi) return null;

  try {
    const apiUrl = `${CROSSREF_BASE}/works/${encodeURIComponent(doi)}`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': CROSSREF_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as { status: string; message: CrossrefWork };
    if (data.status !== 'ok') return null;

    const work = data.message;
    const title = work.title?.[0] ?? '';
    const journal = work['container-title']?.[0] ?? '';

    // Clean abstract (strip JATS/HTML tags)
    const abstractRaw = work.abstract ?? '';
    const abstract = abstractRaw
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Format authors
    const authors = (work.author ?? [])
      .map(a => a.name ?? [a.given, a.family].filter(Boolean).join(' '))
      .filter(Boolean);

    // Extract publication date
    const dateParts = (
      work['published-print'] ?? work['published-online'] ?? work.issued
    )?.['date-parts']?.[0];
    const pubDate = dateParts
      ? dateParts.map(p => String(p).padStart(2, '0')).join('-')
      : '';

    // Build structured content
    const contentParts = [
      `# ${title}`,
      authors.length > 0 ? `Authors: ${authors.join(', ')}` : '',
      journal ? `Journal: ${journal}` : '',
      pubDate ? `Published: ${pubDate}` : '',
      `DOI: ${work.DOI}`,
      '',
      abstract ? `## Abstract\n\n${abstract}` : '',
    ].filter(Boolean);

    const content = contentParts.join('\n');

    if (content.length < 50) return null; // Not enough content

    return {
      title,
      content,
      httpStatus: 200,
      fetchMethod: 'doi-crossref',
      resolvedUrl: `https://doi.org/${work.DOI}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fetch-strategies] DOI resolution failed for ${url}: ${msg.slice(0, 200)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wayback Machine Content Fetching
// ---------------------------------------------------------------------------

/**
 * Look up a Wayback Machine snapshot URL.
 */
async function lookupWaybackSnapshot(url: string): Promise<{ archiveUrl: string; timestamp: string } | null> {
  // Strategy 1: Availability API
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)' },
      signal: AbortSignal.timeout(8_000),
    });

    if (response.ok) {
      const data = await response.json() as {
        archived_snapshots?: { closest?: { url: string; timestamp: string; available: boolean } };
      };
      const snapshot = data?.archived_snapshots?.closest;
      if (snapshot?.available && snapshot.url) {
        return { archiveUrl: snapshot.url, timestamp: snapshot.timestamp };
      }
    }
  } catch {
    // Fall through to direct URL approach
  }

  // Strategy 2: Direct Wayback URL — follows redirect to closest snapshot
  try {
    const directUrl = `https://web.archive.org/web/2024/${url}`;
    const response = await fetch(directUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': 'LongtermWikiBot/1.0 (+https://www.longtermwiki.com)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('location');
      if (location?.includes('web.archive.org/web/')) {
        const tsMatch = location.match(/\/web\/(\d{14})\//);
        return { archiveUrl: location, timestamp: tsMatch?.[1] ?? 'unknown' };
      }
    }
    if (response.ok) {
      return { archiveUrl: directUrl, timestamp: 'unknown' };
    }
  } catch {
    // Both strategies failed
  }

  return null;
}

/**
 * Extract text content from a Wayback Machine archived HTML page.
 */
function extractWaybackText(html: string): { title: string | null; content: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, ' ').trim()
    : null;

  // Convert HTML to plain text
  const content = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove Wayback Machine toolbar
    .replace(/<!-- BEGIN WAYBACK TOOLBAR[\s\S]*?END WAYBACK TOOLBAR -->/gi, '')
    .replace(/<div id="wm-ipp-base"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '')
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, content };
}

/**
 * Fetch content from the Wayback Machine for a dead or unreachable URL.
 */
export async function fetchWaybackContent(url: string): Promise<StrategyResult | null> {
  const snapshot = await lookupWaybackSnapshot(url);
  if (!snapshot) return null;

  try {
    const response = await fetch(snapshot.archiveUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;

    const ct = response.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return null; // Skip non-HTML (PDFs etc.)
    }

    const html = await response.text();
    const { title, content } = extractWaybackText(html);

    if (content.length < 100) return null; // Too little content

    return {
      title: title ?? '',
      content: content.slice(0, 100_000),
      httpStatus: 200,
      fetchMethod: 'wayback',
      archiveUrl: snapshot.archiveUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fetch-strategies] Wayback fetch failed for ${url}: ${msg.slice(0, 200)}`);
    return null;
  }
}
