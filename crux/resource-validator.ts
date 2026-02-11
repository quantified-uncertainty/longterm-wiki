/**
 * Resource Manager — Validation
 *
 * Validators that check resources against authoritative sources:
 * arXiv, Wikipedia, forums, DOIs, URLs, and dates.
 */

import { loadResources } from './resource-io.ts';
import { extractArxivId, sleep } from './resource-utils.ts';
import { fetchArxivBatch } from './resource-metadata.ts';
import type { Resource, ParsedOpts, ValidationIssue } from './resource-types.ts';

// ─── Title Comparison ────────────────────────────────────────────────────────

/**
 * Normalize title for fuzzy comparison
 */
function normalizeTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two titles are similar enough
 */
function titlesAreSimilar(stored: string, fetched: string): boolean {
  const a = normalizeTitle(stored);
  const b = normalizeTitle(fetched);
  if (!a || !b) return true; // Can't compare
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // Word overlap
  const aWords = new Set(a.split(' ').filter(w => w.length > 3));
  const bWords = new Set(b.split(' ').filter(w => w.length > 3));
  let overlap = 0;
  for (const w of aWords) if (bWords.has(w)) overlap++;
  return overlap / Math.max(aWords.size, bWords.size) > 0.4;
}

// ─── ArXiv Validator ─────────────────────────────────────────────────────────

/**
 * Validate arXiv resources against API
 */
async function validateArxiv(resources: Resource[], opts: ParsedOpts): Promise<ValidationIssue[]> {
  const limit = (opts.limit as number) || 50;

  const arxivResources = resources.filter(r => r.url?.includes('arxiv.org'));
  console.log(`   Found ${arxivResources.length} arXiv resources`);

  const toCheck = arxivResources.slice(0, limit);
  const idToResource = new Map<string, Resource>();

  for (const r of toCheck) {
    const arxivId = extractArxivId(r.url);
    if (arxivId) idToResource.set(arxivId, r);
  }

  const issues: ValidationIssue[] = [];
  const allIds = Array.from(idToResource.keys());

  for (let i = 0; i < allIds.length; i += 20) {
    const batchIds = allIds.slice(i, i + 20);
    process.stdout.write(`\r   Checking ${Math.min(i + 20, allIds.length)}/${allIds.length}...`);

    try {
      const metadata = await fetchArxivBatch(batchIds);

      for (const arxivId of batchIds) {
        const resource = idToResource.get(arxivId)!;
        const fetched = metadata.get(arxivId);

        if (!fetched) {
          issues.push({
            resource,
            type: 'not_found',
            message: `Paper not found on arXiv: ${arxivId}`
          });
          continue;
        }

        // Check title mismatch
        if (resource.title && fetched.title && !titlesAreSimilar(resource.title, fetched.title)) {
          issues.push({
            resource,
            type: 'title_mismatch',
            message: 'Title mismatch',
            stored: resource.title,
            fetched: fetched.title
          });
        }

        // Check author mismatch (if we have stored authors)
        if (resource.authors?.length && resource.authors.length > 0 && fetched.authors?.length > 0) {
          // Normalize names - handle "Last, First" vs "First Last" formats
          const normalizeName = (name: string): string => {
            const parts = name.split(/[,\s]+/).filter(p => p.length > 1);
            return parts.sort().join(' ').toLowerCase();
          };
          const storedNorm = normalizeName(resource.authors[0]);
          const fetchedNorm = normalizeName(fetched.authors[0]);

          // Check if names have same parts (ignoring order)
          if (storedNorm !== fetchedNorm) {
            issues.push({
              resource,
              type: 'author_mismatch',
              message: 'First author mismatch',
              stored: resource.authors[0],
              fetched: fetched.authors[0]
            });
          }
        }
      }

      if (i + 20 < allIds.length) await sleep(3000);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`\n   API error: ${error.message}`);
    }
  }

  console.log();
  return issues;
}

// ─── URL Validator ───────────────────────────────────────────────────────────

/**
 * Check for broken URLs (HTTP errors)
 */
