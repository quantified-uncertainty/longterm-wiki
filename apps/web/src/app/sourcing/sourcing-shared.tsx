import { cn } from "@/lib/utils";
import {
  SOURCE_CHECK_VERDICT_STYLES,
  SOURCE_CHECK_VERDICT_DESCRIPTIONS,
  SOURCE_CHECK_VERDICT_PRIORITY,
} from "@/components/shared/verdict-styles";
import { isCandidateRecordId } from "@longterm-wiki/sourcing-types";

// ── Verdict styling (from shared module) ────────────────────────────────
// Cast to Record<string, ...> so consumers can index with `string` verdict keys
// without needing to narrow to SourcingVerdictType first.

export const VERDICT_STYLES: Record<string, { bg: string; text: string }> = SOURCE_CHECK_VERDICT_STYLES;
export const VERDICT_DESCRIPTIONS: Record<string, string> = SOURCE_CHECK_VERDICT_DESCRIPTIONS;

export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  const style = VERDICT_STYLES[verdict] || VERDICT_STYLES.unchecked;
  const description = VERDICT_DESCRIPTIONS[verdict];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        style.bg,
        style.text,
        className
      )}
      title={description}
    >
      {verdict}
    </span>
  );
}

// ── Pagination helpers ──────────────────────────────────────────────────

export const PAGE_SIZE = 50;

/** Build a URL search string preserving existing filters and updating page. */
export function buildFilterUrl(
  base: string,
  params: { type?: string; verdict?: string; page?: number; q?: string }
): string {
  const sp = new URLSearchParams();
  if (params.type && params.type !== "all") sp.set("type", params.type);
  if (params.verdict && params.verdict !== "all") sp.set("verdict", params.verdict);
  if (params.q) sp.set("q", params.q);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Sort priority: most actionable verdicts first. Lower = higher priority. */
export const VERDICT_PRIORITY = SOURCE_CHECK_VERDICT_PRIORITY;

/** Format a record type for display (capitalize). */
export function formatRecordType(type: string): string {
  return type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Get the URL for the source record's detail page.
 * Returns null if no detail page exists for this record type,
 * or if the recordId format doesn't match what the target page expects.
 *
 * NOTE: Source-check recordIds are PG primary keys (10-char alphanumeric).
 * Some pages expect slugs or FactBase keys instead — those return null
 * to avoid broken links.
 */
export function getRecordHref(recordType: string, recordId: string): string | null {
  switch (recordType) {
    case "fact":
      return `/factbase/fact/${recordId}`;
    case "wiki-page":
      return `/wiki/${recordId}`;
    // publication: /publications/:id expects a different ID format — fall through to /things
    // case "publication":
    case "investment":
      return `/investments/${recordId}`;
    case "funding-round":
      return `/funding-rounds/${recordId}`;
    case "personnel":
      return `/things/${recordId}`;
    // grant: /grants/:id expects FactBase key, not PG ID — fall through to /things
    // division: /divisions/:slug expects slug, not PG ID — fall through to /things
    default:
      return `/things/${recordId}`;
  }
}

/** The sourcing index — used as a safe fallback when an ID would otherwise
 *  build a 404 URL. See getStoredVerdictHref for why. */
const SOURCING_INDEX_HREF = "/sourcing";

/** Build the `/sourcing/:recordType/:recordId` path without any guards.
 *  Callers are responsible for having already verified the IDs. */
function buildSourcingPath(recordType: string, recordId: string): string {
  return `/sourcing/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`;
}

/**
 * Get the URL for the sourcing detail page.
 *
 * QUA-423 phase 2: runtime guard against malformed record IDs. If `recordId`
 * looks like a composite React key (e.g. `sid_ULjDXpSLCI-8NUnVSueLS` — the
 * QUA-417 bug shape), returns `undefined` instead of building a 404 URL.
 * Dot components already skip the `<a>` wrapper when `href` is undefined, so
 * a malformed ID silently renders as a non-clickable dot rather than a
 * broken link.
 *
 * The runtime check is the pragmatic half of the QUA-423 plan: it catches
 * the real bug class without churning the ~70 existing call sites to wrap
 * raw strings with `asRecordId()`. Compile-time narrowing via `RecordId<T>`
 * is an optional follow-up once call sites stabilize.
 */
export function getSourcingHref(
  recordType: string,
  recordId: string,
): string | undefined {
  if (!isCandidateRecordId(recordId)) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        `[sourcing] getSourcingHref(${JSON.stringify(recordType)}, ${JSON.stringify(recordId)}): ` +
          `recordId failed isCandidateRecordId guard (likely a composite React key — see QUA-417). ` +
          `Returning undefined; the receiving dot will render non-clickable.`,
      );
    }
    return undefined;
  }
  return buildSourcingPath(recordType, recordId);
}

/**
 * Variant of getSourcingHref for callers rendering rows that already came
 * from the sourcing verdict store (e.g. /api/sourcing/verdicts). Every row
 * there has a valid recordType + recordId by construction, so the href is
 * always definable.
 *
 * Defense in depth: if the value somehow fails the guard (orphan row,
 * mis-typed fixture), falls back to the sourcing index with a dev-mode
 * warning — strictly better than rendering a 404 URL. Return type is
 * `string` (not `string | undefined`) so Next.js `<Link>` accepts it
 * without caller-side fallbacks.
 */
export function getStoredVerdictHref(
  recordType: string,
  recordId: string,
): string {
  const href = getSourcingHref(recordType, recordId);
  if (href) return href;
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      `[sourcing] getStoredVerdictHref: no href for stored verdict ` +
        `${recordType}:${recordId} — falling back to ${SOURCING_INDEX_HREF}. ` +
        `This suggests an orphaned record_type in source_check_verdicts.`,
    );
  }
  return SOURCING_INDEX_HREF;
}

/**
 * Convert a raw DB field key to a human-readable label.
 * Examples: "granteeDisplayName" → "Grantee Display Name",
 *           "isFounder" → "Is Founder", "amount" → "Amount"
 */
export function humanizeFieldLabel(key: string): string {
  // Strip suffix noise
  let s = key.replace(/(EntityId|DisplayName|Id)$/, "");
  // If stripping left nothing (e.g. key was just "Id"), fall back to original
  if (!s) s = key;
  // Split camelCase: "isFounder" → "is Founder"
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Capitalize first character
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format a checker model ID for display (e.g. "claude-haiku-4-5-20251001" → "Haiku 4.5"). */
export function formatCheckerModel(model: string): string {
  if (model.includes("haiku-4-5") || model.includes("haiku-4.5")) return "Haiku 4.5";
  if (model.includes("haiku-3") || model === "claude-3-haiku") return "Haiku 3";
  if (model.includes("sonnet-4")) return "Sonnet 4";
  if (model.includes("sonnet-3.5") || model.includes("sonnet-3-5")) return "Sonnet 3.5";
  if (model.includes("opus-4")) return "Opus 4";
  // Fallback: strip "claude-" prefix and date suffix
  return model.replace(/^claude-/, "").replace(/-\d{8,}$/, "");
}
