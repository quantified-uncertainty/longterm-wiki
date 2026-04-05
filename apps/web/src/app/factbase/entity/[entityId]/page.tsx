import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getKBEntity,
  getKBFacts,
  getKBAllRecordCollections,
  getKBProperty,
} from "@/data/factbase";
import { getEntityHref, getDirectoryHref } from "@/data";
import type { Fact, Property } from "@longterm-wiki/factbase";
import { titleCase } from "@/components/wiki/factbase/format";

import { fetchFromWikiServer } from "@/lib/wiki-server";

import type { VerdictRow, VerdictsResponse } from "@/components/factbase/entity-detail-components";
import {
  HERO_STAT_PROPERTIES,
  SPECIAL_COLLECTIONS,
  sortByDateField,
  StatCard,
  PersonCard,
  FundingRoundRow,
  ProductCard,
  ModelReleaseRow,
  SectionHeader,
  CategoryFactSection,
  GenericCollectionTable,
  VerificationSummary,
} from "@/components/factbase/entity-detail-components";

// ─── Rendering mode ──────────────────────────────────────────────────
// Render on-demand to reduce build output size (~724 pages x ~80KB each = ~56MB saved).
// These are internal FactBase pages with low traffic; SSG is unnecessary.
// Cache for 1 hour to avoid expensive re-renders from bot crawlers.
export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ entityId: string }>;
}): Promise<Metadata> {
  const { entityId } = await params;

  // Normalize underscores to hyphens (YAML files use underscores internally)
  if (entityId.includes("_")) {
    const normalized = entityId.replace(/_/g, "-");
    if (getKBEntity(normalized)) {
      redirect(`/factbase/entity/${normalized}`);
    }
  }

  const entity = getKBEntity(entityId);
  return {
    title: entity ? `FactBase: ${entity.name}` : `FactBase: ${entityId}`,
    robots: { index: false },
  };
}

// ─── Data helpers ────────────────────────────────────────────────────

async function fetchEntityVerdicts(entityId: string): Promise<Map<string, VerdictRow>> {
  const data = await fetchFromWikiServer<VerdictsResponse>(
    `/api/verifications/verdicts?record_type=fact&entity_id=${encodeURIComponent(entityId)}&limit=200`,
    { revalidate: 300 }
  );
  const map = new Map<string, VerdictRow>();
  if (data) {
    for (const v of data.verdicts) {
      map.set(v.recordId, v);
    }
  }
  return map;
}

/** Group facts by propertyId, excluding "description". */
function groupFactsByProperty(facts: Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    const list = groups.get(fact.propertyId) ?? [];
    list.push(fact);
    groups.set(fact.propertyId, list);
  }
  for (const [, list] of groups) {
    list.sort((a, b) => {
      if (a.asOf === undefined && b.asOf === undefined) return 0;
      if (a.asOf === undefined) return 1;
      if (b.asOf === undefined) return -1;
      return b.asOf.localeCompare(a.asOf);
    });
  }
  return groups;
}

/** Group property IDs by their category. */
function groupByCategory(
  propertyIds: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const propId of propertyIds) {
    const prop = getKBProperty(propId);
    const category = prop?.category ?? "other";
    const list = groups.get(category) ?? [];
    list.push(propId);
    groups.set(category, list);
  }
  return groups;
}

const CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "financial", label: "Financial", order: 0 },
  { id: "product", label: "Products & Usage", order: 1 },
  { id: "organization", label: "Organization", order: 2 },
  { id: "safety", label: "Safety & Research", order: 3 },
  { id: "people", label: "People", order: 4 },
  { id: "biographical", label: "Background", order: 5 },
  { id: "model", label: "Model Details", order: 6 },
  { id: "risk", label: "Risk Assessment", order: 7 },
  { id: "epistemic", label: "Epistemic Status", order: 8 },
  { id: "approach", label: "Approach", order: 9 },
  { id: "other", label: "Other", order: 99 },
];

const CATEGORY_ORDER: Record<string, number> = Object.fromEntries(CATEGORIES.map(c => [c.id, c.order]));
const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));

// ─── Page component ──────────────────────────────────────────────────

