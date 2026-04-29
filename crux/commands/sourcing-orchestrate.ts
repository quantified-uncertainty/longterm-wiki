/**
 * Source-Check Orchestrator — command entry point.
 *
 * Thin wrapper: CLI parsing, argument validation, subcommand routing.
 * All logic lives in crux/lib/sourcing/.
 *
 * Usage:
 *   crux sourcing orchestrate --dry-run                     Preview what would be checked
 *   crux sourcing orchestrate --budget=5 --limit=50         Check up to 50 items, $5 budget
 *   crux sourcing orchestrate --type=fact                   Check only FactBase facts
 *   crux sourcing orchestrate --type=record                 Check only structured records
 *   crux sourcing orchestrate --type=entity                 Check entities via web search
 *   crux sourcing orchestrate --entity-type=organization    Filter by entity type
 *   crux sourcing orchestrate --source=web-search           Include web search for sourceless entities
 */

import type { CommandResult } from '../lib/command-types.ts';
import { getSourcingStats } from '../lib/wiki-server/sourcing-client.ts';
import { getFailures, type VerdictEntry } from '../lib/wiki-server/sourcing.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { getCitationContentByUrl } from '../lib/wiki-server/citations.ts';
import { createJob } from '../lib/wiki-server/jobs.ts';
import type { RecordType } from '../../apps/wiki-server/src/api-types.ts';
import { orchestrateCommand } from '../lib/sourcing/orchestrator.ts';
import type { OrchestrateOptions } from '../lib/sourcing/orchestrator-types.ts';
import { cleanContradictedCommand } from './clean-contradicted.ts';

export { orchestrateCommand } from '../lib/sourcing/orchestrator.ts';

// ── Stats command ─────────────────────────────────────────────────────

