/**
 * Source-Check URL Heuristic — Sample Coverage Reporter
 *
 * Read-only. Samples N resources from the wiki-server list (or the local PG
 * snapshot as a fallback), runs `classifyByUrl` on each URL, and reports:
 *
 *   - fast-path hit rate (confidence >= FAST_PATH_THRESHOLD, 0.8)
 *   - flag-threshold hit rate (confidence >= FLAG_THRESHOLD, 0.7)
 *   - domain breakdown of fast-path hits
 *   - whether the fast-path hit rate meets the Phase 3 backfill gate (>= 40%)
 *
 * The backfill gate exists because the `backfill-resource-purpose` script
 * (sub-PR 4) will spend real LLM budget on the residual LLM-classify load.
 * At a 40% heuristic hit rate, ~12k of 20k resources still need an LLM call.
 * Below 40%, we stop and improve the heuristic before committing the $.
 *
 * Phase 3 sub-PR 2 of QUA-313 / Discussion #4221. No writes, no LLM calls,
 * no wiki-server mutations. Safe to run repeatedly.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { loadResourcesPGFirst } from '../resource-io.ts';
import { classifyByUrl } from './sourcing-audit-urls.ts';
import type { Resource } from '../resource-types.ts';

// ── Module constants ────────────────────────────────────────────────

/** Default sample size. Matches the ≥40% gate's statistical comfort zone. */
const DEFAULT_SAMPLE_SIZE = 500;
const MAX_SAMPLE_SIZE = 5000;

/** Gate threshold for the Phase 3 backfill — below this, improve the heuristic. */
const BACKFILL_GATE_THRESHOLD = 0.4;

/** Confidence cutoffs — must match `crux/lib/sourcing/url-quality.ts`. */
const FAST_PATH_THRESHOLD = 0.8;
const FLAG_THRESHOLD = 0.7;

/** Truncation limits for human-readable mode only. */
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
} as const;

const bold = (s: string) => (useColor() ? `${ANSI.bold}${s}${ANSI.reset}` : s);
const green = (s: string) => (useColor() ? `${ANSI.green}${s}${ANSI.reset}` : s);
const yellow = (s: string) => (useColor() ? `${ANSI.yellow}${s}${ANSI.reset}` : s);
const red = (s: string) => (useColor() ? `${ANSI.red}${s}${ANSI.reset}` : s);

// ── Pure helpers (exported for tests) ───────────────────────────────

/** Parse and clamp a user-supplied `--sample-size`. */
export function parseSampleSize(raw: unknown): number {
  if (raw === undefined) return DEFAULT_SAMPLE_SIZE;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SAMPLE_SIZE;
  return Math.min(n, MAX_SAMPLE_SIZE);
}

/**
 * Parse a user-supplied --seed into a uint32 RNG seed. Returns null when
 * omitted so the caller falls back to Math.random.
 */
export function parseSeed(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n >>> 0;
}

/**
 * Deterministic uint32 RNG — mulberry32. Used only when `--seed` is given
 * so the sample is reproducible across runs for the same dataset.
 */
export function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return function mulberry32(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates partial sample. Returns `min(sampleSize, pool.length)` items
 * without replacement. If `rng` is `null`, uses `Math.random`.
 *
 * Deterministic when called with a mulberry32 RNG of fixed seed. Operates on
 * a copy of the pool so the caller's array is untouched.
 */
export function sampleWithoutReplacement<T>(
  pool: readonly T[],
  sampleSize: number,
  rng: (() => number) | null,
): T[] {
  const rand = rng ?? Math.random;
  const n = Math.min(sampleSize, pool.length);
  if (n <= 0) return [];
  // Copy so we don't mutate the caller's array; FY is O(n) swaps in-place on the copy.
  const arr = [...pool];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, n);
}

/**
 * Hit-rate statistics summarized from a sample. Pure function — used to
 * derive both human-readable and --json output.
 */
