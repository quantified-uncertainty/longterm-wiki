#!/usr/bin/env node

/**
 * Stale Fact Detector
 *
 * Checks `data/facts/*.yaml` for facts with `asOf` dates that are past their
 * freshness threshold. Uses tiered thresholds by measure type so volatile
 * facts (headcount, revenue) are flagged sooner than stable ones.
 *
 * Usage:
 *   pnpm crux validate stale-facts
 *   pnpm crux validate stale-facts --top=20
 *   pnpm crux validate stale-facts --entity=anthropic
 *   pnpm crux validate stale-facts --months=3
 *   pnpm crux validate stale-facts --json
 *
 * Exit codes:
 *   0 = No stale facts above threshold
 *   1 = One or more facts flagged as stale
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/581
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import { DATA_DIR } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import type { ValidatorResult } from './types.ts';

// ---------------------------------------------------------------------------
// Staleness thresholds by measure type (in months)
// ---------------------------------------------------------------------------

/**
 * Tiered staleness thresholds for **current-state** measures.
 *
 * Only measures listed here are checked for staleness. Facts with an
 * unrecognized or absent measure are assumed to be historical records
 * (one-time events, archived snapshots) and are intentionally excluded.
 *
 * The "most recent fact" for an entity+measure combo is what matters —
 * older historical values in a timeseries are expected to be stale.
 */
const MEASURE_THRESHOLDS: Record<string, number> = {
  // Very volatile — flag after 3 months
  headcount: 3,
  'safety-researcher-count': 3,
  'interpretability-team-size': 3,
  'user-count': 3,
  'customer-count': 3,

  // Moderately volatile — flag after 6 months
  revenue: 6,
  'product-revenue': 6,
  valuation: 6,
  'total-funding': 6,
  'cash-burn': 6,
  'market-share': 6,
  'retention-rate': 6,
  'benchmark-score': 6,
  'equity-value': 6,
  'gross-margin': 6,
  'compute-cost': 6,
  'safety-staffing-ratio': 6,

  // Slowly changing — flag after 12 months
  'equity-stake-percent': 12,
  'infrastructure-investment': 12,
  'philanthropic-capital': 12,
  'model-parameters': 12,
  'revenue-guidance': 12,
  'net-worth': 12,
  'customer-concentration': 12,
};

/** Default threshold for unrecognized measures (not actively used — see loader). */
const DEFAULT_THRESHOLD_MONTHS = 12;

/**
 * Measures that are never considered stale — they record historical events
 * or one-time facts that will not (or cannot) change.
 */
