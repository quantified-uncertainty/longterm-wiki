import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  fetchEntitySourcingSummary,
  rollupVerdictFromSummary,
} from "@/components/entity/entity-sourcing";
import {
  ProfileStatCard,
  type ProfileTab,
} from "@/components/directory";
import {
  fetchAllFrameworks,
  fetchFramework,
  fetchVersionsForFramework,
  fetchThresholdsForVersion,
  fetchDiffsForVersion,
  fetchDiffItemsForDiff,
  frameworkSlug,
  type FrameworkVersionRow,
  type DiffRow,
} from "@/app/frontier-safety-frameworks/frameworks-data";
import { LatestVersionTab } from "@/app/frontier-safety-frameworks/[slug]/latest-version-tab";
import { VersionHistoryTab } from "@/app/frontier-safety-frameworks/[slug]/version-history-tab";
import { ThresholdMatrixTab } from "@/app/frontier-safety-frameworks/[slug]/threshold-matrix-tab";
import { DiffsTab, type DiffWithItems } from "@/app/frontier-safety-frameworks/[slug]/diffs-tab";
import { SourcesTab } from "@/app/frontier-safety-frameworks/[slug]/sources-tab";

export const revalidate = 300;

export async function generateStaticParams() {
  const res = await fetchAllFrameworks();
  if (!res.ok) return [];
  return res.items.map((f) => ({ slug: frameworkSlug(f) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const framework = await fetchFramework(slug);
  if (!framework) {
    return { title: "Framework not found | Frontier Safety Frameworks" };
  }
  const display = framework.shortName ?? framework.name;
  return {
    title: `${display} | Frontier Safety Frameworks`,
    description: `Versioned ${framework.name} commitments published by ${framework.org.displayName}, with capability thresholds and cross-version diffs.`,
  };
}

export default async function FrameworkDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const framework = await fetchFramework(slug);
  if (!framework) return notFound();

  const allVersions = await fetchVersionsForFramework(framework.id);
  const publishedVersions = allVersions.filter(
    (v) => v.ingestStatus === "published",
  );
  const latestPublished =
    publishedVersions.length === 0
      ? null
      : publishedVersions.reduce<FrameworkVersionRow | null>((best, v) => {
          if (!best || v.versionSortOrder > best.versionSortOrder) return v;
          return best;
        }, null);

  // Versions ordered newest → oldest, used to fetch all inbound diffs.
  const versionsNewestFirst = [...publishedVersions].sort(
    (a, b) => b.versionSortOrder - a.versionSortOrder,
  );
  const versionsById = new Map<string, FrameworkVersionRow>(
    allVersions.map((v) => [v.id, v]),
  );

  // Fetch latest-version thresholds + all diffs for published versions in
  // parallel. Diffs for the earliest version are typically empty (no prior).
  const [latestThresholds, allDiffsByVersion] = await Promise.all([
    latestPublished
      ? fetchThresholdsForVersion(latestPublished.id)
      : Promise.resolve([]),
    Promise.all(
      versionsNewestFirst.map(async (v) => ({
        toVersionId: v.id,
        diffs: await fetchDiffsForVersion(v.id),
      })),
    ),
  ]);

  // Flatten + dedupe diffs (by id).
  const flatDiffs: DiffRow[] = [];
  const seenDiffIds = new Set<string>();
  for (const { diffs } of allDiffsByVersion) {
    for (const d of diffs) {
      if (!seenDiffIds.has(d.id)) {
        seenDiffIds.add(d.id);
        flatDiffs.push(d);
      }
    }
  }
  // Order diffs by `to_version_id` sort order (newest first).
  flatDiffs.sort((a, b) => {
    const aOrder = versionsById.get(a.toVersionId)?.versionSortOrder ?? 0;
    const bOrder = versionsById.get(b.toVersionId)?.versionSortOrder ?? 0;
    return bOrder - aOrder;
  });

  // Fetch diff items for each diff in parallel.
  const diffsWithItems: DiffWithItems[] = await Promise.all(
    flatDiffs.map(async (diff) => ({
      diff,
      items: await fetchDiffItemsForDiff(diff.id),
    })),
  );

  // ── Sourcing rollup (org-level — frameworks inherit the org's verdict) ──
  const sourcingSummary = await fetchEntitySourcingSummary([
    framework.orgId,
    framework.org.slug ?? "",
  ]);
  const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);

  // ── Tabs ──
  const tabs: ProfileTab[] = [
    {
      id: "latest",
      label: "Latest Version",
      content: (
        <LatestVersionTab
          version={latestPublished}
          thresholds={latestThresholds}
        />
      ),
    },
  ];

  if (allVersions.length > 0) {
    tabs.push({
      id: "history",
      label: "Version History",
      count: allVersions.length,
      content: <VersionHistoryTab versions={allVersions} />,
    });
  }

  if (latestPublished && latestThresholds.length > 0) {
    tabs.push({
      id: "thresholds",
      label: "Threshold Matrix",
      count: latestThresholds.length,
      content: (
        <ThresholdMatrixTab
          thresholds={latestThresholds}
          versionLabel={latestPublished.versionLabel}
        />
      ),
    });
  }

  if (diffsWithItems.length > 0) {
    tabs.push({
      id: "diffs",
      label: "Diffs",
      count: diffsWithItems.length,
      content: (
        <DiffsTab diffs={diffsWithItems} versionsById={versionsById} />
      ),
    });
  }

  if (allVersions.length > 0) {
    tabs.push({
      id: "sources",
      label: "Sources & Archive",
      count: allVersions.length,
      content: <SourcesTab versions={allVersions} />,
    });
  }

  // ── Header slots ──
  const titlePills = (
    <>
      {framework.shortName && framework.shortName !== framework.name && (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
          {framework.name}
        </span>
      )}
      {framework.currentStatus && (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold capitalize ${
            framework.currentStatus === "active"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
              : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          }`}
        >
          {framework.currentStatus}
        </span>
      )}
    </>
  );

  const headerLinks = [
    ...(framework.org.slug
      ? [{ label: framework.org.displayName, href: `/organizations/${framework.org.slug}` }]
      : []),
    { label: "Methodology", href: "/frontier-safety-frameworks/methodology" },
    { label: "All frameworks", href: "/frontier-safety-frameworks" },
  ];

  const stats = [
    {
      label: "Versions",
      value: String(allVersions.length),
      sub: `${publishedVersions.length} published`,
    },
    {
      label: "Latest",
      value: latestPublished?.versionLabel ?? "—",
      sub: latestPublished?.publishedDate ?? undefined,
    },
    {
      label: "Thresholds",
      value: String(latestThresholds.length),
      sub:
        latestPublished == null
          ? "no published version"
          : `for ${latestPublished.versionLabel}`,
    },
    {
      label: "Diffs",
      value: String(diffsWithItems.length),
    },
  ];

  const statCards = (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map((s) => (
        <ProfileStatCard key={s.label} {...s} />
      ))}
    </div>
  );

  const subtitle = framework.notes ? (
    <p>{framework.notes}</p>
  ) : (
    <p>
      Published commitment from {framework.org.displayName} governing how the
      lab approaches frontier-AI risk thresholds.
    </p>
  );

  const sidebar = (
    <section>
      <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">
        About this tracker
      </h2>
      <div className="text-xs text-muted-foreground space-y-2 leading-relaxed">
        <p>
          Each framework version is fetched, hashed, and archived. Capability
          thresholds are LLM-extracted with mandatory source quotes; diffs
          between consecutive versions are classified before any directional
          summary is shown publicly.
        </p>
        <p>
          See the{" "}
          <Link
            href="/frontier-safety-frameworks/methodology"
            className="underline hover:text-primary"
          >
            methodology page
          </Link>{" "}
          for extraction, classification, and review-state details.
        </p>
      </div>
    </section>
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "Frontier Safety Frameworks", href: "/frontier-safety-frameworks" },
        { label: framework.shortName ?? framework.name },
      ]}
      entityId={framework.id}
      title={framework.shortName ?? framework.name}
      titlePills={titlePills}
      verdict={rollupVerdict}
      subtitle={subtitle}
      headerLinks={headerLinks}
      statCards={statCards}
      tabs={tabs}
      tabsAriaLabel="Framework sections"
      sidebar={sidebar}
    />
  );
}
