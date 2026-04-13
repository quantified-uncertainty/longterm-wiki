import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getTypedEntityById, getPageById } from "@/data";
import {
  resolveAiModelBySlug,
  getAiModelSlugs,
  getRelatedModels,
} from "../ai-model-utils";
import { resolveSlugAlias } from "@/data/factbase";
import {
  DEVELOPER_COLORS,
  SAFETY_LEVEL_COLORS,
  formatContext,
} from "../ai-model-constants";
import { ProfileStatCard, type ProfileTab } from "@/components/directory";
import {
  computeAiModelCoverage,
  getAiModelSignals,
} from "@/components/coverage/coverage-score";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  OverviewTab,
  PricingTab,
  BenchmarksTab,
  FamilyTab,
} from "@/app/ai-models/[slug]/tabs";

export function generateStaticParams() {
  return getAiModelSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveAiModelBySlug(slug);
  return {
    title: entity ? `${entity.title} | AI Models` : "AI Model Not Found",
    description: entity?.description ?? undefined,
  };
}

export default async function AiModelDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveAiModelBySlug(slug);
  if (!entity) {
    const canonical = resolveSlugAlias(slug);
    if (canonical) permanentRedirect(`/ai-models/${canonical}`);
    return notFound();
  }

  // Resolve developer
  const developerEntity = entity.developer
    ? getTypedEntityById(entity.developer)
    : null;

  // Related models (same family or developer)
  const relatedModels = getRelatedModels(entity);
  const sameFamily = relatedModels.filter(
    (m) => m.modelFamily && m.modelFamily === entity.modelFamily,
  );
  const sameDeveloper = relatedModels.filter(
    (m) =>
      m.developer === entity.developer &&
      (!m.modelFamily || m.modelFamily !== entity.modelFamily),
  );

  // Build stat cards
  const stats: Array<{
    label: string;
    value: string;
    sub?: string;
    href?: string;
  }> = [];

  if (developerEntity) {
    stats.push({
      label: "Developer",
      value: developerEntity.title,
      href: `/organizations/${entity.developer}`,
    });
  }

  if (entity.releaseDate) {
    stats.push({ label: "Released", value: entity.releaseDate });
  }

  if (entity.contextWindow != null) {
    stats.push({
      label: "Context Window",
      value: `${formatContext(entity.contextWindow)} tokens`,
    });
  }

  if (entity.safetyLevel) {
    stats.push({ label: "Safety Level", value: entity.safetyLevel });
  }

  // ── Build tabs ──
  // Tabs hide automatically via ProfileTabs when count === 0, so a model
  // with no pricing won't show the Pricing tab, etc.
  const tabs: ProfileTab[] = [
    {
      id: "overview",
      label: "Overview",
      content: <OverviewTab entity={entity} />,
    },
  ];

  if (entity.inputPrice != null || entity.outputPrice != null) {
    tabs.push({
      id: "pricing",
      label: "Pricing",
      content: <PricingTab entity={entity} />,
    });
  }

  if (entity.benchmarks.length > 0) {
    tabs.push({
      id: "benchmarks",
      label: "Benchmarks",
      count: entity.benchmarks.length,
      content: <BenchmarksTab entity={entity} />,
    });
  }

  if (sameFamily.length > 0 || sameDeveloper.length > 0) {
    tabs.push({
      id: "family",
      label: "Family",
      count: sameFamily.length + sameDeveloper.length,
      content: (
        <FamilyTab
          entity={entity}
          sameFamily={sameFamily}
          sameDeveloper={sameDeveloper}
          developerName={developerEntity?.title ?? "Developer"}
        />
      ),
    });
  }

  const titlePills = (
    <>
      {entity.developer && (
        <Link
          href={`/organizations/${entity.developer}`}
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold hover:opacity-80 transition-opacity ${
            DEVELOPER_COLORS[entity.developer] ??
            "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          }`}
        >
          {developerEntity?.title ?? entity.developer}
        </Link>
      )}
      {entity.openWeight && (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
          Open Weight
        </span>
      )}
      {entity.safetyLevel && (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${
            SAFETY_LEVEL_COLORS[entity.safetyLevel] ??
            "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          }`}
        >
          {entity.safetyLevel}
        </span>
      )}
    </>
  );

  const headerLinks = [
    ...(entity.wikiId && getPageById(entity.wikiId)
      ? [{ label: "Wiki page", href: `/wiki/${entity.wikiId}` }]
      : []),
    { label: "Data", href: `/ai-models/${slug}/data` },
  ];

  const coverageInput = {
    developer: entity.developer,
    releaseDate: entity.releaseDate,
    inputPrice: entity.inputPrice,
    outputPrice: entity.outputPrice,
    contextWindow: entity.contextWindow,
    parameterCount: entity.parameterCount,
    safetyLevel: entity.safetyLevel,
    benchmarkCount: entity.benchmarks.length,
    wikiId: entity.wikiId,
  };
  const coverageScore = computeAiModelCoverage(coverageInput);
  const coverageSignals = getAiModelSignals(coverageInput);

  const statCards = stats.length > 0 && (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map((s) => (
        <ProfileStatCard key={s.label} {...s} />
      ))}
    </div>
  );

  // Sidebar: Details + Tags. Capabilities moved into the Overview tab so
  // the sidebar stays focused on canonical metadata.
  const sidebar = (
    <>
      <section>
        <h2 className="text-lg font-bold tracking-tight mb-4">Details</h2>
        <div className="border border-border/60 rounded-xl bg-card">
          <DetailRow label="Model Family" value={entity.modelFamily} />
          <DetailRow label="Tier" value={entity.modelTier} capitalize />
          <DetailRow label="Generation" value={entity.generation} />
          <DetailRow label="Release Date" value={entity.releaseDate} />
          <DetailRow label="Parameters" value={entity.parameterCount} />
          <DetailRow
            label="Context Window"
            value={
              entity.contextWindow != null
                ? `${formatContext(entity.contextWindow)} tokens`
                : undefined
            }
          />
          <DetailRow label="Training Cutoff" value={entity.trainingCutoff} />
          <DetailRow
            label="Open Weight"
            value={
              entity.openWeight != null ? (entity.openWeight ? "Yes" : "No") : undefined
            }
          />
          <DetailRow label="Safety Level" value={entity.safetyLevel} />
        </div>
      </section>

      {entity.tags.length > 0 && (
        <section>
          <h2 className="text-lg font-bold tracking-tight mb-4">Tags</h2>
          <div className="flex flex-wrap gap-1.5">
            {entity.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted/50 text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "AI Models", href: "/ai-models" },
        { label: entity.title },
      ]}
      entityId={entity.id}
      title={entity.title}
      titlePills={titlePills}
      coverage={{ score: coverageScore, signals: coverageSignals }}
      subtitle={entity.description || undefined}
      headerLinks={headerLinks}
      statCards={statCards}
      tabs={tabs}
      tabsAriaLabel="AI model sections"
      sidebar={sidebar}
    />
  );
}

function DetailRow({
  label,
  value,
  capitalize,
}: {
  label: string;
  value?: string | null;
  capitalize?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="px-4 py-2.5 border-b border-border/40 last:border-b-0 flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-sm font-medium ${capitalize ? "capitalize" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
