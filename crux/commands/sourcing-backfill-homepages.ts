/**
 * Source-Check URL Heuristic — Narrow Homepage Backfill
 *
 * Populates `resource_purpose='homepage'` on the ~500 resources whose URLs
 * deterministically classify as a landing page (bare domain, /about, /contact,
 * etc.) with confidence >= FAST_PATH_THRESHOLD (0.8). No LLM calls, no
 * ambiguous resources — the heuristic either says "yes, homepage, confident"
 * or the resource is skipped.
 *
 * Phase 3 sub-PR 3 of QUA-313 / Discussion #4221 (revised plan, option A).
 *
 * The original Phase 3 plan assumed a 40% corpus-wide homepage rate and
 * sized a full LLM backfill around it. The `sourcing-sample-coverage`
 * command (sub-PR 2) measured the actual rate at 2-4% and found that the
 * non-homepage URLs are legitimate content (articles, papers, PDFs). This
 * command ships the "narrow tactical cleanup" interpretation: populate
 * `resource_purpose` on the hits, drop the rest of the plan.
 *
 * Defaults to --dry-run. --apply writes via `upsertResourceBatch` with
 * `{ resourcePurpose: 'homepage', enrichmentStatus: 'classified' }` in
 * chunks of 100, fail-fast on any batch error (so partial-failure state
 * doesn't accumulate). Idempotent: the filter excludes already-classified
 * rows so rerunning is safe.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { loadResourcesPGFirst } from '../resource-io.ts';
import { upsertResourceBatch, type UpsertResourceItem } from '../lib/wiki-server/resources.ts';
import { classifyByUrl } from './sourcing-audit-urls.ts';
import type { Resource } from '../resource-types.ts';
import { truncate } from '../lib/text-utils.ts';

// ── Module constants ────────────────────────────────────────────────

/**
 * Minimum confidence to be considered a fast-path homepage. Matches the
 * threshold in `crux/lib/sourcing/url-quality.ts::FAST_PATH_THRESHOLD`
 * (0.8) and the threshold used by QUA-312's `classify.ts` fast-path.
 */
const FAST_PATH_THRESHOLD = 0.8;

/** Write chunk size. 100 is below the server's 200 cap, leaves retry headroom. */
const WRITE_CHUNK = 100;

/** Output-truncation limits for human-readable mode. */
const SAMPLE_URLS_SHOWN = 20;
const TOP_DOMAINS_SHOWN = 20;

// ── ANSI helpers ────────────────────────────────────────────────────

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return !!process.stdout.isTTY;
}

const ANSI = {
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
} as const;

const bold = (s: string) => (useColor() ? `${ANSI.bold}${s}${ANSI.reset}` : s);
const green = (s: string) => (useColor() ? `${ANSI.green}${s}${ANSI.reset}` : s);
const yellow = (s: string) => (useColor() ? `${ANSI.yellow}${s}${ANSI.reset}` : s);
const dim = (s: string) => (useColor() ? `${ANSI.dim}${s}${ANSI.reset}` : s);

// ── Pure helpers (exported for tests) ───────────────────────────────

export interface BackfillCandidate {
  id: string;
  url: string;
  host: string;
  confidence: number;
  reasons: string[];
}

/** Extract the normalized hostname for a URL, or a sentinel on failure. */
function extractHostSafe(raw: string): string {
  try {
    let host = new URL(raw).hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '(invalid-url)';
  }
}

/**
 * Filter the resource pool to only fast-path homepage candidates that
 * still need classification. Skips resources that are:
 *   - missing a URL
 *   - already `classified` / `enriched` / `reviewed`
 *   - classified by the URL heuristic as non-homepage (or ambiguous < 0.8)
 *
 * Pure function — no network, no fs. Used by both the command and the
 * tests.
 */
export function selectCandidates(
  resources: ReadonlyArray<Resource>,
  threshold: number = FAST_PATH_THRESHOLD,
): BackfillCandidate[] {
  const out: BackfillCandidate[] = [];
  for (const r of resources) {
    if (!r.url) continue;
    // Skip resources already classified, enriched, or reviewed. `classified`
    // is what this command writes, so excluding it makes rerunning idempotent.
    const status = (r as Resource & { enrichment_status?: string | null }).enrichment_status;
    if (status === 'classified' || status === 'enriched' || status === 'reviewed') {
      continue;
    }
    const cls = classifyByUrl(r.url);
    if (cls.purpose !== 'homepage' || cls.confidence < threshold) continue;
    out.push({
      id: r.id,
      url: r.url,
      host: extractHostSafe(r.url),
      confidence: cls.confidence,
      reasons: cls.reasons,
    });
  }
  return out;
}