export interface CoverageStats {
  sampled: number;
  fastPathHits: number;
  fastPathHitRate: number;
  flagHits: number;
  flagHitRate: number;
  meetsThreshold: boolean;
  threshold: number;
  byDomain: Array<{ host: string; fastPathHits: number; total: number }>;
  nullPurposeButConfident: number;
  unparseable: number;
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
 * Classify every item in `sample`, aggregate counts, and return stats.
 * Pure — does not touch the network, fs, or wiki-server.
 */
export function computeCoverageStats(
  sample: ReadonlyArray<{ url: string }>,
  gateThreshold: number = BACKFILL_GATE_THRESHOLD,
): CoverageStats {
  let fastPathHits = 0;
  let flagHits = 0;
  let unparseable = 0;
  let nullPurposeButConfident = 0;
  const domainMap = new Map<string, { host: string; fastPathHits: number; total: number }>();

  for (const r of sample) {
    if (!r.url) {
      unparseable++;
      continue;
    }
    const cls = classifyByUrl(r.url);
    const host = extractHostSafe(r.url);

    if (cls.reasons.includes('unparseable')) {
      unparseable++;
      continue;
    }

    // Track "confident but not a homepage" — e.g., PDFs at 0.9 confidence.
    // This is useful telemetry because the heuristic is saying "I know what
    // this is, and it's NOT a homepage". The LLM still has to fill
    // summary/key_points/etc., but the classifier signal is strong.
    if (cls.purpose === null && cls.confidence >= FAST_PATH_THRESHOLD) {
      nullPurposeButConfident++;
    }

    const isFlag = cls.purpose === 'homepage' && cls.confidence >= FLAG_THRESHOLD;
    const isFastPath = cls.purpose === 'homepage' && cls.confidence >= FAST_PATH_THRESHOLD;
    if (isFlag) flagHits++;
    if (isFastPath) fastPathHits++;

    let entry = domainMap.get(host);
    if (!entry) {
      entry = { host, fastPathHits: 0, total: 0 };
      domainMap.set(host, entry);
    }
    entry.total++;
    if (isFastPath) entry.fastPathHits++;
  }

  const sampled = sample.length;
  const fastPathHitRate = sampled > 0 ? fastPathHits / sampled : 0;
  const flagHitRate = sampled > 0 ? flagHits / sampled : 0;

  const byDomain = [...domainMap.values()]
    .filter((d) => d.fastPathHits > 0)
    .sort((a, b) => {
      if (b.fastPathHits !== a.fastPathHits) return b.fastPathHits - a.fastPathHits;
      return b.total - a.total;
    });

  return {
    sampled,
    fastPathHits,
    fastPathHitRate,
    flagHits,
    flagHitRate,
    meetsThreshold: fastPathHitRate >= gateThreshold,
    threshold: gateThreshold,
    byDomain,
    nullPurposeButConfident,
    unparseable,
  };
}

// ── Command ─────────────────────────────────────────────────────────

interface SampleCoverageOptions extends BaseOptions {
  'sample-size'?: string;
  sampleSize?: string;
  seed?: string;
  json?: boolean;
}

async function sampleCoverageCommand(
  _args: string[],
  options: SampleCoverageOptions,
): Promise<CommandResult> {
  const sampleSize = parseSampleSize(options['sample-size'] ?? options.sampleSize);
  const seed = parseSeed(options.seed);
  const isJson = !!options.json;

  if (!isJson) {
    console.log(bold('Source-Check URL Heuristic — Sample Coverage'));
    console.log(`Sample size: ${sampleSize}${seed !== null ? ` (seed=${seed})` : ''}`);
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

  // Pool = resources with a URL. Skip blanks so they don't distort the ratio.
  const pool = resources.filter((r) => !!r.url);
  if (pool.length === 0) {
    return {
      exitCode: 1,
      output: 'No resources with URLs found. Check wiki-server connectivity or PG snapshot.',
    };
  }

  const rng = seed !== null ? createRng(seed) : null;
  const sample = sampleWithoutReplacement(pool, sampleSize, rng);
  const stats = computeCoverageStats(sample);

  if (isJson) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        ...stats,
        poolSize: pool.length,
        requestedSampleSize: sampleSize,
        seed,
      }),
    };
  }

  return {
    exitCode: 0,
    output: formatHumanOutput(stats, pool.length),
  };
}

