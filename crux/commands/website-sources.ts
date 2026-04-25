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
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { CommandResult } from '../lib/command-types.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

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
  budget?: string;
  'budget-usd'?: string;
  submit?: boolean;
  runId?: string;
  'run-id'?: string;
  'from-targets'?: string;
  pages?: string;
  top?: string;
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
// register — populate website_sources + website_source_pages from
//            data/burst-targets.yaml (QUA-642)
// ---------------------------------------------------------------------------

interface BurstTarget {
  slug: string;
  name: string;
  importance_rank: number;
  estimated_size_tier: string;
}

interface BurstTargetsFile {
  targets: BurstTarget[];
}

interface YamlOrg {
  id: string;
  stableId?: string;
  title?: string;
  website?: string;
}

/** Default pages to register for each org when none is provided via --pages. */
const DEFAULT_PAGES: ReadonlyArray<{
  path: string;
  role: 'about' | 'team' | 'research';
  extract: string[];
}> = [
  { path: '/about', role: 'about', extract: ['mission', 'headquarters', 'headcount'] },
  { path: '/team', role: 'team', extract: ['personnel'] },
  { path: '/research', role: 'research', extract: ['research_areas'] },
];

/**
 * Extract the hostname (sans www.) from a URL. Returns null if the URL
 * is unparseable.
 */
