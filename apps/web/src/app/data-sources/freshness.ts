/**
 * Freshness computation for data sources.
 * Pure utility — no server-side imports, safe to test directly.
 */

export type Freshness = "fresh" | "due" | "overdue" | "static" | "unknown";

const FREQ_DAYS: Record<string, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  annual: 365,
};

/**
 * Compute the freshness status of a data source based on its last snapshot
 * timestamp and expected update frequency.
 */
export function computeFreshness(
  lastSnapshotAt: string | null,
  updateFrequency: string | null,
): Freshness {
  if (updateFrequency === "static") return "static";
  if (!lastSnapshotAt || !updateFrequency) return "unknown";
  const expected = FREQ_DAYS[updateFrequency];
  if (!expected) return "unknown";
  const daysSince = Math.round(
    (Date.now() - new Date(lastSnapshotAt).getTime()) / 86400000,
  );
  if (daysSince < expected * 0.8) return "fresh";
  if (daysSince < expected * 1.2) return "due";
  return "overdue";
}

/** Numeric sort key — surfaces problems first. */
export function freshnessSortKey(f: Freshness): number {
  const order: Record<Freshness, number> = {
    overdue: 0,
    due: 1,
    unknown: 2,
    static: 3,
    fresh: 4,
  };
  return order[f];
}
