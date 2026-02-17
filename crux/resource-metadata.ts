/**
 * Resource Manager — Metadata Extraction
 *
 * Fetches metadata from ArXiv, LW/AF/EAF forums, Semantic Scholar, and Firecrawl.
 */

import { loadResources, saveResources } from './resource-io.ts';
import { extractArxivId, extractForumSlug, extractDOI, isScholarlyUrl, sleep } from './resource-utils.ts';
import { getApiKey } from './lib/api-keys.ts';
import type { Resource, ParsedOpts, ArxivMetadata, ForumMetadata, ScholarMetadata } from './resource-types.ts';

// ─── ArXiv ──────────────────────────────────────────────────────────────────

/**
 * Fetch metadata from ArXiv API
 */
export async function fetchArxivBatch(arxivIds: string[]): Promise<Map<string, ArxivMetadata>> {
  const idList = arxivIds.join(',');
  const url = `http://export.arxiv.org/api/query?id_list=${idList}&max_results=${arxivIds.length}`;
  const response: Response = await fetch(url);
  if (!response.ok) throw new Error(`ArXiv API error: ${response.status}`);
  const xml: string = await response.text();

  const results = new Map<string, ArxivMetadata>();
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const idMatch = entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
    if (!idMatch) continue;
    const id = idMatch[1].replace(/v\d+$/, '');

    const authors: string[] = [];
    const authorRegex = /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);

    results.set(id, {
      title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null,
      authors,
      published: publishedMatch ? publishedMatch[1].split('T')[0] : null,
      abstract: summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim() : null,
    });
  }
  return results;
}

/**
 * Extract ArXiv metadata for resources
 */
export async function extractArxivMetadata(opts: ParsedOpts): Promise<number> {
  const batch = (opts.batch as number) || 100;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;
  const skipSave = opts._skipSave;

  if (!opts._skipSave) console.log('📚 ArXiv Metadata Extractor');
  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources: Resource[] = (opts._resources as Resource[] | undefined) || loadResources();
  const arxivResources = resources.filter(r => {
    if (!r.url || !r.url.includes('arxiv.org')) return false;
    if (r.authors && r.authors.length > 0) return false;
    return extractArxivId(r.url) !== null;
  });

  console.log(`   Found ${arxivResources.length} ArXiv papers without metadata`);

  const toProcess = arxivResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All ArXiv papers have metadata');
    return 0;
  }

  const idToResource = new Map<string, Resource>();
  for (const r of toProcess) {
    const arxivId = extractArxivId(r.url);
    if (arxivId) idToResource.set(arxivId, r);
  }

  const allIds = Array.from(idToResource.keys());
  let updated = 0;

  for (let i = 0; i < allIds.length; i += 20) {
    const batchIds = allIds.slice(i, i + 20);
    try {
      const metadata = await fetchArxivBatch(batchIds);
      for (const [arxivId, meta] of metadata) {
        const resource = idToResource.get(arxivId);
        if (!resource) continue;
        if (meta.authors?.length > 0) resource.authors = meta.authors;
        if (meta.published) resource.published_date = meta.published;
        if (meta.abstract && !resource.abstract) resource.abstract = meta.abstract;
        updated++;
        if (verbose) console.log(`   ✓ ${resource.title}`);
      }
      if (i + 20 < allIds.length) await sleep(3000);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`   Error: ${error.message}`);
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} papers`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

// ─── Forum (LW/AF/EAF) ─────────────────────────────────────────────────────

/**
 * Fetch forum metadata via GraphQL
 */
export async function fetchForumMetadata(postId: string, isEAForum: boolean): Promise<ForumMetadata | null> {
  const endpoint = isEAForum
    ? 'https://forum.effectivealtruism.org/graphql'
    : 'https://www.lesswrong.com/graphql';

  const query = `query { post(input: {selector: {_id: "${postId}"}}) { result { title postedAt user { displayName } coauthors { displayName } } } }`;

  const response: Response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) return null;
  const data = await response.json() as { data?: { post?: { result?: { title: string; postedAt?: string; user?: { displayName: string }; coauthors?: { displayName: string }[] } } } };
  const post = data?.data?.post?.result;
  if (!post) return null;

  const authors: string[] = [post.user?.displayName].filter((x): x is string => typeof x === 'string');
  if (post.coauthors) authors.push(...post.coauthors.map(c => c.displayName));

  return {
    title: post.title,
    authors: authors.filter(Boolean),
    published: post.postedAt ? post.postedAt.split('T')[0] : null,
  };
}

/**
 * Extract forum metadata for resources
 */
export async function extractForumMetadata(opts: ParsedOpts): Promise<number> {
  const batch = (opts.batch as number) || 100;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  if (!opts._skipSave) console.log('📝 Forum Metadata Extractor (LW/AF/EAF)');
  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources: Resource[] = (opts._resources as Resource[] | undefined) || loadResources();
  const forumResources = resources.filter(r => {
    if (!r.url) return false;
    if (r.authors && r.authors.length > 0) return false;
    return extractForumSlug(r.url) !== null;
  });

  console.log(`   Found ${forumResources.length} forum posts without metadata`);

  const toProcess = forumResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All forum posts have metadata');
    return 0;
  }

  let updated = 0;
  for (const r of toProcess) {
    const slug = extractForumSlug(r.url);
    const isEA = r.url.includes('forum.effectivealtruism.org');
    try {
      const meta = await fetchForumMetadata(slug ?? '', isEA);
      if (meta && meta.authors && meta.authors.length > 0) {
        r.authors = meta.authors;
        if (meta.published) r.published_date = meta.published;
        updated++;
        if (verbose) console.log(`   ✓ ${r.title}`);
      }
      await sleep(200);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (verbose) console.log(`   ✗ ${r.title}: ${error.message}`);
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} posts`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