function formatHumanOutput(stats: CoverageStats, poolSize: number): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(bold('=== Sample Coverage ==='));
  lines.push(`Pool size:              ${poolSize} resources with URLs`);
  lines.push(`Sampled:                ${stats.sampled}`);
  lines.push(`Unparseable URLs:       ${stats.unparseable}`);
  lines.push('');

  const fpPct = (stats.fastPathHitRate * 100).toFixed(1);
  const flagPct = (stats.flagHitRate * 100).toFixed(1);
  const thresholdPct = (stats.threshold * 100).toFixed(0);

  lines.push(bold('Hit rates'));
  lines.push(`Fast-path (conf ≥ 0.8): ${stats.fastPathHits}/${stats.sampled} (${fpPct}%)`);
  lines.push(`Flag (conf ≥ 0.7):      ${stats.flagHits}/${stats.sampled} (${flagPct}%)`);
  lines.push(`Confident non-homepage: ${stats.nullPurposeButConfident}/${stats.sampled}`);
  lines.push('');

  const verdict = stats.meetsThreshold
    ? green(`✓ PROCEED — fast-path rate ${fpPct}% ≥ ${thresholdPct}% gate`)
    : red(`✗ STOP — fast-path rate ${fpPct}% < ${thresholdPct}% gate — improve heuristic first`);
  lines.push(bold('Backfill gate'));
  lines.push(`  ${verdict}`);
  lines.push('');

  if (stats.byDomain.length > 0) {
    lines.push(bold('Top domains (by fast-path hit count)'));
    lines.push('-'.repeat(72));
    lines.push(bold(`  ${'Hits'.padStart(5)}  ${'Total'.padStart(5)}  Domain`));
    for (const d of stats.byDomain.slice(0, TOP_DOMAINS_SHOWN)) {
      lines.push(`  ${String(d.fastPathHits).padStart(5)}  ${String(d.total).padStart(5)}  ${d.host}`);
    }
    if (stats.byDomain.length > TOP_DOMAINS_SHOWN) {
      lines.push(`  ... and ${stats.byDomain.length - TOP_DOMAINS_SHOWN} more domains with fast-path hits`);
    }
    lines.push('');
  }

  lines.push('Next steps:');
  if (stats.meetsThreshold) {
    lines.push('  1. Proceed with sub-PR 3 (sourcing-mark) and sub-PR 4 (backfill-resource-purpose).');
    lines.push('  2. Size the LLM budget cap to cover the residual (non-fast-path) resources.');
  } else {
    lines.push('  1. Do NOT run the backfill yet — the heuristic is too coarse.');
    lines.push('  2. Review the "Confident non-homepage" count — even when fast-path hits are below');
    lines.push('     the gate, the heuristic may already be confident on non-homepage URLs.');
    lines.push('  3. Consider extending HOMEPAGE_PATHS / DATA_PARAM_KEYS to reduce ambiguous cases.');
  }
  if (stats.unparseable > stats.sampled / 10) {
    lines.push('');
    lines.push(yellow(`⚠ ${stats.unparseable} unparseable URLs (>10% of sample) — investigate data quality.`));
  }
  return lines.join('\n');
}

// ── Exports ─────────────────────────────────────────────────────────

export const commands = {
  default: sampleCoverageCommand,
};

export function getHelp(): string {
  return `
Source-Check URL Heuristic — Sample Coverage Reporter

Usage:
  crux sourcing-sample-coverage [options]

Options:
  --sample-size=N        Random sample size (default: 500, max: 5000)
  --seed=N               Seed the RNG for reproducible samples (uint32)
  --json                 Machine-readable output

Output:
  Fast-path hit rate, flag-threshold hit rate, domain breakdown of
  heuristic homepage hits, and a gate verdict (≥40% → proceed with
  Phase 3 backfill; below → improve the heuristic first).

No writes, no LLM calls. Safe to run repeatedly.

Reads the full resource list from wiki-server (or falls back to the
local PG snapshot if the server is unreachable).
`.trim();
}
