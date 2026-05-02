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
} from "../ai-model-constants";
import { formatCompactNumber } from "@/lib/format-compact";
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
  SystemCardTab,
} from "@/app/ai-models/[slug]/tabs";
import {
  fetchFromWikiServer,
  type RpcModelSystemCardsByModelResult,
  type RpcModelSystemCardRow,
  type RpcModelAliasesAllResult,
} from "@lib/wiki-server";

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
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ card?: string }>;
}) {
  const { slug } = await params;
  const sp = (await searchParams) ?? {};
  const entity = resolveAiModelBySlug(slug);
  if (!entity) {
    const canonical = resolveSlugAlias(slug);
    if (canonical) permanentRedirect(`/ai-models/${canonical}`);
    return notFound();
  }

  // Fetch system cards (QUA-702) and model aliases (QUA-745) in parallel.
  // Best-effort: a wiki-server outage shouldn't break the whole page, just
  // hide the tab / drop the "Also known as" line.
  let systemCards: RpcModelSystemCardRow[] = [];
  let aliases: string[] = [];
  if (entity.stableId) {
    const [cardsResult, aliasesResult] = await Promise.all([
      fetchFromWikiServer<RpcModelSystemCardsByModelResult>(
        `/api/model-system-cards/by-model/${entity.stableId}?limit=20`,
        { revalidate: 300 },
      ),
      fetchFromWikiServer<RpcModelAliasesAllResult>(
        `/api/model-aliases/all?modelStableId=${encodeURIComponent(entity.stableId)}&limit=200`,
        { revalidate: 300 },
      ),
    ]);
    if (cardsResult?.items) systemCards = cardsResult.items;
    if (aliasesResult?.items) {
      // Skip aliases that are already the entity title (case-insensitive) —
      // showing "Also known as: gpt-4 turbo" on the GPT-4 Turbo page is noise.
      const titleLower = entity.title.toLowerCase();
      aliases = aliasesResult.items
        .map((r) => r.alias)
        .filter((a) => a.toLowerCase() !== titleLower);
    }
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
      value: `${formatCompactNumber(entity.contextWindow)} tokens`,
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

  if (systemCards.length > 0) {
    tabs.push({
      id: "system-card",
      label: "System Card",
      count: systemCards.length > 1 ? systemCards.length : undefined,
      content: (
        <SystemCardTab
          cards={systemCards}
          selectedCardId={sp.card}
          modelSlug={slug}
        />
      ),
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

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "AI Models", href: "/ai-models" },
        { label: entity.title },
      ]}
      entityId={entity.id}
      title={entity.title}
      titlePills={titlePills}
      aliases={aliases.length > 0 ? aliases : undefined}
      coverage={{ score: coverageScore, signals: coverageSignals }}
      subtitle={entity.description || undefined}
      headerLinks={headerLinks}
      statCards={statCards}
      tabs={tabs}
      tabsAriaLabel="AI model sections"
      tabsLayout="vertical"
    />
  );
}

