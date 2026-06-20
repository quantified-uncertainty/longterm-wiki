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
import { lookupAndFetchWayback } from '../wayback.ts';

// ---------------------------------------------------------------------------
// Strategy Types
// ---------------------------------------------------------------------------

export type ContentFetchStrategy =
  | 'forum-api'
  | 'doi'
  | 'firecrawl-priority'
  | 'playwright-priority'
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
  'www.rand.org',
  'www.reuters.com',
  'reuters.com',
  'www.bloomberg.com',
  'bloomberg.com',
  'www.cnas.org',
  'cnas.org',
  'medium.com',
  'www.wired.com',
  'wired.com',
  'www.nytimes.com',
  'nytimes.com',
  'www.washingtonpost.com',
  'washingtonpost.com',
  'www.theguardian.com',
  'theguardian.com',
  'www.bbc.com',
  'bbc.com',
  'techcrunch.com',
  'www.techcrunch.com',
  'www.cnbc.com',
  'cnbc.com',
  'arstechnica.com',
  'www.technologyreview.com',
  'technologyreview.com',
  'time.com',
  'www.ft.com',
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
  'journals.sagepub.com',
  'link.springer.com',
  'academic.oup.com',
  'www.science.org',
];

/** Forum domains that support GraphQL content fetching. */
const FORUM_DOMAINS = [
  'www.lesswrong.com',
  'lesswrong.com',
  'www.alignmentforum.org',
  'alignmentforum.org',
  'forum.effectivealtruism.org',
  'www.effectivealtruism.org',
];

/**
 * Domains that require JavaScript rendering to extract content.
 * These return empty/minimal HTML via plain HTTP because page content
 * is rendered client-side. Playwright headless browser is used for these.
 */
const PLAYWRIGHT_PRIORITY_DOMAINS = [
  'www.crunchbase.com',
  'crunchbase.com',
  'pitchbook.com',
  'www.pitchbook.com',
  'www.cbinsights.com',
  'cbinsights.com',
  'www.statista.com',
  'statista.com',
  'app.dealroom.co',
  'dealroom.co',
  'www.owler.com',
  'owler.com',
  'tracxn.com',
  'www.tracxn.com',
  'www.zoominfo.com',
  'zoominfo.com',
  'companiesmarketcap.com',
  'www.companiesmarketcap.com',
];

/** Domains known to be permanently dead (site shut down). */
const DEAD_DOMAINS = [
  'www.fhi.ox.ac.uk',
  'fhi.ox.ac.uk',
  'ftxfuturefund.org',
  'www.ftxfuturefund.org',
  'safesecureai.org',
  'www.safesecureai.org',
  'maliciousaireport.com',
  'www.maliciousaireport.com',
  'www.thefilterbubble.com',
  'www.redqueenbio.com',
  'saferai.uk',
  'www.saferai.uk',
  'www.apollo-research.ai',
  'www.sparprogram.org',
  'www.deepfakedetectionchallenge.com',
];

// ---------------------------------------------------------------------------
// Domain Classification
// ---------------------------------------------------------------------------

import { getHostname, matchesDomainList } from '../url-utils.ts';

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
  if (matchesDomainList(hostname, PLAYWRIGHT_PRIORITY_DOMAINS)) return 'playwright-priority';

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

/**
 * Check if a domain requires JavaScript rendering (Playwright).
 */
export function isPlaywrightPriorityDomain(url: string): boolean {
  return matchesDomainList(getHostname(url), PLAYWRIGHT_PRIORITY_DOMAINS);
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
  'www.effectivealtruism.org': { name: 'EA Forum', graphqlUrl: 'https://forum.effectivealtruism.org/graphql', baseUrl: 'https://forum.effectivealtruism.org' },
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
 * Extract DOI from a URL. Handles direct doi.org links and publisher URLs
 * with DOI patterns embedded in the path.
 */
function extractDoi(url: string): string | null {
  // Direct doi.org link
  const doiOrgMatch = url.match(/doi\.org\/(10\.\d{4,}\/[^\s?#]+)/);
  if (doiOrgMatch) return doiOrgMatch[1];

  // DOI embedded in publisher URL path
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
    // Strip tags to a fixed point so spliced-together angle brackets can't
    // re-form a tag after a single pass.
    let abstractStripped = abstractRaw;
    let prevAbstract: string;
    do {
      prevAbstract = abstractStripped;
      abstractStripped = abstractStripped.replace(/<[^>]+>/g, '');
    } while (abstractStripped !== prevAbstract);
    const abstract = abstractStripped
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
// Uses the shared wayback module (crux/lib/wayback.ts) to avoid duplication.
// ---------------------------------------------------------------------------

/**
 * Fetch content from the Wayback Machine for a dead or unreachable URL.
 * Thin wrapper around the shared wayback module that returns a StrategyResult.
 */
export async function fetchWaybackContent(url: string): Promise<StrategyResult | null> {
  const result = await lookupAndFetchWayback(url);
  if (!result) return null;

  return {
    title: result.title ?? '',
    content: result.content.slice(0, 100_000),
    httpStatus: 200,
    fetchMethod: 'wayback',
    archiveUrl: result.archiveUrl,
  };
}
