import { cn } from "@/lib/utils";

// ── Verdict styling ─────────────────────────────────────────────────────

export const VERDICT_STYLES: Record<string, { bg: string; text: string }> = {
  confirmed: { bg: "bg-emerald-500/15", text: "text-emerald-600" },
  contradicted: { bg: "bg-red-500/15", text: "text-red-600" },
  outdated: { bg: "bg-amber-500/15", text: "text-amber-600" },
  partial: { bg: "bg-amber-400/15", text: "text-amber-500" },
  unverifiable: { bg: "bg-gray-500/15", text: "text-gray-500" },
  unchecked: { bg: "bg-gray-400/15", text: "text-gray-400" },
};

/** Tooltip descriptions for verdict types. */
export const VERDICT_DESCRIPTIONS: Record<string, string> = {
  confirmed: "Source evidence supports this claim.",
  contradicted: "Source evidence contradicts this claim.",
  outdated: "Source evidence suggests this information is no longer current.",
  partial: "Source evidence partially supports this claim, but some details differ.",
  unverifiable: "Unable to verify this claim from available sources.",
  unchecked: "This claim has not yet been checked against sources.",
};

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
export const VERDICT_PRIORITY: Record<string, number> = {
  contradicted: 0,
  outdated: 1,
  partial: 2,
  unverifiable: 3,
  confirmed: 4,
  unchecked: 5,
};

/** Format a record type for display (capitalize). */
export function formatRecordType(type: string): string {
  return type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Get the URL for the source record's detail page.
 * Returns null if no detail page exists for this record type.
 */
export function getRecordHref(recordType: string, recordId: string): string | null {
  switch (recordType) {
    case "fact":
      return `/factbase/fact/${recordId}`;
    case "wiki-page":
      return `/wiki/${recordId}`;
    case "grant":
      return `/grants/${recordId}`;
    case "publication":
      return `/publications/${recordId}`;
    case "investment":
      return `/investments/${recordId}`;
    case "funding-round":
      return `/funding-rounds/${recordId}`;
    case "division":
      return `/divisions/${recordId}`;
    case "personnel":
      return `/people`;
    default:
      return null;
  }
}

/** Get the URL for the source-check detail page. */
export function getSourceCheckHref(recordType: string, recordId: string): string {
  return `/source-checks/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`;
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
