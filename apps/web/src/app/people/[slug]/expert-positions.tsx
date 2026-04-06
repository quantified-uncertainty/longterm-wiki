import type { ExpertPosition } from "@/data/tablebase";
import { getRecordVerdict } from "@data/tablebase";
import { getSourceCheckHref } from "@/app/source-checks/source-checks-shared";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";
import { CoverageDots } from "@/components/coverage/CoverageDots";
import { computeGenericCoverage } from "@/components/coverage/coverage-score";
import { topicLabel } from "@/data/topic-labels";
import { safeHref } from "@/lib/directory-utils";

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  medium:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

/** Format a date string like "2023", "2023-05", or "2023-05-01" for display */
function formatPositionDate(date: string): string {
  if (/^\d{4}-\d{2}$/.test(date)) {
    const [year, month] = date.split("-");
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${monthNames[parseInt(month, 10) - 1]} ${year}`;
  }
  return date;
}

export function ExpertPositions({
  positions,
  personSlug,
}: {
  positions: ExpertPosition[];
  personSlug: string;
}) {
  if (positions.length === 0) return null;

  const hasAnyDates = positions.some((p) => p.date);
  const hasAnyEstimates = positions.some((p) => p.estimate);
  const hasAnyConfidence = positions.some((p) => p.confidence);
  const hasAnySources = positions.some((p) => p.source || p.sourceUrl);

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Expert Positions
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {positions.length} {positions.length === 1 ? "topic" : "topics"}
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
                {hasAnyEstimates && (
                  <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    Estimate
                  </th>
                )}
                {hasAnyConfidence && (
                  <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    Confidence
                  </th>
                )}
                {hasAnyDates && (
                  <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    Date
                  </th>
                )}
                {hasAnySources && (
                  <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                    Source
                  </th>
                )}
                <th scope="col" className="py-2 px-2 w-16">
                  <span className="sr-only">Source check</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
              const recordId = `${personSlug}:${pos.topic}`;
              const verdict = getRecordVerdict("expert-position", recordId)?.verdict;
              return (
                <tr
                  key={pos.topic}
                  className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">
                    {topicLabel(pos.topic)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {pos.view}
                  </td>
                  {hasAnyEstimates && (
                    <td className="px-4 py-3 font-mono text-xs">
                      {pos.estimate ?? "—"}
                    </td>
                  )}
                  {hasAnyConfidence && (
                    <td className="px-4 py-3">
                      {pos.confidence ? (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${CONFIDENCE_STYLES[pos.confidence] ?? "bg-muted text-muted-foreground"}`}
                        >
                          {pos.confidence}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  )}
                  {hasAnyDates && (
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {pos.date ? formatPositionDate(pos.date) : "—"}
                    </td>
                  )}
                  {hasAnySources && (
                    <td className="px-4 py-3 text-xs">
                      {pos.source ? (
                        pos.sourceUrl ? (
                          <a
                            href={safeHref(pos.sourceUrl)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            {pos.source}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">
                            {pos.source}
                          </span>
                        )
                      ) : pos.sourceUrl ? (
                        <a
                          href={safeHref(pos.sourceUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          View source
                        </a>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  )}
                  <td className="py-1.5 px-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <CoverageDots score={computeGenericCoverage({
                        description: pos.estimate,
                        filledFieldCount: (pos.confidence ? 1 : 0) + (pos.source ? 1 : 0) + (pos.date ? 1 : 0),
                      })} />
                      <SourceCheckDot
                        status={recordVerdictToStatus(verdict)}
                        originalVerdict={verdict}
                        size="md"
                        href={getSourceCheckHref("expert-position", recordId)}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
