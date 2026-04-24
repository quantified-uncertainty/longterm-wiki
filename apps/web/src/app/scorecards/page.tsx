import type { Metadata } from "next";
import Link from "next/link";
import { fetchDetailed } from "@lib/wiki-server";
import { ProfileStatCard } from "@/components/directory";
import {
  ScorecardsMatrix,
  type ScorecardCell,
  type ScorecardOrgRow,
} from "./scorecards-matrix";
import {
  SCORECARD_SOURCES,
  getScorecardSourceMeta,
  type ScorecardSourceKey,
} from "./scorecards-constants";

export const metadata: Metadata = {
  title: "Scorecards",
  description:
    "Side-by-side view of external AI-safety scorecards: FLI AI Safety Index, SaferAI Ratings, AI Lab Watch, Stanford FMTI, and the Seoul Commitment Tracker.",
};

/**
 * Wiki-server response shapes — keep narrow to the fields rendered.
 * The full Hono RPC types would require importing route types into the
 * web app; the directory page reads enough fields that hand-typing is
 * less coupling than a full type import.
 */
interface SnapshotRow {
  id: string;
  scorecardSource: string;
  waveLabel: string | null;
  publishedAt: string;
  sourceUrl: string;
  methodologyUrl: string | null;
  license: string | null;
  orgCount: number;
  dimensionCount: number;
  isLatest: boolean;
  sourceActive: boolean;
  notes: string | null;
}

interface GradeRow {
  id: string;
  snapshotId: string;
  scorecardSource: string | null;
  publishedAt: string | null;
  isLatest: boolean | null;
  entityId: string;
  entityDisplayName: string;
  entitySlug: string | null;
  dimensionSlug: string;
  dimensionLabel: string;
  scoreNumeric: number | null;
  scoreLetter: string | null;
  scoreRaw: string;
}

export default async function ScorecardsPage() {
  // Load latest snapshots (one per source) and overall-dimension grades.
  // The page caps load by filtering grades to dimensionSlug='overall'
  // — per-dimension drill-down lives on the org's profile tab, not here.
  const snapshotsRes = await fetchDetailed<{
    items: SnapshotRow[];
    total: number;
  }>("/api/scorecard-snapshots/all?limit=50&latest=true", { revalidate: 300 });

  const gradesRes = await fetchDetailed<{
    items: GradeRow[];
    total: number;
  }>("/api/scorecard-grades/all?limit=1000&latest=true", { revalidate: 300 });

  const snapshots = snapshotsRes.ok ? snapshotsRes.data.items : [];
  const grades = gradesRes.ok ? gradesRes.data.items : [];
  const fetchOk = snapshotsRes.ok && gradesRes.ok;

  // Index latest snapshot per source (defensive — partial unique index
  // already enforces this, but the UI should not crash if it's somehow
  // violated).
  const latestPerSource = new Map<string, SnapshotRow>();
  for (const s of snapshots) {
    if (s.isLatest) latestPerSource.set(s.scorecardSource, s);
  }

  // Build the org × source matrix from `overall` rows only.
  const orgMap = new Map<string, ScorecardOrgRow>();
  for (const g of grades) {
    if (g.dimensionSlug !== "overall") continue;
    if (!g.scorecardSource) continue;
    const existing = orgMap.get(g.entityId);
    const cell: ScorecardCell = {
      source: g.scorecardSource as ScorecardSourceKey,
      scoreNumeric: g.scoreNumeric,
      scoreLetter: g.scoreLetter,
      scoreRaw: g.scoreRaw,
      publishedAt: g.publishedAt,
    };
    if (existing) {
      existing.cells[g.scorecardSource] = cell;
    } else {
      orgMap.set(g.entityId, {
        entityId: g.entityId,
        displayName: g.entityDisplayName,
        slug: g.entitySlug,
        cells: { [g.scorecardSource]: cell },
      });
    }
  }
  const orgRows = [...orgMap.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  const totalOrgs = orgRows.length;
  const totalCellsRendered = orgRows.reduce(
    (sum, row) => sum + Object.keys(row.cells).length,
    0,
  );
  const sourcesWithData = new Set(
    [...orgMap.values()].flatMap((r) => Object.keys(r.cells)),
  ).size;

  const stats = [
    { label: "Scorecards", value: String(SCORECARD_SOURCES.length) },
    { label: "Sources w/ Data", value: String(sourcesWithData) },
    { label: "Organizations", value: String(totalOrgs) },
    { label: "Cells", value: String(totalCellsRendered) },
  ];

  return (
    <div className="container max-w-6xl mx-auto px-4 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-3">External Scorecards</h1>
        <p className="text-muted-foreground max-w-3xl">
          Side-by-side overall grades from the five major external AI-safety
          scorecards. Click any row to view per-dimension grades on the
          organization&apos;s profile.
        </p>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      {!fetchOk ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm">
          The wiki-server was unreachable; scorecard data is temporarily
          unavailable. The matrix and methodology sections will populate once
          the server responds.
        </div>
      ) : null}

      {fetchOk && totalOrgs === 0 ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-6 text-sm space-y-2 mb-8">
          <p className="font-medium">No scorecard grades ingested yet.</p>
          <p className="text-muted-foreground">
            The scorecard schema and sync API are live, but per-source
            ingesters land in follow-up tickets — see QUA-688 for status.
            Methodology and source links below are usable today.
          </p>
        </div>
      ) : null}

      {orgRows.length > 0 ? (
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">
            Overall grades — latest wave per scorecard
          </h2>
          <ScorecardsMatrix orgRows={orgRows} />
        </section>
      ) : null}

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4">Methodology</h2>
        <div className="space-y-3">
          {SCORECARD_SOURCES.map((meta) => {
            const snapshot = latestPerSource.get(meta.source);
            return (
              <article
                key={meta.source}
                className="rounded-lg border border-border/60 bg-card p-4"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
                  <h3 className="font-semibold">{meta.fullLabel}</h3>
                  <span className="text-xs text-muted-foreground">
                    by {meta.publisher}
                  </span>
                  {!meta.active ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                      No longer maintained
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground mb-2">
                  {meta.description}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <Link
                    href={snapshot?.sourceUrl ?? meta.homeUrl}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Source ↗
                  </Link>
                  {snapshot?.methodologyUrl ? (
                    <Link
                      href={snapshot.methodologyUrl}
                      className="text-primary hover:underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Methodology ↗
                    </Link>
                  ) : null}
                  {snapshot ? (
                    <span className="text-muted-foreground">
                      Latest: {snapshot.waveLabel ?? snapshot.publishedAt}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">
                      not yet ingested
                    </span>
                  )}
                  {snapshot?.license ? (
                    <span className="text-muted-foreground">
                      License: {snapshot.license}
                    </span>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Grades are mirrored from upstream sources. We do not score
        organizations ourselves — see each row&apos;s source link for
        methodology and full per-dimension grades. Citation of published
        grades is consistent with fair-use attribution.
      </p>
    </div>
  );
}

void getScorecardSourceMeta;