async function statsCommand(): Promise<CommandResult> {
  const response = await getSourcingStats();

  if (!response.ok) {
    return { exitCode: 1, output: `Failed to fetch stats: ${response.error}` };
  }

  const stats = response.data;
  const lines: string[] = [];
  lines.push('\x1b[1m=== Source-Check Stats ===\x1b[0m');
  lines.push(`Total verdicts: ${stats.total}`);
  lines.push(`Average confidence: ${(stats.avg_confidence * 100).toFixed(0)}%`);
  lines.push(`Needs recheck: ${stats.needs_recheck}`);
  lines.push('');

  lines.push('\x1b[1mBy verdict:\x1b[0m');
  for (const [verdict, cnt] of Object.entries(stats.by_verdict)) {
    const color = verdict === 'confirmed' ? '\x1b[32m' : verdict === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
    lines.push(`  ${color}${verdict.padEnd(15)}\x1b[0m ${cnt}`);
  }
  lines.push('');

  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, cnt] of Object.entries(stats.by_type)) {
    lines.push(`  ${type.padEnd(20)} ${cnt}`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Record-type subcommand routing ────────────────────────────────────

/** Map plural/singular CLI subcommand names to RecordType */
const RECORD_TYPE_MAP: Record<string, RecordType> = {
  grant: 'grant',
  grants: 'grant',
  personnel: 'personnel',
  division: 'division',
  divisions: 'division',
  'funding-program': 'funding-program',
  'funding-programs': 'funding-program',
  'funding-round': 'funding-round',
  'funding-rounds': 'funding-round',
  investment: 'investment',
  investments: 'investment',
  'equity-position': 'equity-position',
  'equity-positions': 'equity-position',
  publication: 'publication',
  publications: 'publication',
  'benchmark-result': 'benchmark-result',
  'benchmark-results': 'benchmark-result',
  'entity-event': 'entity-event',
  'entity-events': 'entity-event',
  'entity-assessment': 'entity-assessment',
  'entity-assessments': 'entity-assessment',
  'secondary-market-price': 'secondary-market-price',
  'secondary-market-prices': 'secondary-market-price',
};

/**
 * Unified verify command entry point.
 * Routes to orchestrate, stats, or record-type-specific sourcing.
 */
async function verifyCommand(
  args: string[],
  options: OrchestrateOptions,
): Promise<CommandResult> {
  const subcommand = args[0];

  // Stats subcommand
  if (subcommand === 'stats') {
    return statsCommand();
  }

  // Backfill subcommand
  if (subcommand === 'backfill') {
    return backfillCommand(args.slice(1), options);
  }

  // Contradicted subcommand
  if (subcommand === 'contradicted') {
    return contradictedCommand(args.slice(1), options);
  }

  // Clean subcommand — export + delete contradicted records
  if (subcommand === 'clean') {
    return cleanContradictedCommand(args.slice(1), options);
  }

  // sync-things subcommand (deprecated)
  if (subcommand === 'sync-things') {
    return { exitCode: 0, output: 'sync-things is no longer needed -- Things table no longer stores verdicts.' };
  }

  // orchestrate subcommand (explicit)
  if (subcommand === 'orchestrate') {
    return orchestrateCommand(args.slice(1), options);
  }

  // Record type subcommands (grants, personnel, etc.)
  const mapped = subcommand ? RECORD_TYPE_MAP[subcommand] : undefined;
  if (mapped) {
    // Route to orchestrate with --type=record and table filter for the specific record type
    const recordOptions: OrchestrateOptions = {
      ...options,
      type: 'record',
      table: mapped,
    };
    return orchestrateCommand(args.slice(1), recordOptions);
  }

  // Default: run orchestrate
  return orchestrateCommand(args, options);
}

// ── Backfill command ─────────────────────────────────────────────────

/**
 * Automated backfill: sync source URLs → enqueue ingestion → run sourcing.
 *
 * Replaces the manual multi-step process:
 *   1. fb sync-sources (sync FactBase URLs to resources)
 *   2. Extract record source URLs from grants/personnel APIs
 *   3. Create resource-ingest jobs for uncached URLs
 *   4. Run sourcing orchestrator
 *
 * Usage: crux tb verify backfill --budget=20 --limit=2000 [--dry-run]
 */
async function backfillCommand(
  _args: string[],
  options: OrchestrateOptions,
): Promise<CommandResult> {
  const dryRun = !!options.dryRun;
  const lines: string[] = [];
  lines.push('\x1b[1m=== Source-Check Backfill ===\x1b[0m');
  if (dryRun) lines.push('\x1b[33mDRY RUN — no jobs will be created\x1b[0m');
  lines.push('');

  // Step 1: Collect record source URLs from grants + personnel APIs
  lines.push('\x1b[1mStep 1: Collecting record source URLs...\x1b[0m');
  const urls = new Set<string>();
  for (const endpoint of ['/api/grants/all', '/api/personnel/all']) {
    let offset = 0;
    while (true) {
      // typed-client-ok: QUA-770 baseline — CLI command, follow-up migration to typed client tracked
      const r = await apiRequest<{ grants?: Array<{ source?: string }>; personnel?: Array<{ source?: string }>; total: number }>(
        'GET', `${endpoint}?limit=200&offset=${offset}`,
      );
      if (!r.ok) break;
      const items = r.data.grants || r.data.personnel || [];
      for (const item of items) {
        if (item.source?.startsWith('https://')) urls.add(item.source);
      }
      if (items.length < 200) break;
      offset += 200;
    }
  }
  lines.push(`  Record source URLs: ${urls.size}`);

  // Step 2: Check which URLs are uncached
  lines.push('\x1b[1mStep 2: Checking cache coverage...\x1b[0m');
  let cached = 0;
  let uncached = 0;
  const uncachedUrls: string[] = [];
  for (const url of urls) {
    const cc = await getCitationContentByUrl(url);
    if (cc.ok && (cc.data as Record<string, unknown>)?.fullText) {
      cached++;
    } else {
      uncached++;
      uncachedUrls.push(url);
    }
  }
  lines.push(`  Cached: ${cached} | Uncached: ${uncached}`);

  // Step 3: Enqueue resource-ingest jobs for uncached URLs
  if (uncachedUrls.length > 0 && !dryRun) {
    lines.push(`\x1b[1mStep 3: Enqueuing ${uncachedUrls.length} resource-ingest jobs...\x1b[0m`);
    let enqueued = 0;
    for (const url of uncachedUrls) {
      // Use URL hash as resource ID for simplicity
      const id = 'rec-' + url.replace(/[^a-z0-9]/gi, '').slice(0, 16);
      const r = await createJob({ type: 'resource-ingest', params: { url, resourceId: id } });
      if (r.ok) enqueued++;
    }
    lines.push(`  Enqueued: ${enqueued}`);
    lines.push('');
    lines.push('  \x1b[33mResource-ingest jobs are queued. Dispatch workers to process them:\x1b[0m');
    lines.push('  gh workflow run job-worker.yml -R quantified-uncertainty/longterm-wiki \\');
    lines.push(`    --field job_type=resource-ingest --field max_jobs=${Math.min(enqueued + 50, 1000)}`);
    lines.push('');
    lines.push('  Then re-run this command to verify (after workers complete).');
  } else if (uncachedUrls.length > 0) {
    lines.push(`\x1b[1mStep 3: Would enqueue ${uncachedUrls.length} resource-ingest jobs (dry run)\x1b[0m`);
  } else {
    lines.push('\x1b[32mStep 3: All record sources are cached — skipping ingestion.\x1b[0m');
  }

  // Step 4: Run sourcing if cache coverage is reasonable
  if (uncached === 0 || (cached > 0 && uncached < urls.size * 0.5)) {
    lines.push('');
    lines.push('\x1b[1mStep 4: Running sourcing...\x1b[0m');
    console.log(lines.join('\n'));

    return orchestrateCommand([], options);
  }

  lines.push('');
  lines.push(`Cache coverage: ${((cached / Math.max(urls.size, 1)) * 100).toFixed(0)}% — ` +
    'run resource-ingest workers first, then re-run backfill.');

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Contradicted command ─────────────────────────────────────────────

/**
 * List contradicted sourcing verdicts with their reasoning.
 *
 * Usage: crux tb verify contradicted [--type=grant|personnel|...] [--limit=50]
 */
async function contradictedCommand(
  _args: string[],
  options: OrchestrateOptions,
): Promise<CommandResult> {
  const limit = options.limit ? parseInt(String(options.limit), 10) : 50;
  const recordType = options.table as string | undefined;
  const lines: string[] = [];

  const result = await getFailures({
    error_type: 'contradicted',
    record_type: recordType,
    limit,
  });

  if (!result.ok) {
    return { exitCode: 1, output: `Failed to fetch contradicted verdicts: ${result.error}` };
  }

  const data = result.data as {
    items: VerdictEntry[];
    total: number;
    byErrorType?: Record<string, number>;
  };
  const verdicts = data.items;
  const total = data.total;

  lines.push(`\x1b[1m\x1b[31m=== Contradicted Verdicts (${verdicts.length}/${total}) ===\x1b[0m`);
  lines.push('');

  if (data.byErrorType) {
    lines.push('\x1b[1mBreakdown:\x1b[0m');
    for (const [type, count] of Object.entries(data.byErrorType)) {
      lines.push(`  ${type}: ${count}`);
    }
    lines.push('');
  }

  for (const v of verdicts) {
    const conf = v.confidence != null ? ` (${(v.confidence * 100).toFixed(0)}%)` : '';
    lines.push(`\x1b[31m✗\x1b[0m ${v.recordType}/${v.recordId} — ${v.displayName || 'unknown'}${conf}`);
    if (v.reasoning) {
      // Wrap reasoning to ~100 chars for readability
      const reason = v.reasoning.slice(0, 300);
      lines.push(`  \x1b[2m${reason}${v.reasoning.length > 300 ? '...' : ''}\x1b[0m`);
    }
    lines.push('');
  }

  if (total > verdicts.length) {
    lines.push(`\x1b[2m...and ${total - verdicts.length} more. Use --limit=${total} to see all.\x1b[0m`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: verifyCommand,
  orchestrate: orchestrateCommand,
  stats: statsCommand,
  backfill: backfillCommand,
  contradicted: contradictedCommand,
  clean: cleanContradictedCommand,
};

export function getHelp(): string {
  return `
Source-Check — verify structured data against source URLs

Usage:
  crux tb verify [options]                 Run sourcing across all data layers
  crux tb verify orchestrate [options]     Full orchestrated sourcing with prioritization
  crux tb verify stats                     Show sourcing coverage report
  crux tb verify backfill [options]        Automated: sync sources → enqueue ingest → verify
  crux tb verify contradicted [options]    List contradicted verdicts with reasoning
  crux tb verify clean [--apply]           Export + delete contradicted PG records
  crux tb verify grants                    Verify all grants (shorthand for --type=record)
  crux tb verify personnel                 Verify all personnel records
  crux tb verify divisions                 Verify all divisions
  crux tb verify funding-programs          Verify funding programs
  crux tb verify funding-rounds            Verify funding rounds
  crux tb verify investments               Verify investments
  crux tb verify equity-positions          Verify equity positions
  crux tb verify publications              Verify publications
  crux tb verify benchmark-results         Verify benchmark results
  crux tb verify entity-events             Verify entity events
  crux tb verify entity-assessments        Verify entity assessments
  crux tb verify secondary-market-prices   Verify secondary market prices

Options:
  --budget=N             Max dollars to spend on LLM calls (est. ~$0.01/item)
  --limit=N              Max number of items to verify
  --type=X               What to verify: fact | record | entity | all (default: all)
  --entity-type=X        Filter by entity type (organization, person, ai-model, ...)
  --entity=X             Filter by entity (org or person stableId)
  --source=X             Source mode: existing | web-search | all (default: existing)
  --concurrency=N        Parallel task count (default: 5, hard max: 8).
                         Values above 8 are silently clamped with a
                         stderr warning. No env-var escape hatch — the
                         cap exists because --concurrency=20 tripped
                         the wiki-server's IPS firewall on 2026-04-09
                         (QUA-150). Each task fans out to ~5 HTTP calls,
                         so the effective peak is ~40 in-flight writes.
  --dry-run              Show what would be verified without calling LLM
  --ci                   JSON output

Priority order:
  1. Never-verified items first
  2. Items flagged needsRecheck
  3. High reader/research importance (from page data)
  4. Volatile entity types (ai-model, organization, person)
  5. Staleness (oldest sourcing first)

Examples:
  crux tb verify --dry-run                              Preview sourcing plan
  crux tb verify orchestrate --budget=5 --limit=100     Verify up to 100 items, $5 cap
  crux tb verify grants --dry-run                       Preview which grants would be checked
  crux tb verify personnel --entity=anthropic           Verify Anthropic personnel records
  crux tb verify stats                                  Show sourcing coverage
  crux tb verify --type=fact --entity-type=organization  Verify organization facts
  crux tb verify --type=record --limit=20               Verify 20 records
`;
}
