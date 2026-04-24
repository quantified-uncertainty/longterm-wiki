/**
 * Scorecards section on an organization's profile (QUA-688 Phase 1).
 *
 * Fetches every grade for the org from `/api/scorecard-grades/by-entity/...`
 * (latest snapshot per source) and renders one panel per source with
 * dimension grades.
 */

import Link from "next/link";
import { fetchDetailed } from "@lib/wiki-server";
import {
  SCORECARD_SOURCES,
  getScorecardSourceMeta,
  type ScorecardSourceKey,
} from "@/app/scorecards/scorecards-constants";

interface GradeRow {
  id: string;
  snapshotId: string;
  scorecardSource: string | null;
  publishedAt: string | null;
  isLatest: boolean | null;
  entityId: string;
  entityDisplayName: string;
  dimensionSlug: string;
  dimensionLabel: string;
  scoreNumeric: number | null;
  scoreLetter: string | null;
  scoreRaw: string;
  notes: string | null;
}

interface ByEntityResponse {
  items: GradeRow[];
  total: number;
}

interface SourceGroup {
  source: ScorecardSourceKey;
  rows: GradeRow[];
  publishedAt: string | null;
}

/**
 * Fetch + group an org's scorecard grades. Returns null when there are no
 * grades — caller suppresses the tab in that case.
 */
export async function loadScorecardsForEntity(
  entityStableId: string,
): Promise<{ groups: SourceGroup[]; totalRows: number } | null> {
  const result = await fetchDetailed<ByEntityResponse>(
    `/api/scorecard-grades/by-entity/${encodeURIComponent(entityStableId)}`,
    { revalidate: 300 },
  );
  if (!result.ok) return null;
  if (result.data.items.length === 0) return null;

  const groupsBySource = new Map<string, SourceGroup>();
  for (const r of result.data.items) {
    if (!r.scorecardSource) continue;
    const existing = groupsBySource.get(r.scorecardSource);
    if (existing) {
      existing.rows.push(r);
    } else {
      groupsBySource.set(r.scorecardSource, {
        source: r.scorecardSource as ScorecardSourceKey,
        rows: [r],
        publishedAt: r.publishedAt,
      });
    }
  }

  // Order groups by SCORECARD_SOURCES list (defines display order).
  const groups: SourceGroup[] = [];
  for (const meta of SCORECARD_SOURCES) {
    const group = groupsBySource.get(meta.source);
    if (group) groups.push(group);
  }

  return { groups, totalRows: result.data.items.length };
}

export function ScorecardsSection({
  groups,
}: {
  groups: SourceGroup[];
}) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No external scorecard grades on file.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Grades from external scorecards. We mirror published grades only;
        per-source methodology lives at the link in each panel header. See
        the{" "}
        <Link href="/scorecards" className="text-primary hover:underline">
          scorecards directory
        </Link>{" "}
        for cross-org comparison.
      </p>

      {groups.map((group) => {
        const meta = getScorecardSourceMeta(group.source);
        // Pull overall row first if present; render the rest below as a
        // dimensions table.
        const overallRow = group.rows.find((r) => r.dimensionSlug === "overall");
        const dimensionRows = group.rows.filter(
          (r) => r.dimensionSlug !== "overall",
        );

        return (
          <article
            key={group.source}
            className="rounded-lg border border-border/60 bg-card p-4"
          >
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
              <h3 className="font-semibold">
                {meta?.fullLabel ?? group.source}
              </h3>
              {meta?.publisher ? (
                <span className="text-xs text-muted-foreground">
                  by {meta.publisher}
                </span>
              ) : null}
              {group.publishedAt ? (
                <span className="text-xs text-muted-foreground">
                  Published {group.publishedAt}
                </span>
              ) : null}
              {meta?.homeUrl ? (
                <Link
                  href={meta.homeUrl}
                  className="text-xs text-primary hover:underline ml-auto"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source ↗
                </Link>
              ) : null}
            </header>

            {overallRow ? (
              <div className="mb-3 flex items-baseline gap-3">
                <span className="text-sm text-muted-foreground">Overall:</span>
                <span className="text-2xl font-mono tabular-nums">
                  {overallRow.scoreLetter ??
                    (overallRow.scoreNumeric != null
                      ? overallRow.scoreNumeric
                      : overallRow.scoreRaw)}
                </span>
              </div>
            ) : null}

            {dimensionRows.length > 0 ? (
              <table className="w-full text-sm">
                <tbody>
                  {dimensionRows.map((r) => {
                    const display =
                      r.scoreLetter ??
                      (r.scoreNumeric != null
                        ? `${r.scoreNumeric}`
                        : r.scoreRaw);
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-border/30 last:border-b-0"
                      >
                        <td className="py-1.5 pr-3">{r.dimensionLabel}</td>
                        <td className="py-1.5 font-mono tabular-nums text-right">
                          {display}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
