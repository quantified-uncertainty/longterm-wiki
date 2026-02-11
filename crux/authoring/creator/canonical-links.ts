/**
 * Canonical Links Module
 *
 * Finds official reference links (Wikipedia, LessWrong, EA Forum, etc.) for a topic.
 */

interface CanonicalDomain {
  domain: string;
  name: string;
  priority: number;
}

interface CanonicalLink {
  name: string;
  url: string;
  priority: number;
  domain: string;
}

interface CanonicalLinksContext {
  log: (phase: string, message: string) => void;
  saveResult: (topic: string, filename: string, data: unknown) => string;
}

interface PerplexityResult {
  content: string;
  citations?: string[];
  cost?: number;
}

export const CANONICAL_DOMAINS: CanonicalDomain[] = [
  { domain: 'en.wikipedia.org', name: 'Wikipedia', priority: 1 },
  { domain: 'www.wikidata.org', name: 'Wikidata', priority: 2 },
  { domain: 'lesswrong.com', name: 'LessWrong', priority: 3 },
  { domain: 'forum.effectivealtruism.org', name: 'EA Forum', priority: 3 },
  { domain: 'www.britannica.com', name: 'Britannica', priority: 4 },
  { domain: 'arxiv.org', name: 'arXiv', priority: 5 },
  { domain: 'scholar.google.com', name: 'Google Scholar', priority: 5 },
  { domain: 'twitter.com', name: 'Twitter/X', priority: 6 },
  { domain: 'x.com', name: 'Twitter/X', priority: 6 },
  { domain: 'github.com', name: 'GitHub', priority: 6 },
  { domain: 'linkedin.com', name: 'LinkedIn', priority: 7 },
];

export async function findCanonicalLinks(topic: string, { log, saveResult }: CanonicalLinksContext): Promise<{ success: boolean; error?: string; links: CanonicalLink[]; cost?: number }> {
  log('canonical', 'Searching for canonical reference links...');

  const { perplexityResearch } = await import('../../lib/openrouter.ts');

  const searchQuery = `Find official and reference pages for "${topic}". Include:
- Wikipedia page URL (if exists)
- Wikidata ID and URL (if exists)
- LessWrong profile or wiki page (if exists)
- EA Forum profile or posts (if exists)
- Official website (if organization or person)
- Twitter/X profile (if exists)
- GitHub (if relevant)

For each, provide the exact URL. Only include links that actually exist.`;

  try {
    const result: PerplexityResult = await perplexityResearch(searchQuery, { maxTokens: 1500 });

    // Extract URLs from response
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const foundUrls = (result.content.match(urlRegex) || []).map(url => {
      return url.replace(/[.,;:!?]+$/, '').replace(/\)+$/, '');
    });

    const allUrls = [...new Set([...foundUrls, ...(result.citations || [])])];

    // Categorize by domain
    const canonicalLinks: CanonicalLink[] = [];
    const seenDomains = new Set<string>();

    for (const url of allUrls) {
      try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/^www\./, '');

        for (const { domain, name, priority } of CANONICAL_DOMAINS) {
          const domainHost = domain.replace(/^www\./, '');
          if (hostname === domainHost || hostname.endsWith('.' + domainHost)) {
            if (!seenDomains.has(name)) {
              canonicalLinks.push({ name, url, priority, domain: hostname });
              seenDomains.add(name);
            }
            break;
          }
        }

        // Check for official/personal website
        if (!seenDomains.has('Official Website') &&
            !CANONICAL_DOMAINS.some(d => hostname.includes(d.domain.replace(/^www\./, '')))) {
          if (hostname.split('.').length <= 3 && !hostname.includes('google') && !hostname.includes('bing')) {
            canonicalLinks.push({ name: 'Official Website', url, priority: 0, domain: hostname });
            seenDomains.add('Official Website');
          }
        }
      } catch (e: unknown) {
        // Invalid URL, skip
      }
    }

    canonicalLinks.sort((a, b) => a.priority - b.priority);

    log('canonical', `Found ${canonicalLinks.length} canonical links`);
    canonicalLinks.forEach(link => {
      log('canonical', `  ${link.name}: ${link.url}`);
    });

    const data = {
      topic,
      links: canonicalLinks,
      rawContent: result.content,
      allFoundUrls: allUrls,
      timestamp: new Date().toISOString(),
    };
    saveResult(topic, 'canonical-links.json', data);

    return { success: true, links: canonicalLinks, cost: result.cost || 0 };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('canonical', `Error finding canonical links: ${error.message}`);
    return { success: false, error: error.message, links: [] };
  }
}
