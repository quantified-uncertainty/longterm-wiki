import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchDetailed } from "@lib/wiki-server";
import { ProfileStatCard } from "@/components/directory";
import {
  DIMENSION_OVERALL,
  SCORECARD_SOURCES,
  formatScoreCell,
  getScorecardSourceMeta,
  type ScorecardSourceKey,
} from "@/app/scorecards/scorecards-constants";

export const revalidate = 300;

/**
 * Wiki-server response shapes — narrow to fields rendered. The full Hono
 * RPC types would force a route-import into the web app; per-source detail
 * is small enough that hand-typing is cheaper.
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

const PAGE_SIZE = 200;
const MAX_GRADES = 5000;

/**
 * Page through `/api/scorecard-grades/all` for one source's latest snapshot,
 * returning every dimension (not just `overall`). Returns `{ ok: false }`
 * on any page failure so the route can render an "unavailable" panel
 * instead of silently truncating the matrix.
 */
async function fetchAllGradesForSource(
  source: ScorecardSourceKey,
): Promise<{ ok: true; items: GradeRow[] } | { ok: false }> {
  const items: GradeRow[] = [];
  let offset = 0;
  while (items.length < MAX_GRADES) {
    const res = await fetchDetailed<{ items: GradeRow[]; total: number }>(
      `/api/scorecard-grades/all?limit=${PAGE_SIZE}&offset=${offset}&latest=true&scorecardSource=${source}`,
      { revalidate: 300 },
    );
    if (!res.ok) return { ok: false };
    items.push(...res.data.items);
    if (res.data.items.length < PAGE_SIZE || items.length >= res.data.total) {
      break;
    }
    offset += PAGE_SIZE;
  }
  if (items.length >= MAX_GRADES) {
    console.warn(
      `[scorecards/${source}] hit MAX_GRADES=${MAX_GRADES}; matrix may be truncated`,
    );
  }
  return { ok: true, items };
}

export function generateStaticParams() {
  return SCORECARD_SOURCES.map((meta) => ({ source: meta.source }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ source: string }>;
}): Promise<Metadata> {
  const { source } = await params;
  const meta = getScorecardSourceMeta(source);
  if (!meta) return { title: "Scorecard Not Found" };
  return {
    title: `${meta.fullLabel} | Scorecards`,
    description: meta.description,
  };
}

interface OrgDimensionRow {
  entityId: string;
  displayName: string;
  slug: string | null;
  cells: Record<string, GradeRow>;
}