async function validateUrls(resources: Resource[], opts: ParsedOpts): Promise<ValidationIssue[]> {
  const limit = (opts.limit as number) || 100;

  // Sample random resources to check
  const toCheck = resources
    .filter(r => r.url && !r.url.includes('arxiv.org')) // Skip arXiv (checked separately)
    .sort(() => Math.random() - 0.5)
    .slice(0, limit);

  console.log(`   Checking ${toCheck.length} random URLs...`);

  const issues: ValidationIssue[] = [];
  let checked = 0;

  for (const resource of toCheck) {
    checked++;
    if (checked % 10 === 0) {
      process.stdout.write(`\r   Checked ${checked}/${toCheck.length}...`);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response: Response = await fetch(resource.url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'LongtermWikiValidator/1.0' },
        redirect: 'follow'
      });

      clearTimeout(timeout);

      if (response.status >= 400) {
        issues.push({
          resource,
          type: 'http_error',
          message: `HTTP ${response.status}`,
          url: resource.url
        });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === 'AbortError') {
        issues.push({
          resource,
          type: 'timeout',
          message: 'Request timeout',
          url: resource.url
        });
      }
      // Ignore other errors (DNS, etc) as they may be network issues
    }

    await sleep(200); // Be polite
  }

  console.log();
  return issues;
}

// ─── Wikipedia Validator ─────────────────────────────────────────────────────

/**
 * Validate Wikipedia links exist and match expected topic
 */
