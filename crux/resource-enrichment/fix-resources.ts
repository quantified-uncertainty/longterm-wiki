/**
 * Resource Auto-Fixer
 *
 * Validates resources against external APIs and auto-fixes title/author
 * mismatches where the URL is confirmed correct (titles share content words).
 *
 * Usage:
 *   pnpm crux resources fix --dry-run   # preview fixes
 *   pnpm crux resources fix --apply     # apply fixes to PG
 */

import { loadResources } from '../resource-io.ts';
import { extractArxivId, sleep } from '../resource-utils.ts';
import { fetchArxivBatch } from '../resource-metadata.ts';
import { hostMatches } from '@longterm-wiki/url-utils';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';

// ─── Title Utilities ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with',
  'by', 'from', 'at', 'is', 'are', 'was', 'were', 'et', 'al',
]);

function normalizeTitle(title: string): string {
  return (title || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function titlesAreSimilar(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return true;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const aWords = new Set(na.split(' ').filter(w => w.length > 3));
  const bWords = new Set(nb.split(' ').filter(w => w.length > 3));
  let overlap = 0;
  for (const w of aWords) if (bWords.has(w)) overlap++;
  return overlap / Math.max(aWords.size, bWords.size) > 0.4;
}

/** Returns true if titles share content words — meaning the URL is likely correct. */
function titlesShareContent(a: string, b: string): boolean {
  const words = (t: string) =>
    t.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const aSet = new Set(words(a));
  return words(b).some(w => aSet.has(w));
}

/** Push a title fix only if the URL appears correct (titles share content). */
function pushTitleFix(
  fixes: ResourceFix[],
  resource: Resource,
  fetchedTitle: string,
  source: string,
  ...altTitles: string[]
) {
  if (!resource.title || !fetchedTitle) return;
  if (titlesAreSimilar(resource.title, fetchedTitle)) return;
  for (const alt of altTitles) {
    if (titlesAreSimilar(resource.title, alt)) return;
  }
  if (!titlesShareContent(resource.title, fetchedTitle) &&
      !altTitles.some(alt => titlesShareContent(resource.title!, alt))) return;
  fixes.push({
    resourceId: resource.id, url: resource.url,
    field: 'title', oldValue: resource.title, newValue: fetchedTitle, source,
  });
}

// ─── Fix Types ──────────────────────────────────────────────────────────────

interface ResourceFix {
  resourceId: string;
  url: string;
  field: string;
  oldValue: string;
  newValue: string;
  source: string;
}

interface FetcherResult {
  fixes: ResourceFix[];
  apiFailures: number;
}

// ─── Fetchers (one per API) ─────────────────────────────────────────────────

async function findArxivFixes(resources: Resource[], limit: number): Promise<FetcherResult> {
  const arxiv = resources.filter(r => r.url && hostMatches(r.url, 'arxiv.org'));
  console.log(`   Found ${arxiv.length} arXiv resources`);

  const idMap = new Map<string, Resource>();
  for (const r of arxiv.slice(0, limit)) {
    const id = extractArxivId(r.url);
    if (id) idMap.set(id, r);
  }

  const fixes: ResourceFix[] = [];
  let apiFailures = 0;
  const allIds = Array.from(idMap.keys());

  for (let i = 0; i < allIds.length; i += 20) {
    const batch = allIds.slice(i, i + 20);
    process.stdout.write(`\r   Checking ${Math.min(i + 20, allIds.length)}/${allIds.length}...`);

    try {
      const metadata = await fetchArxivBatch(batch);
      for (const id of batch) {
        const resource = idMap.get(id)!;
        const fetched = metadata.get(id);
        if (!fetched) continue;

        if (fetched.title) pushTitleFix(fixes, resource, fetched.title, 'arxiv');

        if (resource.authors?.length && fetched.authors?.length) {
          const norm = (n: string) => n.split(/[,\s]+/).filter(p => p.length > 1).sort().join(' ').toLowerCase();
          if (norm(resource.authors[0]) !== norm(fetched.authors[0])) {
            fixes.push({
              resourceId: resource.id, url: resource.url,
              field: 'authors', oldValue: resource.authors[0], newValue: fetched.authors[0], source: 'arxiv',
            });
          }
        }
      }
      if (i + 20 < allIds.length) await sleep(3000);
    } catch (err: unknown) {
      apiFailures++;
      console.error(`\n   API error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  return { fixes, apiFailures };
}

async function findWikipediaFixes(resources: Resource[], limit: number, verbose?: boolean): Promise<FetcherResult> {
  const wiki = resources.filter(r => r.url != null && hostMatches(r.url, 'wikipedia.org'));
  console.log(`   Found ${wiki.length} Wikipedia resources`);

  const fixes: ResourceFix[] = [];
  let apiFailures = 0;
  for (let i = 0; i < Math.min(wiki.length, limit); i++) {
    const resource = wiki[i];
    if ((i + 1) % 5 === 0) process.stdout.write(`\r   Checking ${i + 1}/${Math.min(wiki.length, limit)}...`);

    try {
      const match = resource.url.match(/wikipedia\.org\/wiki\/([^#?]+)/);
      if (!match) continue;
      const articleTitle = decodeURIComponent(match[1].replace(/_/g, ' '));

      const resp = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(match[1])}`,
        { headers: { 'User-Agent': 'LongtermWikiValidator/1.0' } },
      );
      if (resp.ok) {
        const data = await resp.json() as { title?: string };
        if (data.title) pushTitleFix(fixes, resource, data.title, 'wikipedia', articleTitle);
      } else {
        apiFailures++;
        if (verbose) console.warn(`\n   Wikipedia API failure (${resp.status}) for ${resource.url}`);
      }
      await sleep(100);
    } catch (err: unknown) {
      apiFailures++;
      if (verbose) console.warn(`\n   Wikipedia fetch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  return { fixes, apiFailures };
}

async function findDoiFixes(resources: Resource[], limit: number, verbose?: boolean): Promise<FetcherResult> {
  const dois = resources.filter(r => {
    if (r.url && hostMatches(r.url, 'arxiv.org')) return false;
    return r.doi || (r.url != null && hostMatches(r.url, 'doi.org')) || r.url?.match(/10\.\d{4,}\/[^\s]+/);
  });
  console.log(`   Found ${dois.length} resources with DOIs`);

  const fixes: ResourceFix[] = [];
  let apiFailures = 0;
  for (let i = 0; i < Math.min(dois.length, limit); i++) {
    const resource = dois[i];
    if ((i + 1) % 5 === 0) process.stdout.write(`\r   Checking ${i + 1}/${Math.min(dois.length, limit)}...`);

    try {
      const doi = resource.doi || resource.url?.match(/(10\.\d{4,}[^\s"<>]+)/)?.[1];
      if (!doi) continue;

      const resp = await fetch(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        { headers: { 'User-Agent': 'LongtermWikiValidator/1.0 (mailto:admin@example.com)' } },
      );
      if (resp.ok) {
        const data = await resp.json() as { message?: { title?: string[] } };
        const title = data.message?.title?.[0];
        if (title) pushTitleFix(fixes, resource, title, 'doi');
      } else {
        apiFailures++;
        if (verbose) console.warn(`\n   DOI API failure (${resp.status}) for ${resource.url}`);
      }
      await sleep(100);
    } catch (err: unknown) {
      apiFailures++;
      if (verbose) console.warn(`\n   DOI fetch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  return { fixes, apiFailures };
}

async function findForumFixes(resources: Resource[], limit: number, verbose?: boolean): Promise<FetcherResult> {
  const forums = resources.filter(r => {
    const u = r.url || '';
    return hostMatches(u, 'lesswrong.com') || hostMatches(u, 'alignmentforum.org') || hostMatches(u, 'forum.effectivealtruism.org');
  });
  console.log(`   Found ${forums.length} forum resources`);

  const fixes: ResourceFix[] = [];
  let apiFailures = 0;
  for (let i = 0; i < Math.min(forums.length, limit); i++) {
    const resource = forums[i];
    if ((i + 1) % 5 === 0) process.stdout.write(`\r   Checking ${i + 1}/${Math.min(forums.length, limit)}...`);

    try {
      const postId = resource.url.match(/\/posts\/([a-zA-Z0-9]+)/)?.[1];
      if (!postId) continue;

      const apiUrl = hostMatches(resource.url, 'lesswrong.com') ? 'https://www.lesswrong.com/graphql'
        : hostMatches(resource.url, 'alignmentforum.org') ? 'https://www.alignmentforum.org/graphql'
        : 'https://forum.effectivealtruism.org/graphql';

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'LongtermWikiValidator/1.0' },
        body: JSON.stringify({ query: `query { post(input: {selector: {_id: "${postId}"}}) { result { title } } }` }),
      });

      if (resp.ok) {
        const data = await resp.json() as { data?: { post?: { result?: { title: string } } } };
        const title = data?.data?.post?.result?.title;
        if (title) pushTitleFix(fixes, resource, title, 'forum');
      } else {
        apiFailures++;
        if (verbose) console.warn(`\n   Forum API failure (${resp.status}) for ${resource.url}`);
      }
      await sleep(200);
    } catch (err: unknown) {
      apiFailures++;
      if (verbose) console.warn(`\n   Forum fetch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log();
  return { fixes, apiFailures };
}

// ─── Apply & Command ────────────────────────────────────────────────────────

async function applyFixes(fixes: ResourceFix[], resources: Resource[]): Promise<{ applied: number; failed: number; apiFailures: number }> {
  let applied = 0;
  let failed = 0;
  let apiFailures = 0;

  const resourceById = new Map(resources.map(r => [r.id, r]));

  for (const fix of fixes) {
    const resource = resourceById.get(fix.resourceId);
    if (!resource) { failed++; continue; }

    const body: Record<string, unknown> = {
      id: resource.id,
      url: resource.url,
    };
    if (fix.field === 'authors') {
      if (Array.isArray(fix.newValue)) {
        // newValue is already an array — use as-is
        body.authors = fix.newValue;
      } else if (resource.authors) {
        // Preserve existing authors: find and replace the matching entry, or append
        const idx = resource.authors.findIndex(a => a === fix.oldValue);
        const updated = [...resource.authors];
        if (idx >= 0) {
          updated[idx] = fix.newValue;
        } else {
          updated.push(fix.newValue);
        }
        body.authors = updated;
      } else {
        // No existing authors — fall back to single-element array
        body.authors = [fix.newValue];
      }
    } else {
      body[fix.field] = fix.newValue;
    }

    try {
      // typed-client-ok: QUA-770 baseline — resource enrichment pipeline, internal write path
      const result = await apiRequest<{ id: string }>('POST', '/api/resources', body);
      if (result.ok) {
        applied++;
        console.log(`  ✓ Fixed ${fix.field} for ${fix.resourceId} [${fix.source}]`);
      } else {
        failed++;
        apiFailures++;
        console.log(`  ✗ Failed ${fix.resourceId}: ${result.message}`);
      }
    } catch (err: unknown) {
      failed++;
      apiFailures++;
      console.log(`  ✗ Error ${fix.resourceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied, failed, apiFailures };
}

export async function fixResourcesCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !options.apply;
  const limit = (options.limit as number) || 50;
  const verbose = options.verbose as boolean;

  console.log('🔧 Resource Auto-Fixer\n');
  if (dryRun) console.log('  DRY RUN — no changes will be written. Use --apply to fix.\n');

  const resources = loadResources();
  console.log(`   Total resources: ${resources.length}\n`);

  const allFixes: ResourceFix[] = [];
  let apiFailureCount = 0;

  console.log('📚 Checking arXiv papers...');
  const arxivResult = await findArxivFixes(resources, limit);
  allFixes.push(...arxivResult.fixes);
  apiFailureCount += arxivResult.apiFailures;

  console.log('📖 Checking Wikipedia links...');
  const wikiResult = await findWikipediaFixes(resources, limit, verbose);
  allFixes.push(...wikiResult.fixes);
  apiFailureCount += wikiResult.apiFailures;

  console.log('🔬 Checking DOIs...');
  const doiResult = await findDoiFixes(resources, limit, verbose);
  allFixes.push(...doiResult.fixes);
  apiFailureCount += doiResult.apiFailures;

  console.log('💬 Checking forum posts...');
  const forumResult = await findForumFixes(resources, limit, verbose);
  allFixes.push(...forumResult.fixes);
  apiFailureCount += forumResult.apiFailures;

  if (apiFailureCount > 0) {
    console.log(`\n  ⚠ ${apiFailureCount} API failure(s) during fetching`);
  }

  console.log('\n' + '='.repeat(60));

  if (allFixes.length === 0) {
    const msg = apiFailureCount > 0
      ? `No fixes found (${apiFailureCount} API failures)`
      : 'No fixes needed';
    console.log(`\n✅ ${msg}`);
    return { exitCode: apiFailureCount > 0 ? 1 : 0, output: msg };
  }

  const bySource: Record<string, ResourceFix[]> = {};
  for (const fix of allFixes) {
    (bySource[fix.source] ??= []).push(fix);
  }

  console.log(`\n🔧 Found ${allFixes.length} fixable issues:\n`);
  for (const [source, fixes] of Object.entries(bySource)) {
    console.log(`  ${source}: ${fixes.length} fix(es)`);
    for (const fix of fixes.slice(0, verbose ? 100 : 5)) {
      console.log(`    ${fix.field}: "${fix.oldValue.slice(0, 50)}" → "${fix.newValue.slice(0, 50)}"`);
    }
    if (!verbose && fixes.length > 5) console.log(`    ... and ${fixes.length - 5} more`);
  }

  if (dryRun) {
    const msg = `${allFixes.length} fixes available${apiFailureCount > 0 ? `, ${apiFailureCount} API failures` : ''}`;
    console.log(`\n  Run with --apply to fix ${allFixes.length} issues.`);
    return { exitCode: apiFailureCount > 0 ? 1 : 0, output: msg };
  }

  console.log(`\n  Applying ${allFixes.length} fixes...\n`);
  const { applied, failed, apiFailures: applyApiFailures } = await applyFixes(allFixes, resources);
  apiFailureCount += applyApiFailures;
  console.log(`\n  Results: ${applied} applied, ${failed} failed${apiFailureCount > 0 ? `, ${apiFailureCount} total API failures` : ''}`);

  return { exitCode: failed > 0 || apiFailureCount > 0 ? 1 : 0, output: `${applied} fixes applied, ${failed} failed, ${apiFailureCount} API failures` };
}