// ─── Semantic Scholar ───────────────────────────────────────────────────────

/**
 * Fetch metadata from Semantic Scholar API
 */
export async function fetchSemanticScholarMetadata(identifier: string): Promise<ScholarMetadata | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/${identifier}?fields=title,authors,year,abstract,publicationDate`;
  const response: Response = await fetch(url);
  if (!response.ok) return null;
  const data = await response.json() as { title?: string; authors?: { name: string }[]; year?: number; abstract?: string; publicationDate?: string };
  if (!data) return null;

  return {
    title: data.title || '',
    authors: data.authors?.map(a => a.name) || [],
    published: data.publicationDate || (data.year ? `${data.year}` : null),
    abstract: data.abstract || null,
  };
}

/**
 * Extract Semantic Scholar metadata for resources
 */
export async function extractScholarMetadata(opts: ParsedOpts): Promise<number> {
  const batch = (opts.batch as number) || 50;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  if (!opts._skipSave) console.log('🎓 Semantic Scholar Metadata Extractor');
  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources: Resource[] = (opts._resources as Resource[] | undefined) || loadResources();

  // Find scholarly resources without authors
  const scholarResources = resources.filter(r => {
    if (!r.url) return false;
    if (r.authors && r.authors.length > 0) return false;
    if (r.url.includes('arxiv.org')) return false; // ArXiv handled separately
    return isScholarlyUrl(r.url);
  });

  console.log(`   Found ${scholarResources.length} scholarly resources without metadata`);

  const toProcess = scholarResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All scholarly resources have metadata');
    return 0;
  }

  let updated = 0;
  let failed = 0;

  for (const r of toProcess) {
    // Try DOI first
    let doi = extractDOI(r.url);

    // For nature.com, construct DOI
    if (!doi && r.url.includes('nature.com/articles/')) {
      const match = r.url.match(/nature\.com\/articles\/([^?#]+)/);
      if (match) doi = `10.1038/${match[1]}`;
    }

    if (!doi) {
      failed++;
      continue;
    }

    try {
      const meta = await fetchSemanticScholarMetadata(doi);
      if (meta && meta.authors && meta.authors.length > 0) {
        r.authors = meta.authors;
        if (meta.published) r.published_date = meta.published;
        if (meta.abstract && !r.abstract) r.abstract = meta.abstract;
        updated++;
        if (verbose) console.log(`   ✓ ${r.title}`);
      } else {
        failed++;
      }
      await sleep(100); // Rate limit
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      failed++;
      if (verbose) console.log(`   ✗ ${r.title}: ${error.message}`);
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} resources (${failed} failed/no data)`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

// ─── Firecrawl (Web) ────────────────────────────────────────────────────────

/**
 * Extract metadata using Firecrawl for general web pages
 */
