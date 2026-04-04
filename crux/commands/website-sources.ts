/**
 * Website Sources CLI — fetch and snapshot website source pages.
 *
 * Usage:
 *   crux tb website-sources list                    List all registered website sources
 *   crux tb website-sources show <sourceId>         Show source details with pages
 *   crux tb website-sources fetch <sourceId>        Fetch all enabled pages for a source
 *   crux tb website-sources fetch --all             Fetch pages for all enabled sources
 *
 * Part of Discussion #2928: Websites as Data Feeds (Issue #3652).
 */

import { createHash } from 'crypto';
import type { CommandResult } from '../lib/command-types.ts';

/**
 * Compute SHA-256 hex hash of content for dedup.
 * Hash is computed on extracted text/markdown (not raw HTML), so minor
 * HTML changes that don't affect content are deduplicated.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface Options {
  all?: boolean;
  dryRun?: boolean;
  'dry-run'?: boolean;
  limit?: string;
}

// ---------------------------------------------------------------------------
// list — show all website sources
// ---------------------------------------------------------------------------

async function listCommand(_args: string[], _options: Options): Promise<CommandResult> {
  const { listWebsiteSources } = await import('../lib/wiki-server/website-sources.ts');
  const result = await listWebsiteSources();

  if (!result.ok) {
    return { exitCode: 1, output: `Failed to list website sources: ${result.error}` };
  }

  const sources = result.data.sources;

  if (sources.length === 0) {
    console.log('No website sources registered.');
    return { exitCode: 0, output: '' };
  }

  console.log(
    `\n${'ID'.padEnd(12)} ${'Domain'.padEnd(30)} ${'Entity'.padEnd(25)} ${'Pages'.padEnd(6)} ${'Enabled'.padEnd(8)} Last Run`
  );
  console.log('-'.repeat(100));

  for (const s of sources) {
    const lastRun = s.lastRunAt
      ? new Date(s.lastRunAt).toISOString().slice(0, 16).replace('T', ' ')
      : 'never';
    console.log(
      `${String(s.id).padEnd(12)} ${String(s.domain).slice(0, 28).padEnd(30)} ${(s.entityDisplayName ?? '-').slice(0, 23).padEnd(25)} ${String(s.pageCount ?? '-').padEnd(6)} ${(s.enabled ? 'yes' : 'no').padEnd(8)} ${lastRun}`
    );
  }

  console.log(`\nTotal: ${sources.length} website sources`);
  return { exitCode: 0, output: '' };
}

// ---------------------------------------------------------------------------
// show — details for one source
// ---------------------------------------------------------------------------

async function showCommand(args: string[], _options: Options): Promise<CommandResult> {
  const sourceId = args[0];
  if (!sourceId) {
    return { exitCode: 1, output: 'Usage: crux tb website-sources show <sourceId>' };
  }

  const { getWebsiteSourcePages } = await import('../lib/wiki-server/website-sources.ts');
  const result = await getWebsiteSourcePages(sourceId);

  if (!result.ok) {
    return { exitCode: 1, output: `Failed to get pages for source ${sourceId}: ${result.error}` };
  }

  const { pages } = result.data;
  console.log(`\nSource: ${sourceId}`);
  console.log(`Pages: ${pages.length}\n`);

  if (pages.length > 0) {
    console.log(
      `${'ID'.padEnd(12)} ${'Path'.padEnd(40)} ${'Role'.padEnd(12)} ${'Enabled'.padEnd(8)} ${'Last Fetched'.padEnd(20)} Content Hash`
    );
    console.log('-'.repeat(110));

    for (const p of pages) {
      const lastFetched = p.lastFetchedAt
        ? new Date(p.lastFetchedAt).toISOString().slice(0, 16).replace('T', ' ')
        : 'never';
      console.log(
        `${p.id.padEnd(12)} ${p.path.slice(0, 38).padEnd(40)} ${(p.pageRole ?? '-').padEnd(12)} ${(p.enabled ? 'yes' : 'no').padEnd(8)} ${lastFetched.padEnd(20)} ${(p.lastContentHash ?? '-').slice(0, 12)}`
      );
    }
  }

  return { exitCode: 0, output: '' };
}

// ---------------------------------------------------------------------------
// fetch — fetch pages and store snapshots
// ---------------------------------------------------------------------------

interface FetchStats {
  pagesProcessed: number;
  snapshotsCreated: number;
  unchanged: number;
  paywalls: number;
  errors: number;
}

async function fetchCommand(args: string[], options: Options): Promise<CommandResult> {
  const fetchAll = !!options.all;
  const sourceId = args[0];
  const dryRun = !!(options.dryRun || options['dry-run']);

  if (!fetchAll && !sourceId) {
    return {
      exitCode: 1,
      output: 'Usage: crux tb website-sources fetch <sourceId>\n       crux tb website-sources fetch --all',
    };
  }

  const { listWebsiteSources, getWebsiteSourcePages, createPageSnapshot } = await import(
    '../lib/wiki-server/website-sources.ts'
  );
  const { fetchSource } = await import('../lib/search/source-fetcher.ts');
  const { generateId } = await import('../lib/grant-import/id.ts');

  // Build domain map from source list — paginate to fetch all sources
  let allSources: Array<{ id: string; domain: string; enabled: boolean; [k: string]: unknown }> = [];
  {
    const PAGE_SIZE = 200;
    let offset = 0;
    while (true) {
      const page = await listWebsiteSources(PAGE_SIZE, offset);
      if (!page.ok) {
        return { exitCode: 1, output: `Failed to list sources: ${page.error}` };
      }
      allSources.push(...page.data.sources);
      if (page.data.sources.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }
  const domainMap = new Map(allSources.map((s) => [s.id, s.domain]));

  // Determine which sources to process
  let sourceIds: string[];
  if (fetchAll) {
    sourceIds = allSources.filter((s) => s.enabled).map((s) => s.id);
    console.log(`Found ${sourceIds.length} enabled sources to process`);
  } else {
    if (!domainMap.has(sourceId!)) {
      return { exitCode: 1, output: `Source ${sourceId} not found` };
    }
    sourceIds = [sourceId!];
  }

  const limit = options.limit ? parseInt(options.limit, 10) : undefined;
  const totalStats: FetchStats = { pagesProcessed: 0, snapshotsCreated: 0, unchanged: 0, paywalls: 0, errors: 0 };

  for (const sid of sourceIds) {
    const domain = domainMap.get(sid)!;
    console.log(`\nProcessing source: ${sid} (${domain})`);

    const pagesResult = await getWebsiteSourcePages(sid);
    if (!pagesResult.ok) {
      console.error(`  Failed to get pages for ${sid}: ${pagesResult.error}`);
      totalStats.errors++;
      continue;
    }

    let pages = pagesResult.data.pages.filter((p) => p.enabled);
    if (limit && pages.length > limit) {
      pages = pages.slice(0, limit);
    }

    console.log(`  ${pages.length} enabled pages to fetch`);

    for (const page of pages) {
      totalStats.pagesProcessed++;
      const fullUrl = `https://${domain}${page.path}`;
      console.log(`  Fetching: ${fullUrl}`);

      try {
        const source = await fetchSource({ url: fullUrl, extractMode: 'full' });

        if (source.status !== 'ok') {
          console.warn(`    Status: ${source.status} (HTTP ${source.httpStatus})`);
          if (source.status === 'paywall') {
            totalStats.paywalls++;
            continue;
          }
          if (source.status === 'dead' || source.status === 'error') {
            totalStats.errors++;
            continue;
          }
        }

        const contentHash = computeContentHash(source.content);

        // Check if content has changed
        if (page.lastContentHash === contentHash) {
          console.log(`    Unchanged (hash: ${contentHash.slice(0, 12)}...)`);
          totalStats.unchanged++;
          continue;
        }

        if (dryRun) {
          console.log(
            `    [DRY RUN] Would create snapshot: ${source.content.length} chars, hash ${contentHash.slice(0, 12)}...`
          );
          totalStats.snapshotsCreated++;
          continue;
        }

        // Generate a deterministic snapshot ID
        const snapshotId = generateId(`ps:${page.id}:${contentHash}`);

        const createResult = await createPageSnapshot(sid, {
          id: snapshotId,
          websiteSourcePageId: page.id,
          url: fullUrl,
          contentHash,
          fullText: source.content,
          titleAtTime: source.title || null,
          httpStatus: source.httpStatus,
          contentLength: source.content.length,
          extractionStatus: 'pending',
          fetchedAt: new Date().toISOString(),
        });

        if (!createResult.ok) {
          console.error(`    Failed to create snapshot: ${createResult.error}`);
          totalStats.errors++;
          continue;
        }

        if (createResult.data.deduplicated) {
          console.log(`    Deduplicated (server-side hash match)`);
          totalStats.unchanged++;
        } else {
          console.log(
            `    Created snapshot ${snapshotId} (${source.content.length} chars)`
          );
          totalStats.snapshotsCreated++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    Error fetching ${fullUrl}: ${msg}`);
        totalStats.errors++;
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Pages processed: ${totalStats.pagesProcessed}`);
  console.log(`Snapshots created: ${totalStats.snapshotsCreated}`);
  console.log(`Unchanged (deduped): ${totalStats.unchanged}`);
  console.log(`Paywalls (skipped): ${totalStats.paywalls}`);
  console.log(`Errors: ${totalStats.errors}`);

  return {
    exitCode: totalStats.errors > 0 && totalStats.snapshotsCreated === 0 ? 1 : 0,
    output: '',
  };
}

// ---------------------------------------------------------------------------
// default / help
// ---------------------------------------------------------------------------

function defaultCommand(_args: string[], _options: Options): Promise<CommandResult> {
  console.log(getHelp());
  return Promise.resolve({ exitCode: 0, output: '' });
}

export const commands = {
  list: listCommand,
  show: showCommand,
  fetch: fetchCommand,
  default: defaultCommand,
};

export function getHelp(): string {
  return `
Website Sources — Fetch and snapshot website source pages

Commands:
  list                          List all registered website sources
  show <sourceId>               Show source details with pages
  fetch <sourceId>              Fetch all enabled pages for a source
  fetch --all                   Fetch pages for all enabled sources

Options:
  --dry-run                     Show what would be fetched without storing
  --limit=<N>                   Max pages to fetch per source

Examples:
  crux tb website-sources list
  crux tb website-sources show anth0001
  crux tb website-sources fetch anth0001
  crux tb website-sources fetch --all --dry-run
`.trim();
}