export default async function KBEntityPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;

  // Normalize underscores to hyphens (YAML files use underscores internally)
  if (entityId.includes("_")) {
    const normalized = entityId.replace(/_/g, "-");
    if (getKBEntity(normalized)) {
      redirect(`/factbase/entity/${normalized}`);
    }
  }

  const entity = getKBEntity(entityId);
  if (!entity) return notFound();

  const allFacts = getKBFacts(entityId);
  const structuredFacts = allFacts.filter((f) => f.propertyId !== "description");
  const factGroups = groupFactsByProperty(allFacts);
  const itemCollections = getKBAllRecordCollections(entityId);
  const verdicts = await fetchEntityVerdicts(entityId);

  // Build property cache to avoid repeated linear lookups
  const propertyCache = new Map<string, Property | undefined>();
  for (const propId of factGroups.keys()) {
    propertyCache.set(propId, getKBProperty(propId));
  }

  // Sort property groups alphabetically within each category
  const sortedPropertyIds = [...factGroups.keys()].sort((a, b) => {
    const pA = propertyCache.get(a);
    const pB = propertyCache.get(b);
    return (pA?.name ?? a).localeCompare(pB?.name ?? b);
  });

  // Group by category
  const categoryGroups = groupByCategory(sortedPropertyIds);
  const sortedCategories = [...categoryGroups.keys()].sort(
    (a, b) => (CATEGORY_ORDER[a] ?? 50) - (CATEGORY_ORDER[b] ?? 50),
  );

  const totalItems = Object.values(itemCollections).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  const totalCollections = Object.keys(itemCollections).length;

  // Separate profile (directory) and wiki page links
  const profileHref = getDirectoryHref(entityId);
  const wikiHref = entity.wikiId ? `/wiki/${entity.wikiId}` : null;

  // Hero stat properties for this entity type
  const heroProps = HERO_STAT_PROPERTIES[entity.type] ?? [];

  // Separate generic collections (special ones rendered individually above)
  const genericCollections = Object.entries(itemCollections)
    .filter(([name]) => !SPECIAL_COLLECTIONS.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      {/* ── Breadcrumbs ─────────────────────────────────────── */}
      <nav className="text-sm text-muted-foreground mb-4">
        <Link href="/factbase" className="hover:underline">
          FactBase
        </Link>
        <span className="mx-1.5">/</span>
        <span>{entity.name}</span>
      </nav>

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1.5">
          <h1 className="text-3xl font-extrabold tracking-tight">{entity.name}</h1>
          <span className="text-[11px] px-2.5 py-1 rounded-full bg-primary/10 text-primary font-semibold uppercase tracking-wider">
            {titleCase(entity.type)}
          </span>
        </div>
        {entity.aliases && entity.aliases.length > 0 && (
          <p className="text-sm text-muted-foreground/70 mb-2">
            Also known as: {entity.aliases.join(", ")}
          </p>
        )}
        <div className="flex items-center gap-3 text-sm">
          {profileHref && (
            <Link
              href={profileHref}
              className="inline-flex items-center gap-1 text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Profile page &rarr;
            </Link>
          )}
          {wikiHref && (
            <Link
              href={wikiHref}
              className="inline-flex items-center gap-1 text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki page &rarr;
            </Link>
          )}
          {verdicts.size > 0 && (
            <VerificationSummary verdicts={verdicts} totalFacts={structuredFacts.length} />
          )}
        </div>
      </div>

      {/* ── Hero Stat Cards ──────────────────────────────────── */}
      {heroProps.length > 0 && (
        <section className="mb-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {heroProps.map((propId) => (
              <StatCard key={propId} entityId={entityId} propertyId={propId} />
            ))}
          </div>
        </section>
      )}

      {/* ── Key People (card grid) ───────────────────────────── */}
      {itemCollections["key-persons"] && itemCollections["key-persons"].length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Key People" count={itemCollections["key-persons"].length} id="col-key-persons" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {itemCollections["key-persons"].map((item) => (
              <PersonCard key={item.key} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* ── Funding Rounds (timeline) ────────────────────────── */}
      {itemCollections["funding-rounds"] && itemCollections["funding-rounds"].length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Funding History" count={itemCollections["funding-rounds"].length} id="col-funding-rounds" />
          <div className="border border-border/60 rounded-xl px-4 bg-card">
            {sortByDateField(itemCollections["funding-rounds"], "date")
              .map((item) => (
                <FundingRoundRow key={item.key} item={item} />
              ))}
          </div>
        </section>
      )}

      {/* ── Model Releases ────────────────────────────────────── */}
      {itemCollections["model-releases"] && itemCollections["model-releases"].length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Model Releases" count={itemCollections["model-releases"].length} id="col-model-releases" />
          <div className="border border-border/60 rounded-xl px-4 bg-card">
            {sortByDateField(itemCollections["model-releases"], "released")
              .map((item) => (
                <ModelReleaseRow key={item.key} item={item} />
              ))}
          </div>
        </section>
      )}

      {/* ── Products (card grid) ──────────────────────────────── */}
      {itemCollections["products"] && itemCollections["products"].length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Products" count={itemCollections["products"].length} id="col-products" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {itemCollections["products"].map((item) => (
              <ProductCard key={item.key} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* ── Facts by Category ─────────────────────────────────── */}
      {sortedCategories.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-5">
            <h2 className="text-lg font-bold tracking-tight">All Facts</h2>
            <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
          </div>
          {/* Category jump links */}
          <div className="flex flex-wrap gap-1.5 mb-6">
            {sortedCategories.map((cat) => (
              <a
                key={cat}
                href={`#cat-${cat}`}
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-primary/5 hover:border-primary/30 text-muted-foreground hover:text-primary transition-all"
              >
                {CATEGORY_LABELS[cat] ?? titleCase(cat)}
                <span className="ml-1.5 text-muted-foreground/40 tabular-nums">
                  {categoryGroups.get(cat)?.length ?? 0}
                </span>
              </a>
            ))}
          </div>
          {sortedCategories.map((category) => {
            const propertyIds = categoryGroups.get(category);
            if (!propertyIds || propertyIds.length === 0) return null;
            return (
              <CategoryFactSection
                key={category}
                category={category}
                categoryLabel={CATEGORY_LABELS[category] ?? titleCase(category)}
                propertyIds={propertyIds}
                factGroups={factGroups}
                verdicts={verdicts}
              />
            );
          })}
        </div>
      )}

      {/* ── Other Collections ──────────────────────────────────── */}
      {genericCollections.length > 0 && (
        <div className="mb-8">
          {genericCollections.map(([collectionName, items]) => (
            <GenericCollectionTable
              key={collectionName}
              collectionName={collectionName}
              items={items}
            />
          ))}
        </div>
      )}

      {/* ── Internal Metadata (collapsed) ──────────────────────── */}
      <details className="mb-8 group">
        <summary className="flex items-center gap-2 text-xs text-muted-foreground/60 cursor-pointer hover:text-muted-foreground select-none py-2">
          <span className="group-open:rotate-90 transition-transform">&#9654;</span>
          Internal Metadata
        </summary>
        <div className="mt-2 border border-border/50 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <tbody className="divide-y divide-border/50">
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground w-[8rem] bg-muted/20">ID</td>
                <td className="py-1.5 px-3 font-mono">{entity.id}</td>
              </tr>
              {entity.stableId && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Stable ID</td>
                  <td className="py-1.5 px-3 font-mono">{entity.stableId}</td>
                </tr>
              )}
              {entity.wikiId && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Wiki ID</td>
                  <td className="py-1.5 px-3 font-mono">{entity.wikiId}</td>
                </tr>
              )}
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Type</td>
                <td className="py-1.5 px-3">{entity.type}</td>
              </tr>
              {entity.parent && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Parent</td>
                  <td className="py-1.5 px-3">
                    <Link href={`/factbase/entity/${entity.parent}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      {getKBEntity(entity.parent)?.name ?? entity.parent}
                    </Link>
                  </td>
                </tr>
              )}
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">YAML Source</td>
                <td className="py-1.5 px-3 font-mono">packages/factbase/data/things/{entityId}.yaml</td>
              </tr>
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Facts</td>
                <td className="py-1.5 px-3">
                  {structuredFacts.length} structured
                  {allFacts.length !== structuredFacts.length && ` (${allFacts.length} total)`}
                </td>
              </tr>
              {totalItems > 0 && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Records</td>
                  <td className="py-1.5 px-3">
                    {totalItems} in {totalCollections} collection{totalCollections !== 1 ? "s" : ""}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
