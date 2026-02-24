/**
 * Register Resources — auto-create YAML entries for unregistered footnote URLs.
 *
 * Parses footnote definitions from MDX, identifies URLs without resource YAML
 * entries, and creates new entries with metadata from the citation_content cache.
 *
 * Usage:
 *   pnpm crux citations register-resources <page-id>
 *   pnpm crux citations register-resources --all --limit=10
 *   pnpm crux citations register-resources <page-id> --dry-run
 */

import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { hashId, guessResourceType, buildUrlToResourceMap } from '../resource-utils.ts';
import { loadResources, saveResources, getResourceCategory } from '../resource-io.ts';
import { parseFootnoteSources } from '../lib/footnote-parser.ts';
import { getCitationContentByUrl } from '../lib/wiki-server/citations.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import type { Resource } from '../resource-types.ts';

interface UnregisteredSource {
  url: string;
  title: string;
  domain: string;
  footnoteNumbers: number[];
  pageId: string;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Find all pages with MDX content and extract their page IDs.
 */
function getPageIdsWithContent(): Array<{ pageId: string; filePath: string }> {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const results: Array<{ pageId: string; filePath: string }> = [];
  for (const f of files) {
    if (!f.includes('/knowledge-base/')) continue;
    const name = basename(f, '.mdx');
    if (name.startsWith('index.') || name === 'index') continue;
    results.push({ pageId: name, filePath: f });
  }
  return results;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const processAll = args.all === true;
  const limit = args.limit ? parseInt(String(args.limit), 10) : 999;
  const positional = (args._positional as string[]) || [];
  const c = getColors(false);

  console.log(
    `\n${c.bold}${c.blue}Register Resources — Auto-create YAML for footnote URLs${c.reset}\n`,
  );

  // Load existing resources and build URL lookup
  const existingResources = loadResources();
  const urlToResource = buildUrlToResourceMap(existingResources);

  // Determine which pages to process
  let pages: Array<{ pageId: string; filePath: string }>;

  if (processAll) {
    pages = getPageIdsWithContent().slice(0, limit);
    console.log(`  Processing ${pages.length} pages...\n`);
  } else if (positional.length > 0) {
    pages = positional.map(id => {
      // Find the MDX file for this page ID
      const allPages = getPageIdsWithContent();
      const found = allPages.find(p => p.pageId === id);
      if (!found) {
        console.error(`${c.red}Page not found: ${id}${c.reset}`);
        process.exit(1);
      }
      return found;
    });
  } else {
    console.error(`${c.red}Specify a page ID or use --all${c.reset}`);
    process.exit(1);
  }

  // Collect all unregistered URLs across pages
  const allUnregistered: UnregisteredSource[] = [];
  let totalFootnotes = 0;
  let totalUrls = 0;
  let alreadyRegistered = 0;

  for (const { pageId, filePath } of pages) {
    const content = readFileSync(filePath, 'utf-8');
    const result = parseFootnoteSources(content, new Map(
      [...urlToResource.entries()].map(([url, r]) => [url, r.id])
    ));

    totalFootnotes += result.totalFootnotes;
    totalUrls += result.uniqueUrls;

    for (const source of result.sources) {
      if (source.resourceId) {
        alreadyRegistered++;
        continue;
      }

      // Check if URL is already in our lookup (with normalization)
      const hasEntry = urlToResource.has(source.url) ||
        urlToResource.has(source.url.replace(/\/$/, '')) ||
        urlToResource.has(source.url.replace(/\/$/, '') + '/');

      if (hasEntry) {
        alreadyRegistered++;
        continue;
      }

      allUnregistered.push({
        url: source.url,
        title: source.title,
        domain: source.domain,
        footnoteNumbers: source.footnoteNumbers,
        pageId,
      });
    }
  }

  console.log(`  Total footnotes scanned: ${totalFootnotes}`);
  console.log(`  Unique source URLs: ${totalUrls}`);
  console.log(`  Already registered: ${alreadyRegistered}`);
  console.log(`  ${c.yellow}Need registration: ${allUnregistered.length}${c.reset}\n`);

  if (allUnregistered.length === 0) {
    console.log(`${c.green}All footnote URLs have resource entries!${c.reset}\n`);
    process.exit(0);
  }

  // Deduplicate by URL across pages
  const byUrl = new Map<string, UnregisteredSource & { citedByPages: string[] }>();
  for (const source of allUnregistered) {
    const key = source.url.replace(/\/$/, '').toLowerCase();
    if (byUrl.has(key)) {
      const existing = byUrl.get(key)!;
      if (!existing.citedByPages.includes(source.pageId)) {
        existing.citedByPages.push(source.pageId);
      }
      // Merge footnote numbers (may be from different pages)
    } else {
      byUrl.set(key, { ...source, citedByPages: [source.pageId] });
    }
  }

  console.log(`  Unique URLs to register: ${byUrl.size}\n`);

  // Create resource entries
  const newResources: Resource[] = [];
  let enrichedFromCache = 0;
  let fetchFailed = 0;

  for (const source of byUrl.values()) {
    const id = hashId(source.url);
    const type = guessResourceType(source.url);

    // Try to enrich from wiki-server citation_content cache
    let pageTitle: string | null = null;
    let summary: string | null = null;

    try {
      const result = await getCitationContentByUrl(source.url);
      if (result.ok && result.data) {
        pageTitle = result.data.pageTitle;
        // Use the preview text as a short summary if available
        if (result.data.fullTextPreview && result.data.fullTextPreview.length > 50) {
          // Take first ~200 chars as a rough summary
          const preview = result.data.fullTextPreview.slice(0, 300).trim();
          const firstSentences = preview.match(/^.+?(?:\.\s|[!?]\s)/g);
          if (firstSentences && firstSentences.length > 0) {
            summary = firstSentences.slice(0, 2).join('').trim();
          }
        }
        enrichedFromCache++;
      }
    } catch {
      fetchFailed++;
    }

    // Use the best available title
    const title = pageTitle || source.title || getDomain(source.url);

    const resource: Resource = {
      id,
      url: source.url,
      title,
      type,
      cited_by: source.citedByPages,
      tags: [],
    };

    if (summary) {
      resource.summary = summary;
    }

    if (dryRun) {
      console.log(
        `  ${c.green}CREATE${c.reset} ${id} ${c.dim}${type.padEnd(10)}${c.reset} ${title}`,
      );
      console.log(
        `         ${c.dim}${source.url}${c.reset}`,
      );
      console.log(
        `         ${c.dim}cited by: ${source.citedByPages.join(', ')} (footnotes: ${source.footnoteNumbers.join(', ')})${c.reset}`,
      );
    }

    newResources.push(resource);
  }

  if (dryRun) {
    console.log(
      `\n  ${c.yellow}Dry run — ${newResources.length} resources would be created.${c.reset}`,
    );
    console.log(
      `  ${c.dim}Enriched from cache: ${enrichedFromCache}, cache miss: ${fetchFailed}${c.reset}`,
    );
    console.log();
    process.exit(0);
  }

  // Merge new resources into existing and save
  const merged = [...existingResources, ...newResources];
  saveResources(merged);

  console.log(`${c.bold}Results:${c.reset}`);
  console.log(`  ${c.green}Created:${c.reset} ${newResources.length} new resource entries`);
  console.log(`  ${c.dim}Enriched from cache: ${enrichedFromCache}${c.reset}`);
  console.log(`  ${c.dim}Cache miss: ${fetchFailed}${c.reset}`);

  // Show breakdown by category
  const byCat = new Map<string, number>();
  for (const r of newResources) {
    const cat = getResourceCategory(r);
    byCat.set(cat, (byCat.get(cat) || 0) + 1);
  }
  console.log(`\n  By category:`);
  for (const [cat, count] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat}: ${count}`);
  }

  console.log();
  process.exit(0);
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
