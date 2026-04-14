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

// ── Branded record IDs (QUA-423) ──────────────────────────────────────────
//
// A `RecordId<T>` is a string tagged with a record-type-literal at the type
// level. Tagging is done via an intersection with a phantom object type that
// carries two read-only brands: a common "RecordId" marker (so any RecordId
// carries the brand) and a type-specific `__type: T` (so `RecordId<"grant">`
// is not assignable to `RecordId<"personnel">` or vice versa).
//
// Why brands, not just `type RecordId<T> = string`? If the alias were a raw
// string, passing any string — a composite React key, a slug, an unrelated
// id — would type-check fine. That's exactly how QUA-417's composite-key
// bug shipped: `conn.key` (owner + "-" + record_key) was a plain string
// happily accepted by `getRecordVerdict(recordType: string, recordId: string)`.
//
// With brands, the only way to get a `RecordId<T>` is through `asRecordId()`,
// which has a runtime check for obviously-composite shapes (e.g. a value
// that contains a hyphen AND has a `sid_` prefix on BOTH sides) and would
// have thrown at dev time for the funding-connections bug.

/**
 * Opaque, type-tagged record ID. Construct only via `asRecordId()`.
 *
 * Two records of different types are not assignable to each other at the type
 * level: `RecordId<"grant">` is distinct from `RecordId<"personnel">`. This
 * is load-bearing for `getSourcingHref(type, id)` — callers can't accidentally
 * pass a grant ID where a personnel ID was expected.
 */
export type RecordId<T extends RecordType = RecordType> = string & {
  readonly __brand: "RecordId";
  readonly __type: T;
};

/**
 * Thrown by `asRecordId()` when the input clearly isn't a raw record PK.
 * Exported so callers can handle it distinctly from generic runtime errors
 * (e.g. log + fall back to `null` in non-strict contexts).
 */
export class InvalidRecordIdError extends Error {
  constructor(
    public readonly recordType: string,
    public readonly rawId: string,
    reason: string,
  ) {
    super(
      `asRecordId(${JSON.stringify(recordType)}, ${JSON.stringify(rawId)}): ${reason}`,
    );
    this.name = "InvalidRecordIdError";
  }
}

/**
 * Heuristic: does this look like a composite React key rather than a raw PK?
 *
 * The QUA-417 bug was `conn.key = \`${ownerEntityId}-${record.key}\``. The
 * ownerEntityId was a `sid_`-prefixed stableId (entity PK) and record.key
 * was a 10-char alphanumeric grant PK — e.g. `sid_ULjDXpSLCI-8NUnVSueLS`.
 *
 * Shapes caught:
 *   - `sid_X-<alphanumRight>`   → stableId + anything alphanumeric (the QUA-417 shape)
 *   - `<numericLeft>-<numericRight>` with substantial digit runs on both sides
 *
 * Does NOT flag legitimate hyphenated IDs (e.g. `some-name-2024`, `arxiv-2310-12345`)
 * because legit slugs don't start with `sid_` and don't have pure multi-digit
 * runs on both sides of a hyphen.
 *
 * Intentionally narrow — false negatives are fine (a real PK won't match
 * the stable form); false positives on real PKs would break legitimate callers.
 */
function looksLikeCompositeKey(rawId: string): boolean {
  // Starts with `sid_...` followed by `-` and more content on the right:
  // this is the QUA-417 shape (`sid_<owner>-<grantPK>`), or two stableIds
  // joined (`sid_X-sid_Y`). Anything with sid_ immediately followed by `-`
  // is a composite: stableIds themselves don't contain hyphens.
  if (/^sid_[A-Za-z0-9]+-[A-Za-z0-9]+/.test(rawId)) return true;
  // Two multi-digit numeric IDs joined: `12345-67890` but NOT `1-2` or `a-b`
  // (those could be legitimate slugs).
  if (/^\d{3,}-\d{3,}$/.test(rawId)) return true;
  return false;
}

/**
 * Construct a `RecordId<T>` from a raw string.
 *
 * Runtime guards catch obvious mistakes at dev/test time:
 *   - Empty strings (caller passed undefined/null by mistake)
 *   - Excessive length (caller passed a display name or URL)
 *   - Composite-key shapes (React `key=` values, `${a}-${b}` concatenations)
 *
 * Throws `InvalidRecordIdError` on rejection. Callers that need a non-throwing
 * variant can guard with `isCandidateRecordId()` below.
 *
 * NOTE: This does NOT validate `recordType` — use `isValidRecordType()` for
 * that. Narrowing type param `T extends RecordType` is a compile-time guard;
 * at runtime a caller could still pass an unregistered string. The function
 * focuses exclusively on ID-shape validation.
 */
export function asRecordId<T extends RecordType>(
  recordType: T,
  rawId: string,
): RecordId<T> {
  if (typeof rawId !== "string") {
    throw new InvalidRecordIdError(
      recordType,
      String(rawId),
      `rawId must be string, got ${typeof rawId}`,
    );
  }
  if (rawId.length === 0) {
    throw new InvalidRecordIdError(recordType, rawId, "empty string");
  }
  if (rawId.length > 200) {
    throw new InvalidRecordIdError(
      recordType,
      rawId.slice(0, 50) + "...",
      `length ${rawId.length} exceeds 200 — likely a URL or display name`,
    );
  }
  if (looksLikeCompositeKey(rawId)) {
    throw new InvalidRecordIdError(
      recordType,
      rawId,
      "looks like a composite React key (e.g. `${owner}-${record}`); " +
        "pass the raw PK instead. QUA-417 shipped exactly this bug on " +
        "funding-connections.tsx.",
    );
  }
  return rawId as RecordId<T>;
}

/**
 * Non-throwing check: does this string pass the `asRecordId` runtime guards?
 *
 * Useful at system boundaries (e.g. URL params, API responses) where you
 * want to reject malformed inputs and render a 404 instead of crashing.
 */
export function isCandidateRecordId(rawId: unknown): rawId is string {
  return (
    typeof rawId === "string" &&
    rawId.length > 0 &&
    rawId.length <= 200 &&
    !looksLikeCompositeKey(rawId)
  );
}
