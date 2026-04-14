/**
 * @longterm-wiki/sourcing-types — Canonical sourcing record-type and verdict
 * definitions shared by wiki-server, apps/web, and crux.
 *
 * This package exists so the frontend and backend cannot drift on the set of
 * record types the sourcing pipeline supports. Before it, VALID_RECORD_TYPES
 * lived in `apps/wiki-server/src/api-types.ts` and the frontend imported it
 * via a backend-to-frontend path alias — a dependency direction that broke
 * the "apps don't depend on each other" invariant. Now both apps depend on
 * this package (QUA-424, QUA-408 Phase 4 category S).
 *
 * Scope is deliberately narrow: constants, types, and pure helpers. Zod
 * schemas stay in `apps/wiki-server/src/api-types.ts` next to the request
 * validators that use them.
 */

// ── Record types ──────────────────────────────────────────────────────────

/**
 * The canonical list of record types supported by the sourcing pipeline.
 * Adding a new type here requires matching server-side storage + read-path
 * rendering; removing a type requires cleaning up `source_check_verdicts`.
 *
 * Kept as a readonly tuple so `RecordType` is a string-literal union.
 */
export const VALID_RECORD_TYPES = [
  "grant",
  "personnel",
  "division",
  "funding-program",
  "funding-round",
  "investment",
  "equity-position",
  "policy-stakeholder",
  "publication",
  "benchmark-result",
  "entity-event",
  "entity-assessment",
  "secondary-market-price",
  "citation",
  "wiki-page",
  "fact",
] as const;

export type RecordType = (typeof VALID_RECORD_TYPES)[number];

/**
 * Record types that are exempt from sourcing verification.
 *
 * These are data classes where the ingestion source IS the canonical reference,
 * so running sourcing verification against them produces noise rather than signal.
 * They are excluded from coverage metrics, recheck queues, and the sourcing
 * pipeline. The exemption is explicit — without this list, nothing prevents
 * someone from accidentally running sourcing on these types and polluting
 * the verdicts table.
 *
 * Criteria for exemption:
 *   1. Data is ingested directly from an authoritative API (Manifold, arXiv, etc.)
 *   2. The source URL in the record IS the canonical reference — re-checking it
 *      against external sources is circular
 *   3. Data is computed/derived from other already-verified records
 *
 * When adding a new exempt type, document the reason inline.
 */
export const SOURCING_EXEMPT_TYPES = [
  // Ingested directly from benchmark provider APIs (e.g., provider docs, eval harnesses).
  // The benchmark scores ARE the canonical data — no external source to verify against.
  "benchmark-result",

  // Computed by the citation accuracy system, not manually entered data.
  // Citation accuracy has its own separate verification pipeline.
  "citation",

  // LLM-generated or editorial assessments (importance, risk, etc.).
  // These are opinions/judgments, not factual claims that can be sourcing-checked.
  "entity-assessment",

  // Time-series pricing data ingested from secondary market APIs.
  // The API response IS the canonical price — re-checking it is circular.
  "secondary-market-price",
] as const;

export type SourcingExemptType = (typeof SOURCING_EXEMPT_TYPES)[number];

// ── Verdicts ──────────────────────────────────────────────────────────────

/**
 * Valid source-check verdict states written by the LLM sourcing pipeline.
 * Does not include `unchecked`, which is a placeholder the pipeline writes
 * before running a check — not a verdict produced by it.
 */
export const VALID_SOURCE_CHECK_VERDICTS = [
  "confirmed",
  "contradicted",
  "unverifiable",
  "outdated",
  "partial",
] as const;

export type SourcingVerdict = (typeof VALID_SOURCE_CHECK_VERDICTS)[number];

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Check whether a record type is exempt from sourcing verification.
 * Use this instead of manual array checks to ensure consistency.
 *
 * Accepts `string` (not `RecordType`) because callers often hold
 * user-supplied or stored strings. Returns false for unknown types.
 */
export function isSourcingExempt(recordType: string): boolean {
  return (SOURCING_EXEMPT_TYPES as readonly string[]).includes(recordType);
}

/**
 * Check whether a record type is in the canonical sourcing list.
 * Useful for guarding FE helpers (getSourcingHref, getRecordVerdict) at the
 * boundary — an unregistered type passed in should quietly degrade rather
 * than linking to a 404.
 */
export function isValidRecordType(recordType: string): recordType is RecordType {
  return (VALID_RECORD_TYPES as readonly string[]).includes(recordType);
}

/**
 * Check whether a record type is both a valid sourcing type AND not exempt —
 * i.e., would have stored verdicts worth linking to. Equivalent to:
 *
 *   isValidRecordType(t) && !isSourcingExempt(t)
 *
 * Used by `getSourcingHref` to decide whether to return a real URL or
 * `undefined` (which makes the receiving dot non-clickable).
 */
export function isLinkableSourcingType(
  recordType: string,
): recordType is Exclude<RecordType, SourcingExemptType> {
  return isValidRecordType(recordType) && !isSourcingExempt(recordType);
}
