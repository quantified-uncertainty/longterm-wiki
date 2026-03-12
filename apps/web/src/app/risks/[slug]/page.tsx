import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { resolveRiskBySlug, getRiskSlugs } from "@/app/risks/risk-utils";
import { getKBFacts, getKBLatest, getKBProperty } from "@/data/kb";
import { getTypedEntityById, isRisk, getEntityById } from "@/data";
import { getEntityWikiHref } from "@/lib/directory-utils";
import {
  ProfileStatCard,
  Breadcrumbs,
} from "@/components/directory";
import {
  formatKBFactValue,
  formatKBDate,
  titleCase,
} from "@/components/wiki/kb/format";
import type { Fact, Property } from "@longterm-wiki/kb";

export function generateStaticParams() {
  return getRiskSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveRiskBySlug(slug);
  return {
    title: entity ? `${entity.name} | Risks` : "Risk Not Found",
    description: entity
      ? `Profile and assessment data for ${entity.name}.`
      : undefined,
  };
}

// ── Risk category colors ──────────────────────────────────────────────
const RISK_CATEGORY_COLORS: Record<string, string> = {
  accident: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  misuse: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  structural: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  epistemic: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

const RISK_CATEGORY_LABELS: Record<string, string> = {
  accident: "Accident",
  misuse: "Misuse",
  structural: "Structural",
  epistemic: "Epistemic",
};

// ── Fact sidebar helpers ──────────────────────────────────────────────

const FACT_CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "assessment", label: "Assessment", order: 0 },
  { id: "risk", label: "Risk", order: 1 },
  { id: "other", label: "Other", order: 99 },
];

/** Group facts by property, taking only the latest per property. */
function getLatestFactsByProperty(facts: Fact[]): Map<string, Fact> {
  const latest = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    if (!latest.has(fact.propertyId)) {
      latest.set(fact.propertyId, fact);
    }
  }
  return latest;
}

/** Group property IDs by category, returning sorted categories. */
function groupByCategory(
  propertyIds: string[],
): Array<{ category: string; label: string; props: string[] }> {
  const groups = new Map<string, string[]>();
  for (const propId of propertyIds) {
    const prop = getKBProperty(propId);
    const category = prop?.category ?? "other";
    const list = groups.get(category) ?? [];
    list.push(propId);
    groups.set(category, list);
  }

  const catMap = new Map(FACT_CATEGORIES.map((c) => [c.id, c]));
  return [...groups.entries()]
    .map(([catId, props]) => ({
      category: catId,
      label: catMap.get(catId)?.label ?? titleCase(catId),
      order: catMap.get(catId)?.order ?? 99,
      props,
    }))
    .sort((a, b) => a.order - b.order);
}

/** Format a fact value for display, returning null if no fact. */
function formatFact(
  fact: Fact | undefined,
  property?: Partial<Property>,
): string | null {
  if (!fact) return null;
  return formatKBFactValue(fact, property?.unit, property?.display);
}

// ── Hero stat properties for risk pages ────────────────────────────────
const HERO_STATS = [
  "severity-level",
  "likelihood-estimate",
  "time-horizon",
  "evidence-strength",
  "expert-consensus-level",
];

// ── Main page ─────────────────────────────────────────────────────────

export default async function RiskProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveRiskBySlug(slug);
  if (!entity) return notFound();

  const typedEntity = getTypedEntityById(entity.id);
  const riskCategory =
    typedEntity && isRisk(typedEntity) ? (typedEntity.riskCategory ?? null) : null;

  // Description from the database entity
  const dbEntity = getEntityById(entity.id);
  const descriptionText =
    (dbEntity as { description?: string } | undefined)?.description ?? null;

  // All facts for the sidebar
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  const wikiHref = getEntityWikiHref(entity);

  // Fact sidebar data
  const latestByProp = getLatestFactsByProperty(allFacts);
  const categoryGroups = groupByCategory([...latestByProp.keys()]);

  // Build stat cards from hero facts
  const stats: Array<{
    label: string;
    value: string;
    sub?: string;
  }> = [];

  for (const propId of HERO_STATS) {
    const fact = getKBLatest(entity.id, propId);
    if (!fact) continue;
    const prop = getKBProperty(propId);
    const value = formatFact(fact, prop ?? undefined);
    if (value) {
      stats.push({
        label: prop?.name ?? titleCase(propId),
        value,
        sub: fact.asOf ? `as of ${formatKBDate(fact.asOf)}` : undefined,
      });
    }
  }

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Risks", href: "/risks" },
          { label: entity.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {entity.name}
          </h1>
          {riskCategory && (
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                RISK_CATEGORY_COLORS[riskCategory] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {RISK_CATEGORY_LABELS[riskCategory] ?? riskCategory}
            </span>
          )}
        </div>
        {entity.aliases && entity.aliases.length > 0 && (
          <p className="text-sm text-muted-foreground/70 mb-2">
            Also known as: {entity.aliases.join(", ")}
          </p>
        )}

        {/* Description */}
        {descriptionText && (
          <p className="text-sm text-muted-foreground leading-relaxed mb-3 max-w-prose">
            {descriptionText}
          </p>
        )}

        {/* Links row */}
        <div className="flex items-center gap-4 mt-2 text-sm">
          {wikiHref && (
            <Link
              href={wikiHref}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki page &rarr;
            </Link>
          )}
          <Link
            href={`/kb/entity/${entity.id}`}
            className="text-primary hover:text-primary/80 font-medium transition-colors"
          >
            KB data &rarr;
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      {stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
          {stats.map((s) => (
            <ProfileStatCard key={s.label} {...s} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-8">
          {/* Placeholder for future risk-specific content sections */}
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Facts sidebar */}
          {allFacts.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Facts
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {latestByProp.size}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {categoryGroups.map(({ category, label, props }) => (
                  <div key={category} className="px-4 py-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
                      {label}
                    </div>
                    <div className="space-y-1.5">
                      {props.map((propId) => {
                        const fact = latestByProp.get(propId);
                        if (!fact) return null;
                        const property = getKBProperty(propId);
                        return (
                          <div
                            key={propId}
                            className="flex items-baseline justify-between gap-2 text-sm"
                          >
                            <span className="text-muted-foreground text-xs truncate">
                              {property?.name ?? titleCase(propId)}
                            </span>
                            <span className="font-medium text-xs tabular-nums text-right shrink-0 max-w-[55%] truncate">
                              {formatKBFactValue(
                                fact,
                                property?.unit,
                                property?.display,
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <Link
                href={`/kb/entity/${entity.id}`}
                className="block mt-2 text-xs text-primary hover:underline text-center"
              >
                View all facts in KB explorer &rarr;
              </Link>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
