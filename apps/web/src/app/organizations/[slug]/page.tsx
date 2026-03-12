import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import {
  getKBLatest,
  getKBFacts,
  getKBEntity,
  getKBProperty,
  getKBEntitySlug,
} from "@/data/kb";
import { getTypedEntityById, isOrganization } from "@/data";
import {
  formatKBFactValue,
  formatKBDate,
  titleCase,
  shortDomain,
  isUrl,
} from "@/components/wiki/kb/format";
import type { Fact, Property } from "@longterm-wiki/kb";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";

export function generateStaticParams() {
  return getOrgSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  return {
    title: entity ? `${entity.name} | Organizations` : "Organization Not Found",
    description: entity
      ? `Profile and key metrics for ${entity.name}.`
      : undefined,
  };
}

// ── Subcomponents ─────────────────────────────────────────────────────

/** Render a fact value, resolving ref/refs to entity name links. */
function FactValueDisplay({ fact, property }: { fact: Fact; property?: Property }) {
  const v = fact.value;
  if (v.type === "ref") {
    const refEntity = getKBEntity(v.value);
    if (refEntity) {
      const refSlug = getKBEntitySlug(v.value);
      const href = refSlug && refEntity.type === "organization" ? `/organizations/${refSlug}`
        : refSlug && refEntity.type === "person" ? `/people/${refSlug}`
        : `/kb/entity/${v.value}`;
      return (
        <Link href={href} className="text-primary hover:underline">
          {refEntity.name}
        </Link>
      );
    }
    return <span>{v.value}</span>;
  }
  if (v.type === "refs") {
    return (
      <span>
        {v.value.map((refId, i) => {
          const refEntity = getKBEntity(refId);
          if (refEntity) {
            const refSlug = getKBEntitySlug(refId);
            const href = refSlug && refEntity.type === "organization" ? `/organizations/${refSlug}`
              : refSlug && refEntity.type === "person" ? `/people/${refSlug}`
              : `/kb/entity/${refId}`;
            return (
              <span key={refId}>
                {i > 0 && ", "}
                <Link href={href} className="text-primary hover:underline">
                  {refEntity.name}
                </Link>
              </span>
            );
          }
          return (
            <span key={refId}>
              {i > 0 && ", "}
              {refId}
            </span>
          );
        })}
      </span>
    );
  }
  return <span>{formatKBFactValue(fact, property?.unit, property?.display)}</span>;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums tracking-tight">
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-muted-foreground/50 mt-1">{sub}</div>
      )}
    </div>
  );
}

/** Section header with optional count badge and divider. */
function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {count != null && (
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
    </div>
  );
}

// ── Fact sidebar helpers ──────────────────────────────────────────────

const FACT_CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "financial", label: "Financial", order: 0 },
  { id: "product", label: "Products & Usage", order: 1 },
  { id: "organization", label: "Organization", order: 2 },
  { id: "safety", label: "Safety & Research", order: 3 },
  { id: "people", label: "People", order: 4 },
  { id: "other", label: "Other", order: 99 },
];

/** Group facts by property, taking only the latest per property. */
function getLatestFactsByProperty(
  facts: Fact[],
): Map<string, Fact> {
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

// ── Hero stat properties for org pages ────────────────────────────────
const HERO_STATS = ["revenue", "valuation", "headcount", "total-funding", "founded-date"];

// ── Org type labels / colors ──────────────────────────────────────────

const ORG_TYPE_LABELS: Record<string, string> = {
  "frontier-lab": "Frontier Lab",
  "safety-org": "Safety Org",
  academic: "Academic",
  startup: "Startup",
  generic: "Lab",
  funder: "Funder",
  government: "Government",
};

const ORG_TYPE_COLORS: Record<string, string> = {
  "frontier-lab": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "safety-org":
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  academic:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  startup:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  generic:
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  funder:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  government:
    "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

// ── Main page ─────────────────────────────────────────────────────────

export default async function OrgProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  if (!entity) return notFound();

  // Use URL slug directly — typed entities are keyed by slug, not KB internal IDs
  const typedEntity = getTypedEntityById(slug);
  const orgData = typedEntity && isOrganization(typedEntity) ? typedEntity : null;
  const orgType = orgData?.orgType ?? null;

  // Header facts
  const hqFact = getKBLatest(entity.id, "headquarters");

  // All facts for the sidebar
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

  // Fact sidebar data
  const latestByProp = getLatestFactsByProperty(allFacts);
  const categoryGroups = groupByCategory([...latestByProp.keys()]);

  // Description and website come from typed entity YAML data
  const descriptionText = orgData?.description ?? null;
  const websiteUrl = orgData?.website ?? null;

  // Headquarters text
  const hqText =
    hqFact?.value.type === "text" ? hqFact.value.value : null;

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          { label: entity.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {entity.name}
          </h1>
          {orgType && (
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                ORG_TYPE_COLORS[orgType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {ORG_TYPE_LABELS[orgType] ?? orgType}
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

        {/* Metadata row */}
        <div className="flex items-center gap-4 text-sm flex-wrap">
          {websiteUrl && (
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              {shortDomain(websiteUrl)}{" "}
              &#8599;
            </a>
          )}
          {hqText && (
            <span className="text-muted-foreground">
              HQ: {hqText}
            </span>
          )}
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {HERO_STATS.map((propId) => {
          const fact = getKBLatest(entity.id, propId);
          if (!fact) return null;
          const prop = getKBProperty(propId);
          return (
            <StatCard
              key={propId}
              label={prop?.name ?? titleCase(propId)}
              value={<FactValueDisplay fact={fact} property={prop} />}
              sub={fact.asOf ? `as of ${formatKBDate(fact.asOf)}` : undefined}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-8">
          {/* Facts sidebar data displayed as main content when no records */}
          {allFacts.length > 0 && (
            <section>
              <SectionHeader title="Facts" count={latestByProp.size} />
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
                              <FactValueDisplay fact={fact} property={property} />
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

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Quick links */}
          {allFacts.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Quick Links
              </h2>
              <div className="flex flex-col gap-2">
                <Link
                  href={`/kb/entity/${entity.id}`}
                  className="text-xs text-primary hover:underline"
                >
                  View all facts in KB explorer &rarr;
                </Link>
                {wikiHref && (
                  <Link
                    href={wikiHref}
                    className="text-xs text-primary hover:underline"
                  >
                    Wiki page &rarr;
                  </Link>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