export async function extractWebMetadata(opts: ParsedOpts): Promise<number> {
  const batch = (opts.batch as number) || 20;
  const dryRun = opts['dry-run'];
  const verbose = opts.verbose;

  if (!opts._skipSave) console.log('🔥 Web Metadata Extractor (Firecrawl)');

  const FIRECRAWL_KEY = getApiKey('FIRECRAWL_KEY');
  if (!FIRECRAWL_KEY) {
    if (!opts._skipSave) console.log('   ⚠️  FIRECRAWL_KEY not set in .env - skipping');
    return 0;
  }

  if (dryRun && !opts._skipSave) console.log('   DRY RUN');

  const resources: Resource[] = (opts._resources as Resource[] | undefined) || loadResources();

  // Find web resources without authors (excluding those handled by other extractors)
  const webResources = resources.filter(r => {
    if (!r.url) return false;
    if (r.authors && r.authors.length > 0) return false;
    if (r.url.includes('arxiv.org')) return false;
    if (extractForumSlug(r.url)) return false;
    if (isScholarlyUrl(r.url)) return false;
    if (r.url.includes('wikipedia.org')) return false;
    if (r.url.includes('github.com')) return false;
    return true;
  });

  console.log(`   Found ${webResources.length} web resources without metadata`);

  const toProcess = webResources.slice(0, batch);
  if (toProcess.length === 0) {
    console.log('   ✅ All processable web resources have metadata');
    return 0;
  }

  // Dynamic import for Firecrawl
  let FirecrawlApp: unknown;
  try {
    const module = await import('@mendable/firecrawl-js');
    FirecrawlApp = module.default;
  } catch (_err: unknown) {
    console.log('   ⚠️  @mendable/firecrawl-js not installed');
    return 0;
  }

  const firecrawl = new (FirecrawlApp as new (opts: { apiKey: string }) => { batchScrape: (urls: string[], opts: unknown) => Promise<{ data?: Array<{ metadata?: Record<string, unknown> }> }>; scrape: (url: string, opts: unknown) => Promise<{ metadata?: Record<string, unknown> }> })({ apiKey: FIRECRAWL_KEY });
  let updated = 0;

  // Build URL to resource map
  const urlToResource = new Map<string, Resource>();
  for (const r of toProcess) {
    urlToResource.set(r.url, r);
  }

  // Use batch scraping for efficiency
  const urls = toProcess.map(r => r.url);
  if (!opts._skipSave) console.log(`   Batch scraping ${urls.length} URLs...`);

  try {
    // batchScrape processes URLs in parallel on Firecrawl's side
    const results = await firecrawl.batchScrape(urls, {
      formats: ['markdown'],
      timeout: 300000, // 5 min timeout
    });

    // Process results
    for (const result of results.data || []) {
      const metadata = (result.metadata || {}) as Record<string, unknown>;
      const r = urlToResource.get((metadata.sourceURL as string) || (metadata.url as string));
      if (!r) continue;

      // Extract authors from various metadata fields
      const authorFields = ['author', 'authors', 'DC.Contributor', 'DC.Creator', 'article:author', 'og:article:author'];
      let authors: string[] | null = null;
      for (const field of authorFields) {
        const value = metadata[field];
        if (value) {
          if (Array.isArray(value)) {
            authors = value.filter((a): a is string => a && typeof a === 'string');
          } else if (typeof value === 'string') {
            authors = value.includes(',') ? value.split(',').map(a => a.trim()) : [value];
          }
          if (authors?.length && authors.length > 0) break;
        }
      }

      const articleMeta = metadata.article as Record<string, unknown> | undefined;
      const publishedDate = (metadata.publishedTime as string) || (metadata.datePublished as string) || (articleMeta?.publishedTime as string | undefined);

      if (authors?.length && authors.length > 0) {
        r.authors = authors;
        updated++;
        if (verbose) console.log(`   ✓ ${r.title} (authors: ${authors.join(', ')})`);
      }
      if (publishedDate) {
        r.published_date = publishedDate.split('T')[0];
        if (!authors?.length) updated++;
        if (verbose && !authors?.length) console.log(`   ✓ ${r.title} (date: ${publishedDate})`);
      }
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Fall back to sequential if batch fails
    if (!opts._skipSave) console.log(`   Batch failed (${error.message}), falling back to sequential...`);

    for (const r of toProcess) {
      try {
        const result = await firecrawl.scrape(r.url, { formats: ['markdown'] });
        const metadata = (result.metadata || {}) as Record<string, unknown>;

        const authorFields = ['author', 'authors', 'DC.Contributor', 'DC.Creator', 'article:author', 'og:article:author'];
        let authors: string[] | null = null;
        for (const field of authorFields) {
          const value = metadata[field];
          if (value) {
            if (Array.isArray(value)) {
              authors = value.filter((a): a is string => a && typeof a === 'string');
            } else if (typeof value === 'string') {
              authors = value.includes(',') ? value.split(',').map(a => a.trim()) : [value];
            }
            if (authors?.length && authors.length > 0) break;
          }
        }

        const articleMeta = metadata.article as Record<string, unknown> | undefined;
        const publishedDate = (metadata.publishedTime as string) || (metadata.datePublished as string) || (articleMeta?.publishedTime as string | undefined);

        if (authors?.length && authors.length > 0) {
          r.authors = authors;
          updated++;
        }
        if (publishedDate) {
          r.published_date = publishedDate.split('T')[0];
          if (!authors?.length) updated++;
        }

        await sleep(7000);
      } catch (e: unknown) {
        const innerError = e instanceof Error ? e : new Error(String(e));
        if (verbose) console.log(`   ✗ ${r.title}: ${innerError.message}`);
      }
    }
  }

  if (!opts._skipSave) console.log(`   ✅ Updated ${updated} resources`);

  if (!dryRun && updated > 0 && !opts._skipSave) {
    saveResources(resources);
    console.log('   Saved resources files');
  }
  return updated;
}

// ─── Statistics & Router ────────────────────────────────────────────────────

/**
 * Show metadata statistics
 */
export function showMetadataStats(): void {
  console.log('📊 Resource Metadata Statistics\n');

  const resources = loadResources();
  const total = resources.length;
  const withAuthors = resources.filter(r => r.authors?.length && r.authors.length > 0).length;
  const withDate = resources.filter(r => r.published_date).length;
  const withAbstract = resources.filter(r => r.abstract).length;
  const withSummary = resources.filter(r => r.summary).length;

  console.log(`Total resources: ${total}`);
  console.log(`With authors: ${withAuthors} (${Math.round(withAuthors/total*100)}%)`);
  console.log(`With date: ${withDate} (${Math.round(withDate/total*100)}%)`);
  console.log(`With abstract: ${withAbstract} (${Math.round(withAbstract/total*100)}%)`);
  console.log(`With summary: ${withSummary} (${Math.round(withSummary/total*100)}%)`);

  // Count by extractable source
  const arxiv = resources.filter(r => r.url?.includes('arxiv.org') && !r.authors?.length).length;
  const forum = resources.filter(r => r.url && extractForumSlug(r.url) && !r.authors?.length).length;
  const scholarly = resources.filter(r => r.url && isScholarlyUrl(r.url) && !r.url.includes('arxiv.org') && !r.authors?.length).length;
  const web = resources.filter(r => r.url && !r.authors?.length && !r.url.includes('arxiv.org') && !(r.url && extractForumSlug(r.url)) && !isScholarlyUrl(r.url)).length;

  console.log('\nPending extraction:');
  console.log(`  ArXiv: ${arxiv}`);
  console.log(`  Forums (LW/AF/EAF): ${forum}`);
  console.log(`  Scholarly (Semantic Scholar): ${scholarly}`);
  console.log(`  Web (Firecrawl): ${web}`);

  // Top domains without metadata
  const domains: Record<string, number> = {};
  for (const r of resources.filter(r => r.url && !r.authors?.length)) {
    try {
      const domain = new URL(r.url).hostname.replace('www.', '');
      domains[domain] = (domains[domain] || 0) + 1;
    } catch (_err: unknown) {}
  }
  const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log('\nTop domains without metadata:');
  for (const [domain, count] of sorted) {
    console.log(`  ${count.toString().padStart(4)} ${domain}`);
  }
}

/**
 * Main metadata command router
 */
export async function cmdMetadata(opts: ParsedOpts): Promise<void> {
  const source = opts._args?.[0];
  const parallel = opts.parallel;

  if (!source || source === 'stats') {
    showMetadataStats();
    return;
  }

  if (!['arxiv', 'forum', 'scholar', 'web', 'all', 'stats'].includes(source)) {
    console.error(`Unknown source: ${source}`);
    console.log('Valid sources: arxiv, forum, scholar, web, all, stats');
    process.exit(1);
  }

  let totalUpdated = 0;

  if (source === 'all' && parallel) {
    // Run all extractors in parallel (they use different APIs)
    // Load resources once, pass to all, save once at end
    console.log('🚀 Running all extractors in parallel...\n');

    const resources = loadResources();
    const sharedOpts: ParsedOpts = { ...opts, _resources: resources, _skipSave: true };

    const results = await Promise.allSettled([
      extractArxivMetadata(sharedOpts),
      extractForumMetadata(sharedOpts),
      extractScholarMetadata(sharedOpts),
      extractWebMetadata(sharedOpts),
    ]);

    const labels = ['ArXiv', 'Forum', 'Scholar', 'Web'];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`✅ ${labels[i]}: ${r.value} updated`);
        totalUpdated += r.value;
      } else {
        console.log(`❌ ${labels[i]}: ${r.reason?.message || 'failed'}`);
      }
    });

    // Save once at the end
    if (totalUpdated > 0 && !opts['dry-run']) {
      saveResources(resources);
      console.log('\n📁 Saved resources files');
    }
  } else {
    // Sequential execution
    if (source === 'arxiv' || source === 'all') {
      totalUpdated += await extractArxivMetadata(opts);
      console.log();
    }

    if (source === 'forum' || source === 'all') {
      totalUpdated += await extractForumMetadata(opts);
      console.log();
    }

    if (source === 'scholar' || source === 'all') {
      totalUpdated += await extractScholarMetadata(opts);
      console.log();
    }

    if (source === 'web' || source === 'all') {
      totalUpdated += await extractWebMetadata(opts);
      console.log();
    }
  }

  if (totalUpdated > 0 && !opts['dry-run']) {
    console.log('\n💡 Run `pnpm build` to update the database.');
  }
}
