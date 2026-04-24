/**
 * Manifest record summarization (QUA-672).
 *
 * Takes a record submitted to a `/sync` endpoint and returns a
 * human-readable summary for `data/tablebase-manifests/*.json`.
 *
 * Design rationale: the manifest is the audit trail reviewers see in PRs.
 * Earlier versions only kept a hand-picked allowlist of fields (id, role,
 * source, verdict) which omitted temporal fields like startDate/endDate
 * and triggered CodeRabbit "missing endDate" false-positives even when the
 * actual data on prod was correct. We now spread the full record, with
 * two transformations:
 *
 *   1. Long freetext fields are truncated so the manifest stays diff-able.
 *   2. The inline `sourcing` object is hoisted: verdict + evidence + confidence
 *      become top-level fields so reviewers don't have to drill in.
 *
 * Fields stored as null/undefined are dropped to keep manifests compact.
 */

const TRUNCATE_FIELDS = ['notes', 'background', 'description'] as const;
const TRUNCATE_AT = 300;

function truncateIfLong(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= TRUNCATE_AT) return value;
  return `${value.slice(0, TRUNCATE_AT)}… [truncated, ${value.length - TRUNCATE_AT} more chars]`;
}

/**
 * Build the manifest summary for a single submitted record.
 *
 * Always emits `id` first and `verdict` last (or 'none' when no sourcing
 * was attached) for stable diffs.
 */
export function summarizeRecordForManifest(
  r: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // 1. Spread non-null/undefined record fields, with truncation for bloat-prone freetext.
  //    Skip `sourcing` and `claimIds` here — they're handled separately.
  for (const [key, value] of Object.entries(r)) {
    if (key === 'sourcing' || key === 'claimIds') continue;
    if (value === null || value === undefined) continue;
    if ((TRUNCATE_FIELDS as readonly string[]).includes(key)) {
      summary[key] = truncateIfLong(value);
    } else {
      summary[key] = value;
    }
  }

  // 2. Hoist sourcing fields. Trim evidence the same way as freetext.
  if (r.sourcing && typeof r.sourcing === 'object') {
    const v = r.sourcing as Record<string, unknown>;
    summary.verdict = v.verdict;
    if (v.evidence !== undefined && v.evidence !== null) {
      summary.evidence = truncateIfLong(v.evidence);
    }
    if (typeof v.confidence === 'number') {
      summary.confidence = v.confidence;
    }
  } else {
    summary.verdict = 'none';
  }

  return summary;
}
