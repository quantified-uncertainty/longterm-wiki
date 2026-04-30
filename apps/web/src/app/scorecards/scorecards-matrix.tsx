import Link from "next/link";
import {
  SCORECARD_SOURCES,
  formatScoreCell,
  type ScorecardSourceKey,
} from "@/app/scorecards/scorecards-constants";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";

export interface ScorecardCellSourcing {
  verdict: string | null;
  checkedAt: string | null;
}

export interface ScorecardCell {
  source: ScorecardSourceKey;
  scoreNumeric: number | null;
  scoreLetter: string | null;
  scoreRaw: string;
  publishedAt: string | null;
  /**
   * Sourcing verdict for this grade (QUA-839). Null when no verdict
   * row exists yet — the verdict-generation pipeline is a separate ticket
   * (see `.claude/rules/sourcing-system.md`). Renders an `unchecked`
   * white dot in that case.
   */
  sourcing: ScorecardCellSourcing | null;
}

export interface ScorecardOrgRow {
  entityId: string;
  displayName: string;
  /** Slug for /organizations/<slug> linking; null when entity isn't in catalog. */
  slug: string | null;
  /** Map of source enum → cell. Missing key = no grade for that source. */
  cells: Record<string, ScorecardCell>;
}

/**
 * Pure, server-renderable matrix table. No client interactivity yet —
 * sort/filter UI lives in a follow-up. Keeping this server-only avoids
 * shipping a client bundle for a dense data table.
 */
export function ScorecardsMatrix({
  orgRows,
}: {
  orgRows: ScorecardOrgRow[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/40 text-left">
            <th className="px-3 py-2 font-semibold border-b border-border/60">
              Organization
            </th>
            {SCORECARD_SOURCES.map((meta) => (
              <th
                key={meta.source}
                className="px-3 py-2 font-semibold border-b border-border/60 whitespace-nowrap"
              >
                {meta.shortLabel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orgRows.map((row) => (
            <tr key={row.entityId} className="hover:bg-muted/20">
              <td className="px-3 py-2 border-b border-border/30">
                {row.slug ? (
                  <Link
                    href={`/organizations/${row.slug}`}
                    className="text-primary hover:underline"
                  >
                    {row.displayName}
                  </Link>
                ) : (
                  <span>{row.displayName}</span>
                )}
              </td>
              {SCORECARD_SOURCES.map((meta) => {
                const cell = row.cells[meta.source];
                if (!cell) {
                  return (
                    <td
                      key={meta.source}
                      className="px-3 py-2 border-b border-border/30 text-muted-foreground"
                    >
                      —
                    </td>
                  );
                }
                return (
                  <td
                    key={meta.source}
                    className="px-3 py-2 border-b border-border/30 font-mono tabular-nums"
                    title={`${meta.fullLabel}${
                      cell.publishedAt ? ` — ${cell.publishedAt}` : ""
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span>{formatScoreCell(cell)}</span>
                      <SourcingDot
                        status={recordVerdictToStatus(cell.sourcing?.verdict)}
                        originalVerdict={cell.sourcing?.verdict ?? null}
                        lastChecked={cell.sourcing?.checkedAt ?? null}
                        size="sm"
                      />
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
