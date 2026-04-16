/** Shared pure utilities for the data-source detail page. */

/** Relative-time label like "5d ago", "2mo ago". Returns "—" for invalid/future timestamps. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const days = Math.round(ms / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

/** Short-hash display (first 10 chars). Returns "—" for missing/empty hashes. */
export function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  return h.length > 10 ? h.slice(0, 10) : h;
}

/** Safe ISO-date slice (YYYY-MM-DD). Returns "—" for invalid/missing. */
export function safeIsoDate(v: string | null | undefined): string {
  if (!v) return "—";
  const t = new Date(v).getTime();
  if (isNaN(t)) return "—";
  return new Date(t).toISOString().slice(0, 10);
}

/** Safe "YYYY-MM-DD HH:MM:SS" UTC format. Returns "—" for invalid/missing. */
export function safeIsoDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  const t = new Date(v).getTime();
  if (isNaN(t)) return "—";
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

/** Returns true only for http(s) URLs. Blocks javascript:, data:, file:, etc. */
export function isSafeHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
