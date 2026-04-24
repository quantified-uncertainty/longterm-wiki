/**
 * Per-org acceptance reopener (QUA-643).
 *
 * After a burst completes, any (entity, record_type) pair whose actual
 * confirmed count falls short of the target needs another pass. Without
 * automation, those gaps quietly stay closed (QUA-543 drift pattern).
 *
 * This module takes a list of below-threshold coverage rows and opens a
 * Linear ticket per (entity, record_type), parented to the coverage project
 * so the next burst coordinator picks them up.
 *
 * Idempotency: before filing, we search Linear for an open issue with the
 * canonical title shape. If one exists, we skip. The caller can rerun the
 * report any time without accumulating duplicates.
 */

import type { CoverageGap } from './coverage-types.ts';
import { searchIssues, createIssue } from '../linear/issues.ts';
import { getProject } from '../linear/projects.ts';

export interface ReopenerOptions {
  /** Linear project name or UUID. Defaults to Source-Check & Verification. */
  project?: string;
}

export interface ReopenerResult {
  created: number;
  skipped: number;
  errors: Array<{ entityId: string; recordType: string; message: string }>;
}

/**
 * Build the canonical ticket title. Uniqueness of this string across open
 * tickets is what lets us dedupe re-runs without a DB ledger.
 */
export function buildReopenerTitle(
  entityId: string,
  recordType: string,
): string {
  return `Coverage gap: ${entityId} — ${recordType}`;
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
    `3. If gaps persist, add (org × record_type) to the next T3 subscription queue.`,
    '',
    `Filed automatically by QUA-643 Phase 4 acceptance reopener. Close if the`,
    `denominator estimate is wrong — update \`docs/audits/qua-634-denominator-estimates.md\``,
    `and re-sync with \`crux enrichment sync-targets\`.`,
  ].join('\n');
}

/** Exposed for testing. */
export async function isTicketAlreadyOpen(
  title: string,
): Promise<boolean> {
  // Linear's free-text search is token-based. We fetch a small page and
  // filter for an exact title match with a non-closed state. An identical
  // closed ticket does NOT count — closing means "we decided not to pursue"
  // and the coordinator may want to re-open it the next burst.
  const results = await searchIssues(title, 10);
  return results.some(
    (r) => r.title === title && r.state.type !== 'completed' && r.state.type !== 'canceled',
  );
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

  for (const gap of gaps) {
    const title = buildReopenerTitle(gap.entityId, gap.recordType);
    try {
      if (await isTicketAlreadyOpen(title)) {
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
