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

/** Verdicts that aren't accepted by InlineSourcingSchema (skipped when attaching). */
const ATTACHABLE_VERDICTS = new Set([
  "confirmed",
  "contradicted",
  "outdated",
  "partial",
  "unverifiable",
]);

/** Must not exceed the server's MAX_PAGE_SIZE for the verdicts endpoint. */
const PAGE_SIZE = 200;

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
      throw new Error(
        `Failed to fetch ${recordType} verdicts (offset=${offset}): ${res.message}`,
      );
    }

    for (const v of res.data.verdicts) {
      if (v.fieldName != null) continue;
      if (!ATTACHABLE_VERDICTS.has(v.verdict)) continue;

      const sourcing: InlineSourcing = {
        verdict: v.verdict as InlineSourcing["verdict"],
      };
      if (v.confidence != null) sourcing.confidence = v.confidence;
      if (v.lastComputedAt) sourcing.checkedAt = v.lastComputedAt;
      if (v.reasoning) sourcing.evidence = v.reasoning.slice(0, 5000);

      map.set(v.recordId, sourcing);
    }

    if (res.data.verdicts.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return map;
}
