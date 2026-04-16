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

export function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  return h.length > 10 ? h.slice(0, 10) : h;
}

export function safeIsoDate(v: string | null | undefined): string {
  if (!v) return "—";
  const t = new Date(v).getTime();
  if (isNaN(t)) return "—";
  return new Date(t).toISOString().slice(0, 10);
}

export function safeIsoDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  const t = new Date(v).getTime();
  if (isNaN(t)) return "—";
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}
