/** Shared constants and helpers for resource rendering components */

/**
 * Normalize a URL for fuzzy matching between resource URLs and citation URLs.
 * - Strips protocol and `www.` prefix
 * - Removes trailing slashes
 * - Preserves query string, drops hash fragment
 * - Case-insensitive
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return (
      u.host.replace(/^www\./, "") +
      u.pathname.replace(/\/+$/, "") +
      u.search
    ).toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

/** Canonical verdict keys used by the citation verification system */
export const VERDICT_KEYS = [
  "accurate",
  "minor_issues",
  "inaccurate",
  "unsupported",
  "not_verifiable",
] as const;

export type VerdictKey = (typeof VERDICT_KEYS)[number];

/** Severity ordering for sorting (lower = more severe) */
export const VERDICT_SEVERITY: Record<string, number> = {
  inaccurate: 0,
  unsupported: 1,
  minor_issues: 2,
  not_verifiable: 3,
  accurate: 4,
};

/** Compact dot colors used by ReferenceCitationDot */
export const VERDICT_COLORS: Record<string, { bg: string; title: string }> = {
  accurate: { bg: "bg-emerald-500", title: "Verified accurate" },
  minor_issues: { bg: "bg-amber-500", title: "Minor issues" },
  inaccurate: { bg: "bg-red-500", title: "Inaccurate" },
  unsupported: { bg: "bg-red-400", title: "Unsupported" },
  not_verifiable: { bg: "bg-muted-foreground/40", title: "Not verifiable" },
};

/** Rich verdict styles used by ReferenceCitationDetails claim rows */
export const VERDICT_STYLES: Record<
  string,
  { color: string; bg: string; label: string }
> = {
  accurate: { color: "text-emerald-700", bg: "bg-emerald-500/10", label: "Accurate" },
  minor_issues: { color: "text-amber-700", bg: "bg-amber-500/10", label: "Minor issues" },
  inaccurate: { color: "text-red-700", bg: "bg-red-500/10", label: "Inaccurate" },
  unsupported: { color: "text-red-600", bg: "bg-red-500/10", label: "Unsupported" },
  not_verifiable: { color: "text-muted-foreground", bg: "bg-muted", label: "Not verifiable" },
};

/** Maximum claims to display before showing "+N more" */
export const MAX_CLAIMS_SHOWN = 8;

/** Format a list of author names for display in reference entries */
export function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  if (authors.length <= 4)
    return authors.slice(0, -1).join(", ") + " & " + authors[authors.length - 1];
  return `${authors[0]} et al.`;
}

/** Extract the display domain from a URL (strips www.) */
export function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Check if a URL uses a safe protocol (http or https) */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const typeIcons: Record<string, string> = {
  paper: "\ud83d\udcc4",
  book: "\ud83d\udcda",
  blog: "\u270f\ufe0f",
  report: "\ud83d\udccb",
  talk: "\ud83c\udf99\ufe0f",
  podcast: "\ud83c\udfa7",
  government: "\ud83c\udfdb\ufe0f",
  reference: "\ud83d\udcd6",
  web: "\ud83d\udd17",
};

export function getResourceTypeIcon(type: string): string {
  return typeIcons[type] || "\ud83d\udd17";
}
