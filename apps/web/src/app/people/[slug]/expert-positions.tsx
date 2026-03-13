import type { ExpertPosition } from "@/data/database";
import { topicLabel } from "@/data/topic-labels";

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  medium:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

/**
 * Parse a date string in "YYYY", "YYYY-MM", or "YYYY-MM-DD" format
 * into a sortable numeric value (higher = more recent).
 * Returns null if date is missing or unparseable.
 */
function parseDateForSort(date?: string): number | null {
  if (!date) return null;
  // Handle "YYYY", "YYYY-MM", "YYYY-MM-DD"
  const parts = date.split("-").map(Number);
  if (parts.length === 1 && !isNaN(parts[0])) return parts[0] * 10000;
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]))
    return parts[0] * 10000 + parts[1] * 100;
  if (
    parts.length === 3 &&
    !isNaN(parts[0]) &&
    !isNaN(parts[1]) &&
    !isNaN(parts[2])
  )
    return parts[0] * 10000 + parts[1] * 100 + parts[2];
  return null;
}

/** Format a date string for display: "YYYY" stays as-is, "YYYY-MM" becomes "Mon YYYY" */
function formatDate(date: string): string {
  const parts = date.split("-");
  if (parts.length === 1) return date; // "2024" -> "2024"
  if (parts.length >= 2) {
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthIndex = parseInt(parts[1], 10) - 1;
    if (monthIndex >= 0 && monthIndex < 12) {
      return `${monthNames[monthIndex]} ${parts[0]}`;
    }
  }
  return date;
}

/**
 * Sort positions by date (most recent first). Positions without dates
 * are placed at the end.
 */
function sortByDate(positions: ExpertPosition[]): ExpertPosition[] {
  return [...positions].sort((a, b) => {
    const dateA = parseDateForSort(a.date);
    const dateB = parseDateForSort(b.date);
    // Both have dates: sort descending (most recent first)
    if (dateA !== null && dateB !== null) return dateB - dateA;
    // Only one has a date: the dated one comes first
    if (dateA !== null) return -1;
    if (dateB !== null) return 1;
    // Neither has a date: preserve original order
    return 0;
  });
}

export function ExpertPositions({
  positions,
}: {
  positions: ExpertPosition[];
}) {
  if (positions.length === 0) return null;

  const sorted = sortByDate(positions);
  const hasAnyDates = sorted.some((p) => p.date);

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Expert Positions
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {positions.length} topics
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Topic
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  View
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Estimate
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Confidence
                </th>
                {hasAnyDates && (
                  <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    Date
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((pos) => (
                <tr
                  key={`${pos.topic}-${pos.date ?? "undated"}`}
                  className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">
                    {topicLabel(pos.topic)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {pos.view}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {pos.estimate ?? "\u2014"}
                  </td>
                  <td className="px-4 py-3">
                    {pos.confidence && (
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${CONFIDENCE_STYLES[pos.confidence] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {pos.confidence}
                      </span>
                    )}
                  </td>
                  {hasAnyDates && (
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {pos.date ? formatDate(pos.date) : "\u2014"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sorted.some((p) => p.source) && (
          <div className="px-4 py-2.5 border-t border-border/40 bg-muted/20">
            <p className="text-xs text-muted-foreground">
              Sources:{" "}
              {sorted
                .filter((p) => p.source)
                .map((p, i) => (
                  <span key={`${p.topic}-${p.date ?? "undated"}`}>
                    {i > 0 && " \u00B7 "}
                    {p.sourceUrl ? (
                      <a
                        href={p.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {p.source}
                      </a>
                    ) : (
                      p.source
                    )}
                    {p.date && (
                      <span className="ml-1 text-muted-foreground/70">
                        ({formatDate(p.date)})
                      </span>
                    )}
                  </span>
                ))}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