export function normalizeDomain(websiteUrl: string): string | null {
  try {
    const u = new URL(websiteUrl.trim());
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Generate a deterministic 10-char alphanumeric ID from an input string.
 * Uses the same SHA-256 → base64url → strip `-`/`_` scheme as the rest
 * of the codebase (see `crux/lib/grant-import/id.ts`), but inlined so
 * the command is self-contained.
 */
function deriveRegisterId(input: string): string {
  const hash = createHash('sha256').update(input).digest('base64url');
  // Replace -/_ with deterministic chars so the ID is strictly alphanumeric.
  return hash.substring(0, 10).replace(/[-_]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return '0123456789abcdefghijklmnopqrstuvwxyz'[code % 36];
  });
}

function loadBurstTargets(): BurstTarget[] {
  const path = join(PROJECT_ROOT, 'data', 'burst-targets.yaml');
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as BurstTargetsFile;
  if (!parsed?.targets || !Array.isArray(parsed.targets)) {
    throw new Error(`data/burst-targets.yaml has no "targets" array`);
  }
  return parsed.targets;
}

function loadOrganizationsYaml(): Map<string, YamlOrg> {
  const path = join(PROJECT_ROOT, 'data', 'entities', 'organizations.yaml');
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as YamlOrg[];
  const map = new Map<string, YamlOrg>();
  for (const org of parsed) {
    if (org?.id) map.set(org.id, org);
  }
  return map;
}

async function registerCommand(args: string[], options: Options): Promise<CommandResult> {
  const dryRun = !!(options.dryRun || options['dry-run']);
  const fromTargets = options['from-targets'] !== 'false'; // defaults true
  const topN = options.top ? parseInt(options.top, 10) : undefined;
  const customPaths = options.pages ? options.pages.split(',').map((p) => p.trim()).filter(Boolean) : null;

  if (!fromTargets && args.length === 0) {
    return {
      exitCode: 1,
      output: 'Usage: crux tb website-sources register [--top=N] [--dry-run] [--pages=/a,/b,/c]',
    };
  }

  const targets = loadBurstTargets();
  const orgs = loadOrganizationsYaml();

  const selected = topN ? targets.slice(0, topN) : targets;

  const sourceItems: Array<{
    id: string;
    domain: string;
    entityId: string | null;
    entityDisplayName: string | null;
    reliability: 'high';
    refreshIntervalDays: number;
    enabled: boolean;
  }> = [];
  const pageItems: Array<{
    id: string;
    sourceId: string;
    path: string;
    pageRole: 'about' | 'team' | 'research';
    extractTargets: string[];
    enabled: boolean;
  }> = [];
  const skipped: string[] = [];

  for (const t of selected) {
    const org = orgs.get(t.slug);
    if (!org?.website) {
      skipped.push(`${t.slug}: no website in organizations.yaml`);
      continue;
    }
    const domain = normalizeDomain(org.website);
    if (!domain) {
      skipped.push(`${t.slug}: website "${org.website}" is not a parseable URL`);
      continue;
    }
    if (!org.stableId) {
      skipped.push(`${t.slug}: no stableId — skipping FK`);
      // still register the source, just without entityId
    }

    const sourceId = deriveRegisterId(`ws:${domain}`);
    sourceItems.push({
      id: sourceId,
      domain,
      entityId: org.stableId ?? null,
      entityDisplayName: org.title ?? t.name,
      reliability: 'high',
      refreshIntervalDays: 30,
      enabled: true,
    });

    const pageDefs = customPaths
      ? customPaths.map((p) => {
          const role: 'about' | 'team' | 'research' = p.includes('team')
            ? 'team'
            : p.includes('research')
              ? 'research'
              : 'about';
          return { path: p, role, extract: [] as string[] };
        })
      : DEFAULT_PAGES;

    for (const pd of pageDefs) {
      const pageId = deriveRegisterId(`wsp:${sourceId}:${pd.path}`);
      pageItems.push({
        id: pageId,
        sourceId,
        path: pd.path,
        pageRole: pd.role,
        extractTargets: pd.extract,
        enabled: true,
      });
    }
  }

  console.log(
    `\n[register] ${sourceItems.length} sources + ${pageItems.length} pages ready (skipped ${skipped.length})`,
  );

  if (skipped.length > 0) {
    console.log('\n[register] skipped targets:');
    for (const s of skipped.slice(0, 10)) console.log(`  - ${s}`);
    if (skipped.length > 10) console.log(`  ... and ${skipped.length - 10} more`);
  }

  if (dryRun) {
    console.log('\n[register] DRY RUN — not writing. First 3 sources:');
    for (const s of sourceItems.slice(0, 3)) {
      console.log(`  ${s.id}  ${s.domain.padEnd(30)}  ${s.entityDisplayName}`);
    }
    return { exitCode: 0, output: '' };
  }

  const { syncWebsiteSources, syncWebsitePages } = await import(
    '../lib/wiki-server/website-sources.ts'
  );

  const srcRes = await syncWebsiteSources(sourceItems);
  if (!srcRes.ok) {
    return { exitCode: 1, output: `Failed to sync sources: ${srcRes.error}` };
  }
  console.log(`[register] sources upserted: ${srcRes.data.upserted}`);

  // Pages must be synced in chunks — sync-pages is bounded to 500 items per batch.
  const CHUNK = 500;
  let totalPages = 0;
  for (let i = 0; i < pageItems.length; i += CHUNK) {
    const chunk = pageItems.slice(i, i + CHUNK);
    const pgRes = await syncWebsitePages(chunk);
    if (!pgRes.ok) {
      return {
        exitCode: 1,
        output: `Failed to sync pages chunk [${i}..${i + chunk.length}]: ${pgRes.error}`,
      };
    }
    totalPages += pgRes.data.upserted;
  }
  console.log(`[register] pages upserted: ${totalPages}`);

  return { exitCode: 0, output: '' };
}

// ---------------------------------------------------------------------------
// extract — LLM-extract personnel from pending page snapshots and POST to
//           /api/enrichment/propose at tier=T2 (QUA-642)
// ---------------------------------------------------------------------------

interface ExtractStats {
  snapshotsProcessed: number;
  snapshotsExtracted: number;
  snapshotsFailed: number;
  peopleExtracted: number;
  proposalsAccepted: number;
  proposalsRejected: number;
  totalCost: number;
  budgetStopped: boolean;
}

async function extractCommand(_args: string[], options: Options): Promise<CommandResult> {
  const dryRun = !!(options.dryRun || options['dry-run']);
  const submit = !!options.submit && !dryRun;
  const limit = options.limit ? parseInt(options.limit, 10) : undefined;
  const budgetUsd = options.budget
    ? parseFloat(options.budget)
    : options['budget-usd']
      ? parseFloat(options['budget-usd'])
      : undefined;
  const runId = options.runId || options['run-id'] || `qua-642-${new Date().toISOString().slice(0, 10)}`;

  const {
    listPendingSnapshots,
    getPageSnapshot,
    updateSnapshotExtraction,
  } = await import('../lib/wiki-server/website-sources.ts');
  const {
    extractPersonnelFromSnapshot,
    buildPersonnelProposals,
  } = await import('./tb-importers/website-personnel-extractor.ts');
  const { submitT2Batch } = await import('./tb-importers/propose-t2-client.ts');

  // Paginate through all pending snapshots up to --limit.
  const pending: Array<{
    id: string;
    sourceId: string;
    url: string;
    entityDisplayName: string | null;
    entityId: string | null;
    domain: string;
    pagePath: string;
  }> = [];
  const PAGE_SIZE = 50;
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await listPendingSnapshots(PAGE_SIZE, offset);
    if (!page.ok) {
      return { exitCode: 1, output: `Failed to list pending snapshots: ${page.error}` };
    }
    pending.push(
      ...page.data.snapshots.map((s) => ({
        id: s.id,
        sourceId: s.sourceId,
        url: s.url,
        entityDisplayName: s.entityDisplayName,
        entityId: s.entityId,
        domain: s.domain,
        pagePath: s.pagePath,
      })),
    );
    if (page.data.snapshots.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (limit && pending.length >= limit) break;
  }

  const queue = limit ? pending.slice(0, limit) : pending;
  console.log(
    `[extract] ${queue.length} pending snapshots to process (dryRun=${dryRun} submit=${submit} runId=${runId})`,
  );
  if (budgetUsd != null) {
    console.log(`[extract] budget cap: $${budgetUsd.toFixed(2)} USD`);
  }

  const stats: ExtractStats = {
    snapshotsProcessed: 0,
    snapshotsExtracted: 0,
    snapshotsFailed: 0,
    peopleExtracted: 0,
    proposalsAccepted: 0,
    proposalsRejected: 0,
    totalCost: 0,
    budgetStopped: false,
  };

  for (const ps of queue) {
    if (budgetUsd != null && stats.totalCost >= budgetUsd) {
      console.log(
        `[extract] BUDGET STOP — spent $${stats.totalCost.toFixed(3)} ≥ cap $${budgetUsd.toFixed(2)}`,
      );
      stats.budgetStopped = true;
      break;
    }

    stats.snapshotsProcessed++;
    console.log(`\n[extract] ${ps.id}  ${ps.url}`);

    // Fetch the snapshot body (fullText + contentHash).
    const snapshotRes = await getPageSnapshot(ps.sourceId, ps.id);
    if (!snapshotRes.ok) {
      console.warn(`  skip: couldn't load snapshot: ${snapshotRes.error}`);
      stats.snapshotsFailed++;
      continue;
    }
    const snap = snapshotRes.data;

    // Only team/about/research-style pages yield personnel; skip the rest
    // but leave extractionStatus=pending so a future model extending to
    // other record types can pick them up.
    if (!ps.pagePath.includes('team') && !ps.pagePath.includes('about') && !ps.pagePath.includes('people')) {
      console.log(`  skip (no personnel content expected on path "${ps.pagePath}")`);
      continue;
    }

    const orgSlug = ps.entityId ?? ps.domain;
    const orgName = ps.entityDisplayName ?? ps.domain;

    let result: Awaited<ReturnType<typeof extractPersonnelFromSnapshot>>;
    try {
      result = await extractPersonnelFromSnapshot({
        orgSlug,
        orgName,
        sourceUrl: snap.url,
        snapshotText: snap.fullText,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  extractor error: ${msg}`);
      stats.snapshotsFailed++;
      if (!dryRun) {
        await updateSnapshotExtraction(ps.sourceId, ps.id, 'failed', { error: msg });
      }
      continue;
    }

    stats.totalCost += result.cost;
    console.log(
      `  extracted ${result.people.length} people (rejected ${result.rejectedPeople} ungrounded, $${result.cost.toFixed(4)})`,
    );

    if (result.people.length === 0) {
      if (!dryRun) {
        await updateSnapshotExtraction(ps.sourceId, ps.id, 'extracted', {
          people: [],
          stats: { cost: result.cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        });
      }
      continue;
    }

    const proposals = buildPersonnelProposals(result.people, {
      orgSlug,
      orgName,
      sourceUrl: snap.url,
      snapshotContentHash: snap.contentHash,
      snapshotText: result.truncatedSource,
    });

    const submissions = await submitT2Batch(proposals, { submit, runId });
    let accepted = 0;
    let rejected = 0;
    const rejectionSamples: string[] = [];
    for (const s of submissions) {
      if (s.status === 'accepted') accepted++;
      else if (s.status === 'rejected') {
        rejected++;
        if (rejectionSamples.length < 3) rejectionSamples.push(s.reason ?? 'no reason');
      }
    }
    stats.peopleExtracted += result.people.length;
    stats.proposalsAccepted += accepted;
    stats.proposalsRejected += rejected;
    stats.snapshotsExtracted++;
    console.log(`  proposals: accepted=${accepted} rejected=${rejected} pending=${submissions.length - accepted - rejected}`);
    if (rejectionSamples.length > 0) {
      for (const r of rejectionSamples) console.log(`    ✗ ${r.slice(0, 150)}`);
    }

    if (!dryRun) {
      await updateSnapshotExtraction(ps.sourceId, ps.id, 'extracted', {
        people: result.people,
        stats: {
          cost: result.cost,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          accepted,
          rejected,
        },
      });
    }
  }

  console.log('\n--- Extract Summary ---');
  console.log(`Snapshots processed: ${stats.snapshotsProcessed}`);
  console.log(`Snapshots extracted: ${stats.snapshotsExtracted}`);
  console.log(`Snapshots failed: ${stats.snapshotsFailed}`);
  console.log(`People extracted: ${stats.peopleExtracted}`);
  console.log(`Proposals accepted: ${stats.proposalsAccepted}`);
  console.log(`Proposals rejected: ${stats.proposalsRejected}`);
  console.log(`Total LLM cost: $${stats.totalCost.toFixed(3)} USD`);
  if (stats.budgetStopped) console.log(`Stopped by budget cap.`);

  return { exitCode: 0, output: '' };
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
  // "snapshot" is an alias of "fetch" — the ticket uses the word "snapshot"
  // for the capture step; the implementation has historically been called
  // "fetch" in this CLI. Kept both to satisfy QUA-642's named deliverables.
  snapshot: fetchCommand,
  register: registerCommand,
  extract: extractCommand,
  default: defaultCommand,
};

export function getHelp(): string {
  return `
Website Sources — Fetch and snapshot website source pages (T2 pipeline, QUA-642)

Commands:
  list                          List all registered website sources
  show <sourceId>               Show source details with pages
  register                      Register burst-targets.yaml orgs + default pages
  fetch <sourceId>              Fetch all enabled pages for a source
  fetch --all                   Fetch pages for all enabled sources
  snapshot <sourceId>           Alias of fetch (ticket-named deliverable)
  extract                       LLM-extract personnel from pending snapshots
                                and POST to /api/enrichment/propose at T2

Options:
  --dry-run                     Show what would be written without storing
  --limit=<N>                   Max items to process (pages for fetch, snapshots for extract)
  --top=<N>                     register: only top-N orgs from burst-targets.yaml
  --pages=/a,/b,/c              register: custom page paths (default /about,/team,/research)
  --submit                      extract: actually POST to /propose (default dry-run)
  --budget-usd=<X>              extract: stop when LLM cost reaches $X
  --run-id=<id>                 extract: correlate with an enrichment_runs row

Examples:
  crux tb website-sources register --top=10 --dry-run
  crux tb website-sources register --top=50
  crux tb website-sources fetch --all --limit=3
  crux tb website-sources extract --dry-run --limit=5
  crux tb website-sources extract --submit --budget-usd=5 --run-id=qua-642-burst-1
`.trim();
}