async function validateWikipedia(resources: Resource[], opts: ParsedOpts): Promise<ValidationIssue[]> {
  const limit = (opts.limit as number) || 50;

  const wikiResources = resources.filter(r =>
    r.url?.includes('wikipedia.org/wiki/') || r.url?.includes('en.wikipedia.org')
  );
  console.log(`   Found ${wikiResources.length} Wikipedia resources`);

  const toCheck = wikiResources.slice(0, limit);
  const issues: ValidationIssue[] = [];
  let networkErrors = 0;

  for (let i = 0; i < toCheck.length; i++) {
    const resource = toCheck[i];
    if ((i + 1) % 5 === 0) {
      process.stdout.write(`\r   Checking ${i + 1}/${toCheck.length}...`);
    }

    try {
      // Extract article title from URL
      const urlMatch = resource.url.match(/wikipedia\.org\/wiki\/([^#?]+)/);
      if (!urlMatch) continue;
      const articleTitle = decodeURIComponent(urlMatch[1].replace(/_/g, ' '));

      // Use Wikipedia API to check if article exists
      const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(urlMatch[1])}`;
      const response: Response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'LongtermWikiValidator/1.0' }
      });

      if (response.status === 404) {
        issues.push({
          resource,
          type: 'wiki_not_found',
          message: `Wikipedia article not found: ${articleTitle}`,
          url: resource.url
        });
      } else if (response.ok) {
        const data = await response.json() as { title?: string };
        // Check if stored title matches Wikipedia title
        if (resource.title && data.title) {
          if (!titlesAreSimilar(resource.title, data.title) &&
              !titlesAreSimilar(resource.title, articleTitle)) {
            issues.push({
              resource,
              type: 'wiki_title_mismatch',
              message: 'Wikipedia title mismatch',
              stored: resource.title,
              fetched: data.title
            });
          }
        }
      }

      await sleep(100); // Be polite to Wikipedia
    } catch (_err: unknown) {
      networkErrors++;
    }
  }

  if (networkErrors > 0) {
    console.log(`   (${networkErrors} resource(s) skipped due to network errors)`);
  }
  console.log();
  return issues;
}

// ─── Forum Validator ─────────────────────────────────────────────────────────

/**
 * Validate forum posts (LessWrong, EA Forum, Alignment Forum)
 */
async function validateForumPosts(resources: Resource[], opts: ParsedOpts): Promise<ValidationIssue[]> {
  const limit = (opts.limit as number) || 50;

  const forumResources = resources.filter(r => {
    const url = r.url || '';
    return url.includes('lesswrong.com') ||
           url.includes('alignmentforum.org') ||
           url.includes('forum.effectivealtruism.org');
  });
  console.log(`   Found ${forumResources.length} forum resources`);

  const toCheck = forumResources.slice(0, limit);
  const issues: ValidationIssue[] = [];

  for (let i = 0; i < toCheck.length; i++) {
    const resource = toCheck[i];
    if ((i + 1) % 5 === 0) {
      process.stdout.write(`\r   Checking ${i + 1}/${toCheck.length}...`);
    }

    try {
      // Extract post slug from URL
      const postMatch = resource.url.match(/\/posts\/([a-zA-Z0-9]+)/);
      if (!postMatch) continue;
      const postId = postMatch[1];

      // Determine which API to use
      let apiUrl: string;
      if (resource.url.includes('lesswrong.com')) {
        apiUrl = 'https://www.lesswrong.com/graphql';
      } else if (resource.url.includes('alignmentforum.org')) {
        apiUrl = 'https://www.alignmentforum.org/graphql';
      } else {
        apiUrl = 'https://forum.effectivealtruism.org/graphql';
      }

      const query = {
        query: `query { post(input: {selector: {_id: "${postId}"}}) { result { title postedAt } } }`
      };

      const response: Response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'LongtermWikiValidator/1.0'
        },
        body: JSON.stringify(query)
      });

      if (response.ok) {
        const data = await response.json() as { data?: { post?: { result?: { title: string; postedAt?: string } } } };
        const post = data?.data?.post?.result;

        if (!post) {
          issues.push({
            resource,
            type: 'forum_not_found',
            message: `Forum post not found: ${postId}`,
            url: resource.url
          });
        } else if (resource.title && post.title) {
          if (!titlesAreSimilar(resource.title, post.title)) {
            issues.push({
              resource,
              type: 'forum_title_mismatch',
              message: 'Forum post title mismatch',
              stored: resource.title,
              fetched: post.title
            });
          }
        }
      }

      await sleep(200); // Rate limit
    } catch (_err: unknown) {
      // Ignore network errors
    }
  }

  console.log();
  return issues;
}

// ─── Date Validator ──────────────────────────────────────────────────────────

/**
 * Validate dates are sane (not in future, not too old, proper format)
 */
function validateDates(resources: Resource[], _opts: ParsedOpts): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const now = new Date();
  const minDate = new Date('1990-01-01'); // AI safety didn't exist before this
  const maxDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Allow 1 week into future for timezone issues

  for (const resource of resources) {
    const dateStr = resource.published_date || resource.date;
    if (!dateStr) continue;

    // Check format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      issues.push({
        resource,
        type: 'date_format',
        message: `Invalid date format: ${dateStr} (expected YYYY-MM-DD)`,
        url: resource.url
      });
      continue;
    }

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      issues.push({
        resource,
        type: 'date_invalid',
        message: `Invalid date: ${dateStr}`,
        url: resource.url
      });
      continue;
    }

    if (date.getTime() > maxDate.getTime()) {
      issues.push({
        resource,
        type: 'date_future',
        message: `Future date: ${dateStr}`,
        url: resource.url
      });
    }

    if (date.getTime() < minDate.getTime()) {
      issues.push({
        resource,
        type: 'date_ancient',
        message: `Suspiciously old date: ${dateStr}`,
        url: resource.url
      });
    }
  }

  console.log(`   Checked ${resources.filter(r => r.published_date || r.date).length} resources with dates`);
  return issues;
}

// ─── DOI Validator ───────────────────────────────────────────────────────────

/**
 * Validate DOIs via CrossRef API
 */
async function validateDois(resources: Resource[], opts: ParsedOpts): Promise<ValidationIssue[]> {
  const limit = (opts.limit as number) || 50;

  // Find resources with DOIs (in URL or doi field)
  // Exclude arXiv URLs which have similar patterns but aren't DOIs
  const doiResources = resources.filter(r => {
    if (r.url?.includes('arxiv.org')) return false; // arXiv IDs look like DOIs but aren't
    if (r.doi) return true;
    if (r.url?.includes('doi.org/')) return true;
    if (r.url?.match(/10\.\d{4,}\/[^\s]+/)) return true; // DOIs have format 10.XXXX/something
    return false;
  });
  console.log(`   Found ${doiResources.length} resources with DOIs`);

  const toCheck = doiResources.slice(0, limit);
  const issues: ValidationIssue[] = [];

  for (let i = 0; i < toCheck.length; i++) {
    const resource = toCheck[i];
    if ((i + 1) % 5 === 0) {
      process.stdout.write(`\r   Checking ${i + 1}/${toCheck.length}...`);
    }

    try {
      // Extract DOI
      let doi = resource.doi;
      if (!doi && resource.url) {
        const doiMatch = resource.url.match(/(10\.\d{4,}[^\s"<>]+)/);
        if (doiMatch) doi = doiMatch[1];
      }
      if (!doi) continue;

      // Query CrossRef
      const apiUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
      const response: Response = await fetch(apiUrl, {
        headers: { 'User-Agent': 'LongtermWikiValidator/1.0 (mailto:admin@example.com)' }
      });

      if (response.status === 404) {
        issues.push({
          resource,
          type: 'doi_not_found',
          message: `DOI not found: ${doi}`,
          url: resource.url
        });
      } else if (response.ok) {
        const data = await response.json() as { message?: { title?: string[] } };
        const work = data.message;

        // Check title match
        if (resource.title && work?.title?.[0]) {
          if (!titlesAreSimilar(resource.title, work.title[0])) {
            issues.push({
              resource,
              type: 'doi_title_mismatch',
              message: 'DOI title mismatch',
              stored: resource.title,
              fetched: work.title[0]
            });
          }
        }
      }

      await sleep(100); // CrossRef asks for polite rate limiting
    } catch (_err: unknown) {
      // Ignore network errors
    }
  }

  console.log();
  return issues;
}

// ─── Command Router ──────────────────────────────────────────────────────────

export async function cmdValidate(opts: ParsedOpts): Promise<void> {
  const source = opts._args?.[0] || 'all';
  const verbose = opts.verbose;

  console.log('🔍 Validating resource data\n');

  const resources = loadResources();
  console.log(`   Total resources: ${resources.length}\n`);

  const allIssues: ValidationIssue[] = [];

  if (source === 'arxiv' || source === 'all') {
    console.log('📚 Validating arXiv papers...');
    const arxivIssues = await validateArxiv(resources, opts);
    allIssues.push(...arxivIssues);
  }

  if (source === 'wikipedia' || source === 'all') {
    console.log('\n📖 Validating Wikipedia links...');
    const wikiIssues = await validateWikipedia(resources, opts);
    allIssues.push(...wikiIssues);
  }

  if (source === 'forums' || source === 'all') {
    console.log('\n💬 Validating forum posts...');
    const forumIssues = await validateForumPosts(resources, opts);
    allIssues.push(...forumIssues);
  }

  if (source === 'dates' || source === 'all') {
    console.log('\n📅 Validating dates...');
    const dateIssues = validateDates(resources, opts);
    allIssues.push(...dateIssues);
  }

  if (source === 'dois' || source === 'all') {
    console.log('\n🔬 Validating DOIs...');
    const doiIssues = await validateDois(resources, opts);
    allIssues.push(...doiIssues);
  }

  if (source === 'urls') {
    console.log('\n🔗 Checking for broken URLs...');
    const urlIssues = await validateUrls(resources, opts);
    allIssues.push(...urlIssues);
  }

  // Report
  console.log('\n' + '='.repeat(60));

  if (allIssues.length === 0) {
    console.log('\n✅ All resources validated successfully!');
  } else {
    console.log(`\n⚠️  Found ${allIssues.length} potential issues:\n`);

    // Group by type
    const byType: Record<string, ValidationIssue[]> = {};
    for (const issue of allIssues) {
      byType[issue.type] = byType[issue.type] || [];
      byType[issue.type].push(issue);
    }

    for (const [type, issues] of Object.entries(byType)) {
      console.log(`\n${type.toUpperCase()} (${issues.length}):`);
      for (const issue of issues.slice(0, verbose ? 100 : 10)) {
        console.log(`  - ${issue.message}`);
        if (issue.resource?.title) {
          console.log(`    Title: ${issue.resource.title.slice(0, 60)}...`);
        }
        if (issue.stored && issue.fetched) {
          console.log(`    Stored: "${issue.stored.slice(0, 50)}..."`);
          console.log(`    Actual: "${issue.fetched.slice(0, 50)}..."`);
        }
        console.log(`    URL: ${issue.resource?.url || issue.url}`);
      }
      if (!verbose && issues.length > 10) {
        console.log(`  ... and ${issues.length - 10} more`);
      }
    }

    process.exit(1);
  }
}
