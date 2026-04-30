/**
 * Scorecards section on an organization's profile.
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
  formatScoreCell,
  gradeCellFontClass,
  DIMENSION_OVERALL,
  type ScorecardSourceKey,
} from "@/app/scorecards/scorecards-constants";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";

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
  /**
   * Inline sourcing verdict (QUA-839). Null when never checked —
   * `recordVerdictToStatus` then renders an `unchecked` (white) dot.
   * The wiki-server returns more fields (confidence, sourcesChecked) but
   * panels only render verdict + checkedAt; widen this only when a tooltip
   * surface starts using them.
   */
  sourcing: { verdict: string; checkedAt: string | null } | null;
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
 * Fetch + group an org's scorecard grades.
 * - Returns null when the org has no grades (caller suppresses the tab).
 * - Returns { fetchError: true } on transient wiki-server failure (caller renders
 *   an "unavailable" state instead of dropping the tab).
 */
export type ScorecardsLoadResult =
  | { groups: SourceGroup[]; totalRows: number }
  | { fetchError: true };

export async function loadScorecardsForEntity(
  entityStableId: string,
): Promise<ScorecardsLoadResult | null> {
  const result = await fetchDetailed<ByEntityResponse>(
    `/api/scorecard-grades/by-entity/${encodeURIComponent(entityStableId)}`,
    { revalidate: 300 },
  );
  if (!result.ok) return { fetchError: true };
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
  fetchError,
}: {
  groups: SourceGroup[];
  fetchError?: boolean;
}) {
  if (fetchError) {
    return (
      <p className="text-sm text-muted-foreground">
        Scorecard grades are temporarily unavailable. Try again later.
      </p>
    );
  }
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
        const overallRow = group.rows.find(
          (r) => r.dimensionSlug === DIMENSION_OVERALL,
        );
        const dimensionRows = group.rows.filter(
          (r) => r.dimensionSlug !== DIMENSION_OVERALL,
        );

        return (
          <article
            key={group.source}
            className="rounded-lg border border-border/60 bg-card p-4"
          >
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
              <h3 className="font-semibold">
                {meta ? (
                  <Link
                    href={`/scorecards/${meta.source}`}
                    className="text-primary hover:underline"
                  >
                    {meta.fullLabel}
                  </Link>
                ) : (
                  group.source
                )}
              </h3>
              {meta?.publisher ? (
                <span className="text-xs text-muted-foreground">
                  by{" "}
                  {meta.publisherSlug ? (
                    <Link
                      href={`/organizations/${meta.publisherSlug}`}
                      className="text-primary hover:underline"
                    >
                      {meta.publisher}
                    </Link>
                  ) : (
                    meta.publisher
                  )}
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

            {overallRow ? (() => {
              const overallText = formatScoreCell(overallRow);
              return (
                <div className="mb-3 flex items-baseline gap-3">
                  <span className="text-sm text-muted-foreground">Overall:</span>
                  <span className="inline-flex items-baseline gap-2">
                    <span className={`text-2xl ${gradeCellFontClass(overallText)}`}>
                      {overallText}
                    </span>
                    <SourcingDot
                      status={recordVerdictToStatus(overallRow.sourcing?.verdict)}
                      originalVerdict={overallRow.sourcing?.verdict ?? null}
                      lastChecked={overallRow.sourcing?.checkedAt ?? null}
                      size="md"
                    />
                  </span>
                </div>
              );
            })() : null}

            {dimensionRows.length > 0 ? (
              <dl className="w-full text-sm grid grid-cols-[1fr_auto] gap-x-3">
                {dimensionRows.map((r) => {
                  const formatted = formatScoreCell(r);
                  return (
                    <div
                      key={r.id}
                      className="contents border-b border-border/30 last:border-b-0"
                    >
                      <dt className="py-1.5">{r.dimensionLabel}</dt>
                      <dd className={`py-1.5 text-right ${gradeCellFontClass(formatted)}`}>
                        <span className="inline-flex items-center gap-1.5 justify-end">
                          <span>{formatted}</span>
                          <SourcingDot
                            status={recordVerdictToStatus(r.sourcing?.verdict)}
                            originalVerdict={r.sourcing?.verdict ?? null}
                            lastChecked={r.sourcing?.checkedAt ?? null}
                            size="sm"
                          />
                        </span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
