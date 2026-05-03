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
import { getEntityHref } from "@/data/entity-nav";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";

interface GradeRow {
  id: string;
  snapshotId: string;
  scorecardSource: string | null;
  publishedAt: string | null;
  isLatest: boolean | null;
  /** Wave label from the parent snapshot (QUA-867 item E). */
  waveLabel: string | null;
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

/**
 * Historical overall grade for a scorecard source — one row per wave per
 * source. Powers the per-panel grade trajectory mini-table (QUA-867 item
 * E). Hidden when only one wave is present.
 */
interface OverallHistoryRow {
  snapshotId: string;
  publishedAt: string | null;
  waveLabel: string | null;
  isLatest: boolean | null;
  scoreLetter: string | null;
  scoreNumeric: number | null;
  scoreRaw: string;
}

interface SourceGroup {
  source: ScorecardSourceKey;
  rows: GradeRow[];
  publishedAt: string | null;
  /**
   * Overall-grade history across all waves for this source, ordered newest
   * first. Empty when only one wave exists (the latest, already shown by
   * the panel's "Overall:" line).
   */
  history: OverallHistoryRow[];
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
  const enc = encodeURIComponent(entityStableId);
  // Two requests in parallel: the existing latest-wave fetch (with all
  // dimension rows) and a narrow overall-only history fetch for the
  // trajectory mini-table. Splitting them keeps the latest-wave payload
  // small and the history payload bounded (5 sources × ~3 waves = ~15
  // rows) — adding history to the main response would tack on an
  // extra wave-multiplier on every dimension row.
  const [latestRes, historyRes] = await Promise.all([
    fetchDetailed<ByEntityResponse>(
      `/api/scorecard-grades/by-entity/${enc}`,
      { revalidate: 300 },
    ),
    fetchDetailed<ByEntityResponse>(
      `/api/scorecard-grades/by-entity/${enc}?includeHistory=true&dimension=overall`,
      { revalidate: 300 },
    ),
  ]);
  if (!latestRes.ok) return { fetchError: true };
  if (latestRes.data.items.length === 0) return null;

  const groupsBySource = new Map<string, SourceGroup>();
  for (const r of latestRes.data.items) {
    if (!r.scorecardSource) continue;
    const existing = groupsBySource.get(r.scorecardSource);
    if (existing) {
      existing.rows.push(r);
    } else {
      groupsBySource.set(r.scorecardSource, {
        source: r.scorecardSource as ScorecardSourceKey,
        rows: [r],
        publishedAt: r.publishedAt,
        history: [],
      });
    }
  }

  // Layer history rows onto the source groups. A history-fetch failure is
  // non-fatal: we still render latest-wave panels, just without the
  // trajectory mini-table. Each source's history is sorted newest-first
  // by the API; we keep that order so the latest wave shows on top.
  if (historyRes.ok) {
    for (const r of historyRes.data.items) {
      if (!r.scorecardSource) continue;
      const group = groupsBySource.get(r.scorecardSource);
      if (!group) continue;
      group.history.push({
        snapshotId: r.snapshotId,
        publishedAt: r.publishedAt,
        waveLabel: r.waveLabel,
        isLatest: r.isLatest,
        scoreLetter: r.scoreLetter,
        scoreNumeric: r.scoreNumeric,
        scoreRaw: r.scoreRaw,
      });
    }
  }

  // Order groups by SCORECARD_SOURCES list (defines display order).
  const groups: SourceGroup[] = [];
  for (const meta of SCORECARD_SOURCES) {
    const group = groupsBySource.get(meta.source);
    if (group) groups.push(group);
  }

  return { groups, totalRows: latestRes.data.items.length };
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
        const overallText = overallRow ? formatScoreCell(overallRow) : null;
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
                      href={getEntityHref(meta.publisherSlug)}
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

            {overallRow && overallText !== null ? (
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
            ) : null}

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

            {/*
              Grade trajectory across waves (QUA-867 item E). Suppressed
              when a source has only one wave because the panel header
              already shows the latest grade. Today only FLI has multiple
              waves; the markup is generic so any source that lands a
              second wave gets the trajectory automatically.
            */}
            {group.history.length > 1 ? (
              <details className="mt-3 border-t border-border/30 pt-3">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  Grade trajectory ({group.history.length} waves)
                </summary>
                <dl className="w-full text-xs grid grid-cols-[1fr_auto] gap-x-3 mt-2">
                  {group.history.map((h) => {
                    const formatted = formatScoreCell(h);
                    const label = h.waveLabel ?? h.publishedAt ?? "—";
                    return (
                      <div
                        key={h.snapshotId}
                        className="contents border-b border-border/20 last:border-b-0"
                      >
                        <dt className="py-1 text-muted-foreground">
                          {label}
                          {h.isLatest ? (
                            <span className="ml-1.5 inline-flex items-center px-1 py-px rounded text-[9px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 align-middle">
                              latest
                            </span>
                          ) : null}
                        </dt>
                        <dd className={`py-1 text-right ${gradeCellFontClass(formatted)}`}>
                          {formatted}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </details>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
