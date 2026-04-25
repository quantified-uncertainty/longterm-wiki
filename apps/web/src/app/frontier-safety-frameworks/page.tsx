import type { Metadata } from "next";
import Link from "next/link";
import { ProfileStatCard } from "@/components/directory";
import {
  fetchAllFrameworks,
  fetchAllPublishedVersions,
  fetchThresholdsForVersion,
  fetchDiffsForVersion,
  type FrameworkRow,
  type FrameworkVersionRow,
} from "@/app/frontier-safety-frameworks/frameworks-data";
import { rowsToCellsForVersion, activeDomains } from "@/app/frontier-safety-frameworks/matrix-aggregation";
import { MatrixView, type MatrixRow } from "@/app/frontier-safety-frameworks/matrix-view";
import { TimelineView, type TimelineEntry } from "@/app/frontier-safety-frameworks/timeline-view";
import { FrameworksViewToggle } from "@/app/frontier-safety-frameworks/frameworks-view-toggle";

export const metadata: Metadata = {
  title: "Frontier Safety Frameworks",
  description:
    "Tracker of frontier-AI safety frameworks (RSPs, Preparedness Frameworks, FSFs) — versioned thresholds, capability domains, and diffs across published revisions.",
};

export const revalidate = 300;

export default async function FrontierSafetyFrameworksPage() {
  const frameworksRes = await fetchAllFrameworks();
  const frameworks = frameworksRes.items;
  const fetchOk = frameworksRes.ok;

  // For matrix view: latest published version per framework + its thresholds.
  // We fetch all published versions and pick the highest-sort one per framework
  // in a single pass, then fan out threshold queries.
  //
  // Cap is intentionally generous — current dataset is ~50 versions across all
  // frameworks (12 frameworks × ~3-5 versions each). If the count grows past
  // PUBLISHED_VERSIONS_FETCH_LIMIT we silently truncate the timeline + matrix,
  // so we assert below to catch that early. Switch to pagination if this fires.
  const PUBLISHED_VERSIONS_FETCH_LIMIT = 500;
  const allPublishedVersions = await fetchAllPublishedVersions(
    PUBLISHED_VERSIONS_FETCH_LIMIT,
  );
  if (allPublishedVersions.length >= PUBLISHED_VERSIONS_FETCH_LIMIT) {
    console.warn(
      `[frontier-safety-frameworks] fetchAllPublishedVersions returned ${allPublishedVersions.length} rows — at or near the ${PUBLISHED_VERSIONS_FETCH_LIMIT} cap. Timeline + matrix may be truncated; switch to pagination.`,
    );
  }
  const latestVersionByFramework = new Map<string, FrameworkVersionRow>();
  for (const v of allPublishedVersions) {
    const existing = latestVersionByFramework.get(v.frameworkId);
    if (!existing || v.versionSortOrder > existing.versionSortOrder) {
      latestVersionByFramework.set(v.frameworkId, v);
    }
  }

  const matrixRowsRaw = await Promise.all(
    frameworks.map(async (framework): Promise<MatrixRow> => {
      const latestVersion = latestVersionByFramework.get(framework.id) ?? null;
      const thresholds = latestVersion
        ? await fetchThresholdsForVersion(latestVersion.id)
        : [];
      return {
        framework,
        latestVersion,
        cells: rowsToCellsForVersion(thresholds),
      };
    }),
  );

  // Sort: published frameworks first, then by org name alphabetical.
  const matrixRows = [...matrixRowsRaw].sort((a, b) => {
    const aHas = a.latestVersion ? 0 : 1;
    const bHas = b.latestVersion ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return a.framework.org.displayName.localeCompare(
      b.framework.org.displayName,
    );
  });

  const domains = activeDomains(matrixRows.map((r) => r.cells));

  // Timeline view: all published versions in chronological order, with diffs.
  const sortedVersions = [...allPublishedVersions].sort((a, b) => {
    const aDate = a.publishedDate ?? a.discoveredDate;
    const bDate = b.publishedDate ?? b.discoveredDate;
    return bDate.localeCompare(aDate);
  });
  const frameworksById = new Map(frameworks.map((f) => [f.id, f]));
  const inboundDiffsByVersion = await Promise.all(
    sortedVersions.map(async (v) => {
      const diffs = await fetchDiffsForVersion(v.id);
      return [v.id, diffs[0] ?? null] as const;
    }),
  );
  const inboundDiffMap = new Map(inboundDiffsByVersion);

  const timelineEntries: TimelineEntry[] = sortedVersions
    .map((v): TimelineEntry | null => {
      const framework = frameworksById.get(v.frameworkId);
      if (!framework) return null;
      return {
        version: v,
        framework,
        inboundDiff: inboundDiffMap.get(v.id) ?? null,
      };
    })
    .filter((e): e is TimelineEntry => e !== null);

  // Stats
  const totalFrameworks = frameworks.length;
  const totalPublishedVersions = allPublishedVersions.length;
  const totalLabs = new Set(frameworks.map((f) => f.orgId)).size;
  const totalDomainsCovered = domains.length;

  return (
    <div className="container max-w-6xl mx-auto px-4 py-8">
      <header className="mb-8">
        <div className="flex items-baseline justify-between flex-wrap gap-3 mb-3">
          <h1 className="text-3xl font-bold">Frontier Safety Frameworks</h1>
          <Link
            href="/frontier-safety-frameworks/methodology"
            className="text-xs text-primary hover:underline"
          >
            Methodology →
          </Link>
        </div>
        <p className="text-muted-foreground max-w-3xl text-sm">
          Versioned commitments published by frontier AI labs (Responsible
          Scaling Policies, Preparedness Frameworks, Frontier Safety
          Frameworks). Thresholds extracted by an LLM, sourced to specific
          quotes, and cross-version diffs are flagged for human review before
          any directional summary is shown.
        </p>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <ProfileStatCard label="Frameworks" value={String(totalFrameworks)} />
        <ProfileStatCard label="Labs" value={String(totalLabs)} />
        <ProfileStatCard
          label="Published versions"
          value={String(totalPublishedVersions)}
        />
        <ProfileStatCard
          label="Risk domains covered"
          value={String(totalDomainsCovered)}
        />
      </div>

      {!fetchOk && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm mb-6">
          The wiki-server was unreachable; frameworks data is temporarily
          unavailable. The matrix and timeline will populate once the server
          responds.
        </div>
      )}

      {fetchOk && totalFrameworks === 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-6 text-sm space-y-2 mb-8">
          <p className="font-medium">No frameworks ingested yet.</p>
          <p className="text-muted-foreground">
            The schema and sync API are live, but per-lab ingest lands in
            QUA-707. Methodology is usable today.
          </p>
        </div>
      )}

      {totalFrameworks > 0 && (
        <FrameworksViewToggle
          matrix={<MatrixView rows={matrixRows} domains={domains} />}
          timeline={<TimelineView entries={timelineEntries} />}
        />
      )}

      <p className="text-xs text-muted-foreground mt-8">
        Thresholds are LLM-extracted from each framework version and grounded
        in quoted source text. See{" "}
        <Link
          href="/frontier-safety-frameworks/methodology"
          className="underline hover:text-primary"
        >
          methodology
        </Link>{" "}
        for extraction, classification, and review-state details.
      </p>
    </div>
  );
}