/**
 * Group candidates by domain and rank by frequency. Used in both dry-run
 * output and JSON output so operators can sanity-check the target set at
 * a glance.
 */
export function groupByDomain(
  candidates: ReadonlyArray<BackfillCandidate>,
): Array<{ host: string; count: number; sampleId: string }> {
  const map = new Map<string, { host: string; count: number; sampleId: string }>();
  for (const c of candidates) {
    const existing = map.get(c.host);
    if (existing) {
      existing.count++;
    } else {
      map.set(c.host, { host: c.host, count: 1, sampleId: c.id });
    }
  }
  return [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.host.localeCompare(b.host);
  });
}

/** Parse and clamp the --limit flag. Undefined → no limit. */
export function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ── Command ─────────────────────────────────────────────────────────

interface BackfillOptions extends BaseOptions {
  apply?: boolean;
  'dry-run'?: boolean;
  dryRun?: boolean;
  limit?: string;
  json?: boolean;
}

async function backfillCommand(
  _args: string[],
  options: BackfillOptions,
): Promise<CommandResult> {
  // --dry-run is the default. --apply flips to write mode. If the user
  // passes both, --dry-run wins (safer default).
  const explicitDryRun = options['dry-run'] || options.dryRun;
  const shouldApply = !!options.apply && !explicitDryRun;
  const dryRun = !shouldApply;
  const limit = parseLimit(options.limit);
  const isJson = !!options.json;

  if (!isJson) {
    console.log(bold('Source-Check URL Heuristic — Homepage Backfill'));
    console.log(dryRun ? dim('Mode: DRY RUN (use --apply to write)') : green('Mode: APPLY — will write to prod'));
    if (limit !== null) console.log(`Limit: ${limit} resources`);
    console.log('');
    console.log('Loading resources from wiki-server (or PG snapshot fallback)...');
  }

  let resources: Resource[];
  try {
    resources = await loadResourcesPGFirst();
  } catch (err) {
    return {
      exitCode: 1,
      output: `Failed to load resources: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const candidates = selectCandidates(resources);
  const limited = limit !== null ? candidates.slice(0, limit) : candidates;
  const byDomain = groupByDomain(limited);

  // ── JSON output (dry-run or apply both supported) ──
  if (isJson) {
    if (dryRun) {
      return {
        exitCode: 0,
        output: JSON.stringify({
          mode: 'dry-run',
          poolSize: resources.length,
          eligibleCount: candidates.length,
          plannedWrites: limited.length,
          byDomain,
        }),
      };
    }
    // Apply + JSON: run the writes, then emit the result.
    const writeOutcome = await writeChunked(limited);
    return {
      exitCode: writeOutcome.ok ? 0 : 1,
      output: JSON.stringify({
        mode: 'apply',
        poolSize: resources.length,
        eligibleCount: candidates.length,
        attempted: limited.length,
        written: writeOutcome.written,
        error: writeOutcome.error ?? null,
        byDomain,
      }),
    };
  }

  // ── Human output ──
  if (limited.length === 0) {
    console.log('');
    console.log(green('✓ No homepage backfill candidates remain. Already up to date.'));
    return { exitCode: 0, output: '' };
  }

  console.log('');
  console.log(bold('=== Homepage backfill plan ==='));
  console.log(`Pool size:        ${resources.length}`);
  console.log(`Eligible:         ${candidates.length}`);
  if (limit !== null && candidates.length > limit) {
    console.log(`Planned writes:   ${limited.length} ${dim(`(--limit=${limit} of ${candidates.length})`)}`);
  } else {
    console.log(`Planned writes:   ${limited.length}`);
  }
  console.log(`Cost:             $0 (no LLM calls)`);
  console.log('');

  console.log(bold('Top domains'));
  console.log('-'.repeat(72));
  console.log(bold(`  ${'Count'.padStart(5)}  Domain`));
  for (const d of byDomain.slice(0, TOP_DOMAINS_SHOWN)) {
    console.log(`  ${String(d.count).padStart(5)}  ${d.host}`);
  }
  if (byDomain.length > TOP_DOMAINS_SHOWN) {
    console.log(`  ... and ${byDomain.length - TOP_DOMAINS_SHOWN} more domains`);
  }
  console.log('');

  console.log(bold(`Sample URLs (first ${SAMPLE_URLS_SHOWN})`));
  console.log('-'.repeat(72));
  for (const c of limited.slice(0, SAMPLE_URLS_SHOWN)) {
    const url = truncate(c.url, 65, { ellipsis: '...' });
    console.log(`  [conf=${c.confidence.toFixed(2)}] ${url}`);
  }
  console.log('');

  if (dryRun) {
    console.log(yellow('Dry run — no writes performed. Re-run with --apply to execute.'));
    return { exitCode: 0, output: '' };
  }

  // ── Apply path ──
  console.log(bold(`Writing ${limited.length} classifications in chunks of ${WRITE_CHUNK}...`));
  const outcome = await writeChunked(limited, (batchIdx, total) => {
    console.log(`  batch ${batchIdx}/${total} — ${green('ok')}`);
  });

  if (!outcome.ok) {
    return {
      exitCode: 1,
      output: `\nFast-path batch write failed: ${outcome.error}\n  Written so far: ${outcome.written}\n`,
    };
  }

  console.log('');
  console.log(green(`✓ Wrote ${outcome.written} homepage classifications.`));
  return { exitCode: 0, output: '' };
}

interface WriteOutcome {
  ok: boolean;
  written: number;
  error?: string;
}

async function writeChunked(
  candidates: ReadonlyArray<BackfillCandidate>,
  onChunkOk?: (batchIdx: number, total: number) => void,
): Promise<WriteOutcome> {
  let written = 0;
  const total = Math.ceil(candidates.length / WRITE_CHUNK);
  for (let i = 0; i < candidates.length; i += WRITE_CHUNK) {
    const chunk = candidates.slice(i, i + WRITE_CHUNK);
    const items: UpsertResourceItem[] = chunk.map((c) => ({
      id: c.id,
      url: c.url,
      resourcePurpose: 'homepage',
      enrichmentStatus: 'classified',
    }));
    let result: Awaited<ReturnType<typeof upsertResourceBatch>>;
    try {
      result = await upsertResourceBatch(items);
    } catch (err) {
      return {
        ok: false,
        written,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!result.ok) {
      return { ok: false, written, error: result.message ?? 'unknown error' };
    }
    written += chunk.length;
    onChunkOk?.(Math.floor(i / WRITE_CHUNK) + 1, total);
  }
  return { ok: true, written };
}

// ── Exports ─────────────────────────────────────────────────────────

export const commands = {
  default: backfillCommand,
};

export function getHelp(): string {
  return `
Source-Check URL Heuristic — Homepage Backfill

Usage:
  crux sourcing-backfill-homepages [options]

Options:
  --apply                Write the classifications. Without this flag the
                         command runs as a dry run (no writes).
  --dry-run              Explicitly opt into dry-run mode (default). If both
                         --dry-run and --apply are passed, --dry-run wins.
  --limit=N              Cap the number of resources to process. Useful for
                         testing with a small batch first.
  --json                 Machine-readable output.

What it does:
  Finds resources whose URL shape is an obvious landing page (bare domain,
  /about, /contact, /home, /index, etc.) and writes
  \`resource_purpose='homepage'\` + \`enrichment_status='classified'\` via
  upsertResourceBatch. No LLM calls. Idempotent — already-classified
  resources are filtered out, so rerunning is safe.

Why narrow:
  The original URL-Quality Phase 3 plan assumed a ~40% heuristic hit rate
  and sized a full LLM backfill around it. The \`sourcing-sample-coverage\`
  tool (QUA-313 sub-PR 2) measured the actual rate at 2-4% — most wiki
  resources are specific articles/papers, not landing pages, which is
  correct behavior for a healthy wiki. This command ships the narrow
  tactical cleanup (~500 deterministic hits, $0 cost) and defers the
  rest of the plan. See Discussion #4221 for context.
`.trim();
}