const NEVER_STALE_MEASURES = new Set([
  'founding-date',
  'death-date',
  'founding-year',
  'shutdown-date',
  'acquisition-date',
  'funding-round', // specific investment rounds are historical events
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawFact {
  label?: string;
  value?: unknown;
  asOf?: string;
  measure?: string;
  source?: string;
  note?: string;
}

interface StaleFact {
  entity: string;
  factId: string;
  label: string;
  measure: string;
  asOf: string;
  ageMonths: number;
  thresholdMonths: number;
  value: unknown;
  source?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse "YYYY-MM" or "YYYY-MM-DD" → Date. Returns null if unparseable. */
function parseAsOf(s: string): Date | null {
  if (!s) return null;
  const parts = s.split('-');
  if (parts.length === 2) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    if (!isNaN(y) && !isNaN(m)) return new Date(y, m, 1);
    return null;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Return fractional months between two dates. */
function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

function thresholdFor(measure: string): number {
  return MEASURE_THRESHOLDS[measure] ?? DEFAULT_THRESHOLD_MONTHS;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load all facts and return only the **most recent** fact per entity+measure
 * combination that exceeds its staleness threshold.
 *
 * Rationale: timeseries data (e.g., Anthropic revenue over time) is expected
 * to have many historical entries. Only the newest value can be stale in a
 * meaningful sense — older historical values are intentional records.
 */
function loadAllFacts(): StaleFact[] {
  const factsDir = join(DATA_DIR, 'facts');
  if (!existsSync(factsDir)) return [];

  const today = new Date();

  // entity+measure → most-recent fact
  const latestByMeasure = new Map<string, { factId: string; fact: RawFact; asOfDate: Date }>();

  for (const filename of readdirSync(factsDir)) {
    if (!filename.endsWith('.yaml')) continue;
    const entity = filename.replace(/\.yaml$/, '');

    let raw: unknown;
    try {
      raw = parse(readFileSync(join(factsDir, filename), 'utf-8'));
    } catch {
      continue;
    }

    const data = raw as { entity?: string; facts?: Record<string, RawFact> };
    if (!data?.facts || typeof data.facts !== 'object') continue;

    for (const [factId, fact] of Object.entries(data.facts)) {
      if (!fact || !fact.asOf) continue;
      const measure = fact.measure ?? '';

      // Skip historical event measures (won't ever change)
      if (NEVER_STALE_MEASURES.has(measure)) continue;

      // Skip facts with no measure or an unrecognized measure.
      // Facts without a defined measure are typically historical records
      // (one-time events, archived snapshots) that don't represent
      // an ongoing current-state metric that can go stale.
      if (!measure || !(measure in MEASURE_THRESHOLDS)) continue;

      const asOfDate = parseAsOf(String(fact.asOf));
      if (!asOfDate) continue;

      const key = `${entity}::${measure}`;
      const existing = latestByMeasure.get(key);

      if (!existing || asOfDate > existing.asOfDate) {
        latestByMeasure.set(key, { factId, fact, asOfDate });
      }
    }
  }

  // Now check each most-recent fact for staleness
  const stale: StaleFact[] = [];

  for (const [key, { factId, fact, asOfDate }] of latestByMeasure) {
    const entity = key.split('::')[0];
    const measure = fact.measure ?? '';
    const ageMonths = monthsBetween(asOfDate, today);
    const threshold = thresholdFor(measure);

    if (ageMonths >= threshold) {
      stale.push({
        entity,
        factId,
        label: fact.label ?? factId,
        measure,
        asOf: String(fact.asOf),
        ageMonths,
        thresholdMonths: threshold,
        value: fact.value,
        source: fact.source,
      });
    }
  }

  // Sort by staleness (most stale first)
  return stale.sort((a, b) => b.ageMonths - a.ageMonths);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface StaleFactOptions {
  ci?: boolean;
  json?: boolean;
  top?: number;
  entity?: string;
  months?: number;
}

export function runCheck(options: StaleFactOptions = {}): ValidatorResult {
  const jsonMode = options.json || options.ci;
  const colors = getColors(jsonMode);

  let facts = loadAllFacts();

  // Apply option overrides
  if (options.entity) {
    facts = facts.filter(f => f.entity === options.entity);
  }
  if (options.months !== undefined) {
    // Re-filter with custom threshold
    facts = facts.filter(f => f.ageMonths >= options.months!);
  }
  if (options.top) {
    facts = facts.slice(0, options.top);
  }

  // Bucket by severity
  const high = facts.filter(f => f.ageMonths >= f.thresholdMonths * 2);
  const medium = facts.filter(f => f.ageMonths >= f.thresholdMonths && f.ageMonths < f.thresholdMonths * 2);

  if (jsonMode) {
    console.log(JSON.stringify({
      total: facts.length,
      high: high.length,
      medium: medium.length,
      facts: facts.map(f => ({
        entity: f.entity,
        factId: f.factId,
        label: f.label,
        measure: f.measure,
        asOf: f.asOf,
        ageMonths: f.ageMonths,
        thresholdMonths: f.thresholdMonths,
      })),
    }, null, 2));
  } else {
    if (facts.length === 0) {
      console.log(`${colors.green}✓ No stale facts found${colors.reset}`);
    } else {
      const threshold = options.months ?? '(tiered)';
      console.log(`${colors.bold}Stale Facts Report (threshold: ${threshold} months)${colors.reset}`);
      console.log('─'.repeat(60));
      console.log();

      if (high.length > 0) {
        console.log(`${colors.yellow}${colors.bold}HIGH PRIORITY (>2× threshold stale) — ${high.length} facts${colors.reset}`);
        for (const f of high) {
          const val = f.value !== undefined ? ` = ${f.value}` : '';
          console.log(
            `  ${colors.yellow}${f.entity}.${f.factId}${colors.reset}` +
            `  ${f.label}${val}` +
            `  ${colors.dim}(asOf ${f.asOf}, ${f.ageMonths} months stale)${colors.reset}`
          );
        }
        console.log();
      }

      if (medium.length > 0) {
        console.log(`${colors.blue}MEDIUM PRIORITY — ${medium.length} facts${colors.reset}`);
        for (const f of medium) {
          const val = f.value !== undefined ? ` = ${f.value}` : '';
          console.log(
            `  ${colors.blue}${f.entity}.${f.factId}${colors.reset}` +
            `  ${f.label}${val}` +
            `  ${colors.dim}(asOf ${f.asOf}, ${f.ageMonths} months, threshold ${f.thresholdMonths}mo)${colors.reset}`
          );
        }
        console.log();
      }

      console.log('─'.repeat(60));
      console.log(`${colors.bold}Summary: ${facts.length} stale facts (${high.length} high, ${medium.length} medium)${colors.reset}`);
      console.log(`  ${colors.dim}Run 'pnpm crux auto-update plan' to queue updates for affected pages.${colors.reset}`);
    }
  }

  return {
    passed: high.length === 0,
    errors: high.length,
    warnings: medium.length,
    infos: 0,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const options: StaleFactOptions = {
    json: args.includes('--json') || args.includes('--ci'),
    top: (() => {
      const m = args.find(a => a.startsWith('--top='));
      return m ? parseInt(m.split('=')[1], 10) : undefined;
    })(),
    entity: (() => {
      const m = args.find(a => a.startsWith('--entity='));
      return m ? m.split('=')[1] : undefined;
    })(),
    months: (() => {
      const m = args.find(a => a.startsWith('--months='));
      return m ? parseInt(m.split('=')[1], 10) : undefined;
    })(),
  };

  const result = runCheck(options);
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
