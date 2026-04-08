/**
 * Section-level source-check coverage summary.
 *
 * Shows "12 of 47 records source-checked" above a table, with a breakdown
 * of verdict counts. Only renders when at least one record has been checked.
 * Server component — calls getRecordVerdictStats() directly.
 */
import { getRecordVerdictStats } from "@data/tablebase";

export function SourceCheckSummaryBanner({
  recordType,
  totalOverride,
}: {
  recordType: string;
  /** Override the total count (useful when the table filters records). */
  totalOverride?: number;
}) {
  const stats = getRecordVerdictStats(recordType);
  const checked = stats.confirmed + stats.contradicted + stats.outdated + stats.partial + stats.unverifiable;
  const total = totalOverride ?? checked + stats.unchecked;

  if (checked === 0) return null;

  const parts: string[] = [];
  if (stats.confirmed > 0) parts.push(`${stats.confirmed} confirmed`);
  if (stats.contradicted > 0) parts.push(`${stats.contradicted} disputed`);
  if (stats.outdated > 0) parts.push(`${stats.outdated} outdated`);
  if (stats.partial > 0) parts.push(`${stats.partial} partial`);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 border border-border/50 rounded-lg px-3 py-1.5 mb-2">
      <svg
        className="w-3.5 h-3.5 shrink-0 text-muted-foreground/70"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
      <span>
        <span className="font-medium text-foreground/80">{checked}</span>
        {" of "}
        <span className="font-medium text-foreground/80">{total}</span>
        {" records source-checked"}
        {parts.length > 0 && (
          <span className="text-muted-foreground/80">
            {" \u00b7 "}
            {parts.join(" \u00b7 ")}
          </span>
        )}
      </span>
    </div>
  );
}
