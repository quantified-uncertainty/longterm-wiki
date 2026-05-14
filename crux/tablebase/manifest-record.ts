/**
 * Build the per-record summary written to `data/tablebase-manifests/*.json`.
 *
 * Spreads every non-null field of the submitted record so reviewers can see
 * temporal/lead/status fields directly, truncates a few bloat-prone freetext
 * columns, and hoists `sourcing.{verdict,evidence,confidence}` to the top
 * level. See QUA-672 for context.
 */

import { truncate as truncateText } from '../lib/text-utils.ts';

const TRUNCATE_FIELDS = new Set(['notes', 'background', 'description']);
const TRUNCATE_AT = 300;

function truncate(s: string): string {
  return truncateText(s, TRUNCATE_AT, { showCount: true });
}

function truncateIfString(value: unknown): unknown {
  return typeof value === 'string' ? truncate(value) : value;
}

export function summarizeRecordForManifest(
  r: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(r)) {
    if (key === 'sourcing' || key === 'claimIds') continue;
    if (value === null || value === undefined) continue;
    summary[key] = TRUNCATE_FIELDS.has(key) ? truncateIfString(value) : value;
  }

  const sourcing = r.sourcing;
  if (sourcing && typeof sourcing === 'object') {
    const s = sourcing as Record<string, unknown>;
    summary.verdict = s.verdict;
    if (typeof s.evidence === 'string') summary.evidence = truncate(s.evidence);
    if (typeof s.confidence === 'number') summary.confidence = s.confidence;
  } else {
    // Backward-compat: existing manifests use 'none' for absent sourcing;
    // PR reviewers rely on this sentinel for the audit trail.
    summary.verdict = 'none';
  }

  return summary;
}