export default async function ScorecardDetailPage({
  params,
}: {
  params: Promise<{ source: string }>;
}) {
  const { source } = await params;
  const meta = getScorecardSourceMeta(source);
  if (!meta) return notFound();
  const sourceKey = meta.source;

  // Every snapshot for this source (for history table; the latest is
  // picked from the same response) + every grade for the latest snapshot
  // (every dimension, not just overall). The /all endpoint orders by
  // `publishedAt DESC` so the first `isLatest=true` row is the latest.
  const [snapshotsRes, gradesRes] = await Promise.all([
    fetchDetailed<{ items: SnapshotRow[]; total: number }>(
      `/api/scorecard-snapshots/all?limit=200&source=${sourceKey}`,
      { revalidate: 300 },
    ),
    fetchAllGradesForSource(sourceKey),
  ]);

  const allSnapshots = snapshotsRes.ok ? snapshotsRes.data.items : [];
  const latestSnapshot = allSnapshots.find((s) => s.isLatest) ?? null;
  const grades = gradesRes.ok ? gradesRes.items : [];
  const fetchOk = snapshotsRes.ok && gradesRes.ok;

  // Build org × dimension matrix. `dimensionLabel` order is dictated by
  // first-seen order in the API response, which itself is sorted by
  // `entityDisplayName, dimensionSlug`. That gives a stable column order
  // per source even though the dimension set differs across sources.
  const orgMap = new Map<string, OrgDimensionRow>();
  const dimensionOrder: { slug: string; label: string }[] = [];
  const seenDimensions = new Set<string>();

  for (const g of grades) {
    if (!seenDimensions.has(g.dimensionSlug)) {
      seenDimensions.add(g.dimensionSlug);
      dimensionOrder.push({ slug: g.dimensionSlug, label: g.dimensionLabel });
    }
    const existing = orgMap.get(g.entityId);
    if (existing) {
      existing.cells[g.dimensionSlug] = g;
    } else {
      orgMap.set(g.entityId, {
        entityId: g.entityId,
        displayName: g.entityDisplayName,
        slug: g.entitySlug,
        cells: { [g.dimensionSlug]: g },
      });
    }
  }

  // Surface the overall column as leftmost when present — readers expect the
  // headline score before the per-pillar breakdown.
  dimensionOrder.sort((a, b) => {
    if (a.slug === DIMENSION_OVERALL && b.slug !== DIMENSION_OVERALL) return -1;
    if (b.slug === DIMENSION_OVERALL && a.slug !== DIMENSION_OVERALL) return 1;
    return a.label.localeCompare(b.label);
  });
  const hasOverall = dimensionOrder.some((d) => d.slug === DIMENSION_OVERALL);

  const orgRows = [...orgMap.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  const totalOrgs = orgRows.length;
  const totalDimensions = dimensionOrder.length;
  const totalSnapshots = allSnapshots.length;
  const latestWaveLabel =
    latestSnapshot?.waveLabel ?? latestSnapshot?.publishedAt ?? "—";

  const stats = [
    { label: "Organizations", value: String(totalOrgs) },
    { label: "Dimensions", value: String(totalDimensions) },
    { label: "Snapshots", value: String(totalSnapshots) },
    { label: "Latest wave", value: latestWaveLabel },
  ];

  return (
    <div className="container max-w-6xl mx-auto px-4 py-8">
      <header className="mb-6">
        <nav className="text-sm text-muted-foreground mb-2">
          <Link href="/scorecards" className="hover:underline">
            Scorecards
          </Link>
          <span className="mx-2">/</span>
          <span>{meta.shortLabel}</span>
        </nav>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
          <h1 className="text-3xl font-bold">{meta.fullLabel}</h1>
          {!meta.active ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              No longer maintained
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          by{" "}
          {meta.publisherSlug ? (
            <Link
              href={`/organizations/${meta.publisherSlug}`}
              className="text-primary hover:underline"
            >
              {meta.publisher}
            </Link>
          ) : (
            <span>{meta.publisher}</span>
          )}
          {latestSnapshot ? (
            <>
              <span className="mx-2">·</span>
              <span>Latest: {latestWaveLabel}</span>
            </>
          ) : null}
          <span className="mx-2">·</span>
          <Link
            href={latestSnapshot?.sourceUrl ?? meta.homeUrl}
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Source ↗
          </Link>
        </p>
        <p className="text-muted-foreground max-w-3xl">{meta.description}</p>
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
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm mb-6">
          The wiki-server was unreachable; scorecard data is temporarily
          unavailable. The matrix and snapshot history will populate once the
          server responds.
        </div>
      ) : null}

      {fetchOk && totalOrgs === 0 ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-6 text-sm space-y-2 mb-8">
          <p className="font-medium">No grades ingested yet.</p>
          <p className="text-muted-foreground">
            The {meta.shortLabel} ingester has not produced any grades for the
            latest snapshot. Methodology and source link below are usable
            today.
          </p>
        </div>
      ) : null}

      {orgRows.length > 0 && dimensionOrder.length > 0 ? (
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-1">
            Grades by dimension — {latestWaveLabel}
          </h2>
          <p className="text-xs text-muted-foreground mb-4">
            Rows are organizations; columns are the dimensions {meta.shortLabel}{" "}
            scores. Cell text is the published grade
            {hasOverall ? " (overall first, then per-pillar)" : ""}.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left">
                  <th className="px-3 py-2 font-semibold border-b border-border/60 sticky left-0 bg-muted/40">
                    Organization
                  </th>
                  {dimensionOrder.map((dim) => (
                    <th
                      key={dim.slug}
                      className="px-3 py-2 font-semibold border-b border-border/60 whitespace-nowrap"
                      title={dim.slug}
                    >
                      {dim.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orgRows.map((row) => (
                  <tr key={row.entityId} className="hover:bg-muted/20">
                    <td className="px-3 py-2 border-b border-border/30 sticky left-0 bg-background">
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
                    {dimensionOrder.map((dim) => {
                      const cell = row.cells[dim.slug];
                      if (!cell) {
                        return (
                          <td
                            key={dim.slug}
                            className="px-3 py-2 border-b border-border/30 text-muted-foreground"
                          >
                            —
                          </td>
                        );
                      }
                      const formatted = formatScoreCell(cell);
                      const rawSuffix =
                        cell.scoreRaw && cell.scoreRaw !== formatted
                          ? ` — raw: ${cell.scoreRaw}`
                          : "";
                      return (
                        <td
                          key={dim.slug}
                          className="px-3 py-2 border-b border-border/30 font-mono tabular-nums"
                          title={`${dim.label}${rawSuffix}`}
                        >
                          {formatted}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {allSnapshots.length > 0 ? (
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Snapshot history</h2>
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left">
                  <th className="px-3 py-2 font-semibold border-b border-border/60 whitespace-nowrap">
                    Wave
                  </th>
                  <th className="px-3 py-2 font-semibold border-b border-border/60 whitespace-nowrap">
                    Published
                  </th>
                  <th className="px-3 py-2 font-semibold border-b border-border/60 text-right">
                    Orgs
                  </th>
                  <th className="px-3 py-2 font-semibold border-b border-border/60">
                    License
                  </th>
                  <th className="px-3 py-2 font-semibold border-b border-border/60">
                    Links
                  </th>
                </tr>
              </thead>
              <tbody>
                {allSnapshots.map((snap) => (
                  <tr key={snap.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 border-b border-border/30">
                      {snap.waveLabel ?? snap.publishedAt}
                      {snap.isLatest ? (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                          latest
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 border-b border-border/30 tabular-nums">
                      {snap.publishedAt}
                    </td>
                    <td className="px-3 py-2 border-b border-border/30 text-right tabular-nums">
                      {snap.orgCount}
                    </td>
                    <td className="px-3 py-2 border-b border-border/30 text-muted-foreground">
                      {snap.license ?? "—"}
                    </td>
                    <td className="px-3 py-2 border-b border-border/30">
                      <div className="flex gap-x-3 text-xs">
                        <Link
                          href={snap.sourceUrl}
                          className="text-primary hover:underline"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Source ↗
                        </Link>
                        {snap.methodologyUrl ? (
                          <Link
                            href={snap.methodologyUrl}
                            className="text-primary hover:underline"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Methodology ↗
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4">Methodology</h2>
        <article className="rounded-lg border border-border/60 bg-card p-4">
          <p className="text-sm text-muted-foreground mb-3">
            {meta.description}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <Link
              href={latestSnapshot?.sourceUrl ?? meta.homeUrl}
              className="text-primary hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Source ↗
            </Link>
            {latestSnapshot?.methodologyUrl ? (
              <Link
                href={latestSnapshot.methodologyUrl}
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Methodology ↗
              </Link>
            ) : null}
            {latestSnapshot?.license ? (
              <span className="text-muted-foreground">
                License: {latestSnapshot.license}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              Status: {meta.active ? "active" : "no longer maintained"}
            </span>
          </div>
          {latestSnapshot?.notes ? (
            <p className="text-xs text-muted-foreground mt-3 whitespace-pre-line">
              {latestSnapshot.notes}
            </p>
          ) : null}
        </article>
      </section>

      <p className="text-xs text-muted-foreground">
        Grades are mirrored from upstream sources. We do not score
        organizations ourselves — see the source link for full methodology and
        per-indicator detail. Citation of published grades is consistent with
        fair-use attribution.
      </p>
    </div>
  );
}
