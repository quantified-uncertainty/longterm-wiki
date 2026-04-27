/**
 * FactBaseEntityBody — Reusable body for FactBase entity data display.
 *
 * Extracted from the /factbase/entity/[entityId] page so it can be embedded
 * in entity data pages (e.g., /organizations/anthropic/data).
 *
 * Renders hero stats, people, funding, facts by category, collections, and metadata.
 * Does NOT render breadcrumbs or the entity header — the parent page owns those.
 */

import Link from "next/link";
import {
  getKBEntity,
  getKBFacts,
  getKBAllRecordCollections,
  getKBProperty,
} from "@/data/factbase";
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
  SourcingSummary,
} from "@/components/factbase/entity-detail-components";

// ─── Data helpers ────────────────────────────────────────────────────

async function fetchEntityVerdicts(entityId: string): Promise<Map<string, VerdictRow>> {
  const data = await fetchFromWikiServer<VerdictsResponse>(
    `/api/sourcing/verdicts?record_type=fact&entity_id=${encodeURIComponent(entityId)}&limit=200`,
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

function groupByCategory(propertyIds: string[]): Map<string, string[]> {
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

// ─── Component ──────────────────────────────────────────────────────

interface FactBaseEntityBodyProps {
  /** FactBase entity ID (slug, e.g. "anthropic") */
  entityId: string;
  /** Skip fetching verdicts from wiki-server (for embedding in directory pages that use local data only). */
  skipVerdicts?: boolean;
  /**
   * Hide the hero stat-cards row. Use when the parent already renders the same
   * KPIs (e.g. the Overview tab in the organization profile shows the same
   * revenue/valuation/headcount cards, so rendering them again in the Facts
   * tab is pure duplication — QUA-671).
   */
  skipHeroStats?: boolean;
}

export async function FactBaseEntityBody({ entityId, skipVerdicts, skipHeroStats }: FactBaseEntityBodyProps) {
  const entity = getKBEntity(entityId);
  if (!entity) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No FactBase data found for this entity.
      </div>
    );
  }

  const allFacts = getKBFacts(entityId);
  const structuredFacts = allFacts.filter((f) => f.propertyId !== "description");
  const factGroups = groupFactsByProperty(allFacts);
  const itemCollections = getKBAllRecordCollections(entityId);
  const verdicts = skipVerdicts
    ? new Map<string, VerdictRow>()
    : await fetchEntityVerdicts(entityId);

  const propertyCache = new Map<string, Property | undefined>();
  for (const propId of factGroups.keys()) {
    propertyCache.set(propId, getKBProperty(propId));
  }

  const sortedPropertyIds = [...factGroups.keys()].sort((a, b) => {
    const pA = propertyCache.get(a);
    const pB = propertyCache.get(b);
    return (pA?.name ?? a).localeCompare(pB?.name ?? b);
  });

  const categoryGroups = groupByCategory(sortedPropertyIds);
  const sortedCategories = [...categoryGroups.keys()].sort(
    (a, b) => (CATEGORY_ORDER[a] ?? 50) - (CATEGORY_ORDER[b] ?? 50),
  );

  const totalItems = Object.values(itemCollections).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  const totalCollections = Object.keys(itemCollections).length;

  const heroProps = HERO_STAT_PROPERTIES[entity.type] ?? [];

  const genericCollections = Object.entries(itemCollections)
    .filter(([name]) => !SPECIAL_COLLECTIONS.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

  const hasContent = structuredFacts.length > 0 || totalItems > 0;

  if (!hasContent) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No FactBase facts or records for this entity.
      </div>
    );
  }

  return (
    <div>
      {/* Source check summary */}
      {verdicts.size > 0 && (
        <div className="mb-6">
          <SourcingSummary verdicts={verdicts} totalFacts={structuredFacts.length} />
        </div>
      )}

      {/* Hero Stat Cards — suppressed when the parent already renders them (QUA-671). */}
      {heroProps.length > 0 && !skipHeroStats && (
        <section className="mb-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {heroProps.map((propId) => (
              <StatCard key={propId} entityId={entityId} propertyId={propId} />
            ))}
          </div>
        </section>
      )}

      {/* Key People */}
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

      {/* Funding Rounds */}
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

      {/* Model Releases */}
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

      {/* Products */}
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

      {/* Facts by Category */}
      {sortedCategories.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-5">
            <h2 className="text-lg font-bold tracking-tight">All Facts</h2>
            <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
          </div>
          <div className="flex flex-wrap gap-1.5 mb-6">
            {sortedCategories.map((cat) => (
              <a
                key={cat}
                href={`#cat-${cat}`}
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-primary/5 hover:border-primary/30 text-muted-foreground hover:text-primary transition-all"
              >
                {CATEGORY_LABELS[cat] ?? titleCase(cat)}
                <span className="ml-1.5 text-muted-foreground/60 tabular-nums">
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
              />
            );
          })}
        </div>
      )}

      {/* Other Collections */}
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

      {/* Internal Metadata */}
      <details className="mb-8 group">
        <summary className="flex items-center gap-2 text-xs text-muted-foreground/60 cursor-pointer hover:text-muted-foreground select-none py-2">
          <span className="group-open:rotate-90 transition-transform">&#9654;</span>
          Internal Metadata
        </summary>
        <div className="mt-2 border border-border/50 rounded-lg overflow-hidden">
          {/* Each row has an explicit " : " separator in page text so a non-CSS reader
              (Playwright page.textContent, screen reader linear walk) still sees
              "ID: sid_..." instead of a label/value concatenation (QUA-671). */}
          <table className="w-full text-xs">
            <tbody className="divide-y divide-border/50">
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground w-[8rem] bg-muted/20">ID:{" "}</td>
                <td className="py-1.5 px-3 font-mono">{entity.id}</td>
              </tr>
              {entity.stableId && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Stable ID:{" "}</td>
                  <td className="py-1.5 px-3 font-mono">{entity.stableId}</td>
                </tr>
              )}
              {entity.wikiId && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Wiki ID:{" "}</td>
                  <td className="py-1.5 px-3 font-mono">{entity.wikiId}</td>
                </tr>
              )}
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Type:{" "}</td>
                <td className="py-1.5 px-3">{entity.type}</td>
              </tr>
              {entity.parent && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Parent:{" "}</td>
                  <td className="py-1.5 px-3">
                    <Link href={`/factbase/entity/${entity.parent}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      {getKBEntity(entity.parent)?.name ?? entity.parent}
                    </Link>
                  </td>
                </tr>
              )}
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">YAML Source:{" "}</td>
                <td className="py-1.5 px-3 font-mono">packages/factbase/data/fb-entities/{entityId}.yaml</td>
              </tr>
              <tr>
                <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Facts:{" "}</td>
                <td className="py-1.5 px-3">
                  {structuredFacts.length} structured
                  {allFacts.length !== structuredFacts.length && ` (${allFacts.length} total)`}
                </td>
              </tr>
              {totalItems > 0 && (
                <tr>
                  <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Records:{" "}</td>
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
