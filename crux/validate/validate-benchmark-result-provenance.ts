#!/usr/bin/env node

/**
 * Validate provenance fields on benchmark_results.
 *
 * QUA-689 — Phase 2 of the AI safety data layer (parent: QUA-687).
 *
 * Phase 2 adds the four provenance columns to benchmark_results:
 *   - tested_by         (CHECK-enforced enum, default 'unknown')
 *   - tested_by_org_id  (FK-style ref, optional)
 *   - evaluation_date   (text)
 *   - methodology_notes (text)
 *
 * The CHECK on tested_by guarantees the *value* is in the allowed set, but
 * does not guarantee the value is *meaningful*. This validator surfaces
 * rows where the value is meaningful-but-incomplete (e.g. tested_by set
 * to a real evaluator but source_url missing) or where the row is still
 * unattributed (tested_by = 'unknown').
 *
 * Reported in two buckets:
 *   - HARD : tested_by != 'unknown' AND source_url IS NULL
 *            (impossible to verify the cited evaluator without a URL)
 *   - SOFT : tested_by = 'unknown'
 *            (legacy rows + Phase 2 ingesters that haven't backfilled yet)
 *
 * **Advisory in the gate** — does not block PRs. Surfaces drift so we can
 * promote to blocking once Phase 2 ingesters have populated provenance for
 * the bulk of rows. The plan-doc target is "after one week clean".
 *
 * Usage: npx tsx crux/validate/validate-benchmark-result-provenance.ts
 *
 * Reads from prod wiki-server (auto-selected when invoked from a slot) via
 * /api/benchmark-results/all. Falls back to a non-fatal warning if the
 * server is unreachable — advisory checks should never wedge CI on infra
 * outages.
 */

import { getAllBenchmarkResults } from "../lib/wiki-server/benchmark-results.ts";
import { getColors } from "../lib/output.ts";

interface Violation {
  id: string;
  benchmarkId: string;
  modelId: string;
  testedBy: string;
  sourceUrl: string | null;
}

interface CheckResult {
  passed: boolean;
  scanned: number;
  hard: Violation[];
  soft: Violation[];
  errors: string[];
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50; // 10,000 rows hard cap

export async function runCheck(): Promise<CheckResult> {
  const result: CheckResult = {
    passed: true,
    scanned: 0,
    hard: [],
    soft: [],
    errors: [],
  };

  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await getAllBenchmarkResults({
      limit: PAGE_SIZE,
      offset,
    });

    if (!r.ok) {
      // Network / auth error. Advisory mode: surface as a single non-fatal
      // entry on the errors list so the gate run prints it but doesn't
      // wedge on transient infra issues.
      result.errors.push(
        `wiki-server fetch failed at offset=${offset}: ${r.error} ${r.message}`.trim(),
      );
      return result;
    }

    const rows = r.data.benchmarkResults;
    if (rows.length === 0) break;

    for (const row of rows) {
      result.scanned += 1;
      // The /all endpoint returns testedBy from formatRow (added in this
      // PR). Older clients used to omit it; defensive fallback to 'unknown'.
      const testedBy =
        (row as { testedBy?: string }).testedBy ?? "unknown";
      if (testedBy === "unknown") {
        result.soft.push({
          id: row.id,
          benchmarkId: row.benchmarkId,
          modelId: row.modelId,
          testedBy,
          sourceUrl: row.sourceUrl,
        });
      } else if (!row.sourceUrl) {
        result.hard.push({
          id: row.id,
          benchmarkId: row.benchmarkId,
          modelId: row.modelId,
          testedBy,
          sourceUrl: row.sourceUrl,
        });
      }
    }

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Advisory-only: never set passed=false. The gate marks this entry as
  // advisory so a soft/hard count > 0 doesn't block the merge. Once Phase
  // 2 ingesters are widely deployed and the soft bucket is empty, flip
  // this to blocking and start counting violations as failures.
  return result;
}

async function main(): Promise<void> {
  const c = getColors(process.env.CI === "true");
  const warn = (s: string) => `${c.yellow}!${c.reset} ${s}`;
  const ok = (s: string) => `${c.green}✓${c.reset} ${s}`;
  const result = await runCheck();

  if (result.errors.length > 0) {
    for (const e of result.errors) {
      console.warn(warn(e));
    }
    console.warn(warn("Advisory-only — wiki-server unreachable, skipping"));
    process.exit(0);
  }

  console.log(`Scanned ${result.scanned} benchmark_results rows`);

  if (result.hard.length > 0) {
    console.warn(
      warn(
        `${result.hard.length} rows have tested_by set but no source_url — verifiability gap`,
      ),
    );
    for (const v of result.hard.slice(0, 20)) {
      console.warn(
        `  - ${v.id}: ${v.benchmarkId} × ${v.modelId} (testedBy=${v.testedBy})`,
      );
    }
    if (result.hard.length > 20) {
      console.warn(`  ... and ${result.hard.length - 20} more`);
    }
  }

  if (result.soft.length > 0) {
    console.warn(
      warn(
        `${result.soft.length} rows have tested_by='unknown' — legacy or unattributed`,
      ),
    );
  }

  if (result.hard.length === 0 && result.soft.length === 0) {
    console.log(ok("All rows have non-unknown tested_by + source_url"));
  } else {
    console.log(
      `${c.yellow}Advisory${c.reset} — does not block PR; track soft count for promotion to blocking`,
    );
  }

  process.exit(0);
}

// Only run main() when invoked as a script, not when imported by tests.
// Strict equality only — a fallback like `endsWith(process.argv[1] ?? "")`
// becomes `endsWith("")` when argv[1] is undefined, which matches ANY URL
// and would call process.exit(0) inside test runners that import this module.
const invokedAsScript =
  typeof process.argv[1] === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  main().catch((err) => {
    console.error("validate-benchmark-result-provenance crashed:", err);
    process.exit(0); // advisory-only — even crashes shouldn't block
  });
}
