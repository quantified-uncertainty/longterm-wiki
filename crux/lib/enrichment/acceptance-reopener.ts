/**
 * Per-org acceptance reopener. Files one Linear ticket per coverage gap,
 * deduped by exact title so re-runs don't accumulate duplicates.
 */

import type { CoverageRow } from '../wiki-server/enrichment.ts';
import { searchIssues, createIssue } from '../linear/issues.ts';
import { getProject } from '../linear/projects.ts';

/** Re-exported so callers don't have to reach into the wiki-server client. */
export type CoverageGap = CoverageRow;

export interface ReopenerOptions {
  /** Linear project name or UUID. Defaults to Source-Check & Verification. */
  project?: string;
}

export interface ReopenerResult {
  created: number;
  skipped: number;
  errors: Array<{ entityId: string; recordType: string; message: string }>;
}

// ASCII " - " (not em-dash) because Linear's search tokenizer splits on
// Unicode punctuation inconsistently, which breaks the dedup lookup.
export function buildReopenerTitle(
  entityId: string,
  recordType: string,
): string {
  return `Coverage gap: ${entityId} - ${recordType}`;
}

function buildReopenerBody(row: CoverageGap): string {
  const pct = (row.gapPct * 100).toFixed(0);
  return [
    `## Acceptance gap detected by \`crux enrichment acceptance-report\``,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| Entity | \`${row.entityId}\` |`,
    `| Record type | \`${row.recordType}\` |`,
    `| Estimated total | ${row.estimatedTotal} |`,
    `| Target (\`${(row.targetPct * 100).toFixed(0)}%\`) | ${row.targetAcceptedCount} |`,
    `| Actual confirmed | ${row.actualAcceptedCount} |`,
    `| **Gap** | **${row.gapCount} (${pct}%)** |`,
    '',
    `### Suggested remediation`,
    '',
    `1. Re-run T1 importers for the org (SEC EDGAR, OpenAlex, Wikidata, etc.) to catch authoritative rows that were missed in prior bursts.`,
    `2. Run T2 website extraction against the org's team / about / research pages.`,
    `3. If gaps persist, add (org x record_type) to the next T3 subscription queue.`,
    '',
    `Filed automatically by the acceptance reopener. Close if the denominator`,
    `estimate is wrong: update \`docs/audits/qua-634-denominator-estimates.md\``,
    `and re-sync with \`crux enrichment sync-targets\`.`,
  ].join('\n');
}

/** Pre-fetch every open reopener ticket once so the per-gap dedup is local. */
export async function fetchOpenReopenerTitles(): Promise<Set<string>> {
  const MAX_RESULTS = 100;
  const results = await searchIssues('Coverage gap:', MAX_RESULTS);
  // Linear's search is fuzzy, so post-filter by exact prefix before indexing.
  const open = new Set<string>();
  for (const r of results) {
    if (r.state.type === 'completed' || r.state.type === 'canceled') continue;
    if (!r.title.startsWith('Coverage gap:')) continue;
    open.add(r.title);
  }
  // Linear's searchIssues doesn't expose a cursor; if we hit the cap, dedup
  // may miss older tickets and the reopener could file duplicates. Warn so
  // an operator notices and we can migrate to a paginated fetch.
  if (results.length >= MAX_RESULTS) {
    console.warn(
      `[acceptance-reopener] Open-ticket prefetch hit the ${MAX_RESULTS}-result cap; dedup may miss older tickets. Migrate fetchOpenReopenerTitles to a paginated Linear query.`,
    );
  }
  return open;
}

export async function fileAcceptanceIssues(
  gaps: CoverageGap[],
  options: ReopenerOptions = {},
): Promise<ReopenerResult> {
  const result: ReopenerResult = { created: 0, skipped: 0, errors: [] };
  if (gaps.length === 0) return result;

  const projectName = options.project ?? 'Source-Check & Verification';
  const project = await getProject(projectName);
  if (!project) {
    throw new Error(
      `Linear project not found: "${projectName}". Valid names come from 'crux linear projects list'.`,
    );
  }

  // One Linear round-trip, shared across every gap this run.
  const openTitles = await fetchOpenReopenerTitles();

  for (const gap of gaps) {
    const title = buildReopenerTitle(gap.entityId, gap.recordType);
    try {
      if (openTitles.has(title)) {
        result.skipped += 1;
        continue;
      }
      await createIssue({
        title,
        description: buildReopenerBody(gap),
        projectId: project.id,
        // Priority 3 (normal) — gaps are actionable but not urgent. Callers
        // who want to bump specific ones can do so in Linear.
        priority: 3,
      });
      // Prevent duplicate within the same run (e.g. if `gaps` has dupes).
      openTitles.add(title);
      result.created += 1;
    } catch (e: unknown) {
      result.errors.push({
        entityId: gap.entityId,
        recordType: gap.recordType,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}
