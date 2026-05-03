/**
 * Fetch whole-row source_check_verdicts for attaching as inline sourcing on
 * TableBase /sync payloads. See sourcing-enforcement.ts — server tables listed
 * in SOURCE_CHECK_REQUIRED reject sync items without a `sourcing` field.
 */

import type { InlineSourcing } from "../../../apps/wiki-server/src/routes/tablebase/sourcing-schema.ts";
import { listVerdicts } from "./sourcing-client.ts";
import { truncate } from "../text-utils.ts";

export type { InlineSourcing };

const ATTACHABLE_VERDICTS = new Set<InlineSourcing["verdict"]>([
  "confirmed",
  "contradicted",
  "outdated",
  "partial",
  "unverifiable",
]);

/** Matches server MAX_PAGE_SIZE in apps/wiki-server/src/routes/sourcing/sourcing.ts. */
const PAGE_SIZE = 200;

/** Server's InlineSourcingSchema caps `evidence` at 5000 chars. */
const EVIDENCE_MAX_LENGTH = 5000;
const TRUNCATION_SUFFIX = "… [truncated]";

/**
 * Fetch whole-row verdicts for a record_type and return a map of
 * recordId → InlineSourcing. Paginates through all verdicts; skips
 * per-field verdicts (fieldName !== null) and `unchecked` values
 * that InlineSourcingSchema rejects.
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

function truncateEvidence(s: string): string {
  return truncate(s, EVIDENCE_MAX_LENGTH, { ellipsis: TRUNCATION_SUFFIX });
}
