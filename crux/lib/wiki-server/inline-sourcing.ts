/**
 * Inline sourcing attach helper — fetches `source_check_verdicts` rows for a
 * given record type and returns a map of recordId → InlineSourcing payload
 * suitable for attaching to TableBase `/sync` request items.
 *
 * Usage (in crux importers):
 *   const byRecordId = await fetchInlineSourcing('division');
 *   for (const item of items) {
 *     const s = byRecordId.get(item.id);
 *     if (s) item.sourcing = s;
 *   }
 *
 * Why this exists: server tables listed in `SOURCE_CHECK_REQUIRED`
 * (see apps/wiki-server/src/routes/shared/sourcing-enforcement.ts) reject
 * sync payloads whose items do not carry an inline `sourcing` field. The
 * canonical verdict rows already live in PG after
 * `pnpm crux tb verify-orchestrate <table>`, so importers can read them
 * back at sync time instead of requiring every record author to curate
 * verdicts by hand. See QUA-677.
 */

import { listVerdicts } from "./sourcing-client.ts";

/** Must match apps/wiki-server/src/routes/tablebase/sourcing-schema.ts */
export interface InlineSourcing {
  verdict: "confirmed" | "contradicted" | "outdated" | "partial" | "unverifiable";
  evidence?: string;
  confidence?: number;
  sourceContentHash?: string;
  checkedAt?: string;
  checkedBy?: string;
}

/**
 * Verdict values accepted by InlineSourcingSchema. Kept as a typed Set so the
 * `has` check narrows the verdict string to the enum without a type assertion.
 */
const ATTACHABLE_VERDICTS = new Set<InlineSourcing["verdict"]>([
  "confirmed",
  "contradicted",
  "outdated",
  "partial",
  "unverifiable",
]);

/**
 * Must not exceed the server's MAX_PAGE_SIZE for the verdicts endpoint (200),
 * defined in apps/wiki-server/src/routes/sourcing/sourcing.ts.
 */
const PAGE_SIZE = 200;

/**
 * Server-side InlineSourcingSchema caps `evidence` at 5000 chars. Mirror it
 * here so we don't ship a payload the server rejects, and so truncation is
 * visible to readers of the helper rather than happening by silent overflow.
 */
const EVIDENCE_MAX_LENGTH = 5000;
const TRUNCATION_SUFFIX = "… [truncated]";

/**
 * Fetch whole-row verdicts (`fieldName === null`) for a given record_type and
 * return a map of recordId → InlineSourcing. Paginates through the verdicts
 * endpoint so tables with >200 verdicts are covered.
 *
 * Rows with `verdict='unchecked'` are skipped — InlineSourcingSchema rejects
 * that value, and attaching it would trip the server's enforcement check
 * anyway. Per-field verdicts (`fieldName !== null`) are also skipped because
 * inline sourcing on sync payloads is whole-row.
 */
export async function fetchInlineSourcing(
  recordType: string,
): Promise<Map<string, InlineSourcing>> {
  const map = new Map<string, InlineSourcing>();
  let offset = 0;

  while (true) {
    const res = await listVerdicts({
      recordType,
      limit: PAGE_SIZE,
      offset,
    });
    if (!res.ok) {
      const detail = res.message || res.error || "unknown error";
      throw new Error(
        `Failed to fetch ${recordType} verdicts (offset=${offset}): ${detail}`,
      );
    }

    for (const v of res.data.verdicts) {
      if (v.fieldName != null) continue;
      if (!isAttachableVerdict(v.verdict)) continue;

      const sourcing: InlineSourcing = { verdict: v.verdict };
      if (v.confidence != null) sourcing.confidence = v.confidence;
      if (v.lastComputedAt) sourcing.checkedAt = v.lastComputedAt;
      if (v.reasoning) sourcing.evidence = truncateEvidence(v.reasoning);

      map.set(v.recordId, sourcing);
    }

    if (res.data.verdicts.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return map;
}

function isAttachableVerdict(v: string): v is InlineSourcing["verdict"] {
  return (ATTACHABLE_VERDICTS as Set<string>).has(v);
}

/**
 * Truncate evidence to the server's 5000-char cap, appending a visible marker
 * when truncation occurs so it's not silent. The marker eats into the budget
 * so the final string is still under the limit.
 */
function truncateEvidence(s: string): string {
  if (s.length <= EVIDENCE_MAX_LENGTH) return s;
  const head = s.slice(0, EVIDENCE_MAX_LENGTH - TRUNCATION_SUFFIX.length);
  return head + TRUNCATION_SUFFIX;
}
