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

export function VerdictBadge({ verdict, className }: { verdict: string; className?: string }) {
  const style = VERDICT_STYLES[verdict] || VERDICT_STYLES.unchecked;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        style.bg,
        style.text,
        className
      )}
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

/** Format a record type for display (capitalize). */
export function formatRecordType(type: string): string {
  return type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
