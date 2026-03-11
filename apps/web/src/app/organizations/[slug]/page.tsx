import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import {
  getKBLatest,
  getKBFacts,
  getKBEntity,
  getKBProperty,
  getKBAllRecordCollections,
  resolveKBSlug,
  getKBEntitySlug,
} from "@/data/kb";
import { getEntityById } from "@/data";
import {
  formatKBFactValue,
  formatKBDate,
  formatKBNumber,
  titleCase,
  sortKBRecords,
  shortDomain,
  isUrl,
} from "@/components/wiki/kb/format";
import { KBRecordCollection } from "@/components/wiki/kb/KBRecordCollection";
import type { Fact, Property, RecordEntry } from "@longterm-wiki/kb";
import Link from "next/link";

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

// ── Curated collection names ──────────────────────────────────────────
const CURATED_COLLECTIONS = new Set([
  "funding-rounds",
  "investments",
  "key-persons",
  "products",
  "model-releases",
  "safety-milestones",
  "strategic-partnerships",
]);

// ── Formatting helpers ────────────────────────────────────────────────

function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  return formatKBNumber(num, "USD");
}

/** Safely get a string field from a record, or undefined. */
function field(item: RecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  return String(v);
}

// ── Subcomponents ─────────────────────────────────────────────────────

/** Render a fact value, resolving ref/refs to entity name links. */
function FactValueDisplay({ fact, property }: { fact: Fact; property?: Property }) {
  const v = fact.value;
  if (v.type === "ref") {
    const refEntity = getKBEntity(v.value);
    if (refEntity) {
      const refSlug = resolveEntitySlug(v.value);
      const href = refSlug
        ? refEntity.type === "organization" ? `/organizations/${refSlug}` : `/people/${refSlug}`
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
            const refSlug = resolveEntitySlug(refId);
            const href = refSlug
              ? refEntity.type === "organization" ? `/organizations/${refSlug}` : `/people/${refSlug}`
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

/** Resolve an entity ID back to its YAML slug (for building /people/ or /organizations/ links). */
function resolveEntitySlug(entityId: string): string | undefined {
  return getKBEntitySlug(entityId);
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

/** Section header with optional count badge and divider (matches KB page style). */
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

/** Source link for a record entry. */
function SourceLink({ source }: { source: string | undefined }) {
  if (!source) return null;
  if (isUrl(source)) {
    return (
      <a
        href={source}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] text-primary/50 hover:text-primary hover:underline transition-colors"
      >
        {shortDomain(source)}
      </a>
    );
  }
  return <span className="text-[10px] text-muted-foreground">{source}</span>;
}

function PersonRow({
  name,
  title,
  slug,
  entityType,
  isFounder,
  start,
  end,
  notes,
}: {
  name: string;
  title?: string;
  slug?: string;
  entityType?: string;
  isFounder?: boolean;
  start?: string;
  end?: string;
  notes?: string;
}) {
  const href = slug
    ? entityType === "organization"
      ? `/organizations/${slug}`
      : `/people/${slug}`
    : undefined;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/40 last:border-b-0">
      <div className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xs font-semibold text-primary/70 mt-0.5">
        {name
          .split(/\s+/)
          .map((w) => w[0])
          .filter(Boolean)
          .slice(0, 2)
          .join("")
          .toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {href ? (
            <Link
              href={href}
              className="font-semibold text-sm hover:text-primary transition-colors"
            >
              {name}
            </Link>
          ) : (
            <span className="font-semibold text-sm">{name}</span>
          )}
          {isFounder && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              Founder
            </span>
          )}
        </div>
        {title && (
          <div className="text-xs text-muted-foreground">{title}</div>
        )}
        <div className="text-[10px] text-muted-foreground/50 mt-0.5">
          {start && formatKBDate(start)}
          {end ? ` \u2013 ${formatKBDate(end)}` : start ? " \u2013 present" : ""}
        </div>
        {notes && (
          <div className="text-[10px] text-muted-foreground/50 mt-0.5 line-clamp-2">
            {notes}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Badge helper ──────────────────────────────────────────────────────

function Badge({ children, color }: { children: React.ReactNode; color?: string }) {
  const colorClass =
    color ?? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${colorClass}`}
    >
      {children}
    </span>
  );
}

const SAFETY_LEVEL_COLORS: Record<string, string> = {
  "ASL-2": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "ASL-3": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "ASL-4": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

const MILESTONE_TYPE_COLORS: Record<string, string> = {
  "research-paper":
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "policy-update":
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "safety-eval":
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  "red-team":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
};

// ── Entity ref resolver helper ────────────────────────────────────────

function resolveRefName(
  slug: string | undefined,
  displayName: string | undefined,
): { name: string; href: string | null } {
  if (!slug && !displayName) return { name: "Unknown", href: null };

  if (slug) {
    const entityId = resolveKBSlug(slug);
    const entity = entityId ? getKBEntity(entityId) : null;
    if (entity) {
      const prefix = entity.type === "organization" ? "/organizations" : "/people";
      return { name: entity.name, href: `${prefix}/${slug}` };
    }
  }

  // Fall back to display name or humanized slug
  const fallbackName = displayName ?? (slug ? titleCase(slug) : "Unknown");
  return { name: fallbackName, href: null };
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

  const dbEntity = getEntityById(entity.id);
  const orgType = (dbEntity as { orgType?: string } | undefined)?.orgType;

  // Header facts (description/website come from entity YAML, not KB facts)
  const hqFact = getKBLatest(entity.id, "headquarters");

  // All record collections
  const allCollections = getKBAllRecordCollections(entity.id);

  // Curated collections
  const fundingRounds = allCollections["funding-rounds"] ?? [];
  const keyPersons = allCollections["key-persons"] ?? [];
  const investments = allCollections["investments"] ?? [];
  const products = allCollections["products"] ?? [];
  const modelReleases = allCollections["model-releases"] ?? [];
  const safetyMilestones = allCollections["safety-milestones"] ?? [];
  const strategicPartnerships = allCollections["strategic-partnerships"] ?? [];

  // Other (non-curated) collections with entries
  const otherCollections = Object.entries(allCollections)
    .filter(([name, entries]) => !CURATED_COLLECTIONS.has(name) && entries.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  // All facts for the sidebar
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  // Sort collections by date (most recent first)
  const sortedRounds = sortKBRecords(fundingRounds, "date", false);
  const sortedModels = sortKBRecords(modelReleases, "released", false);
  const sortedMilestones = sortKBRecords(safetyMilestones, "date", false);
  const sortedPartnerships = sortKBRecords(strategicPartnerships, "date", false);

  // Sort key persons: current first, then by start date descending
  const sortedPersons = [...keyPersons].sort((a, b) => {
    const endA = a.fields.end ? 1 : 0;
    const endB = b.fields.end ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const startA = a.fields.start ? String(a.fields.start) : "";
    const startB = b.fields.start ? String(b.fields.start) : "";
    return startB.localeCompare(startA);
  });

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

  // Fact sidebar data
  const latestByProp = getLatestFactsByProperty(allFacts);
  const categoryGroups = groupByCategory([...latestByProp.keys()]);

  // Description and website come from entity YAML (data/entities/organizations.yaml), not KB facts
  const descriptionText = (dbEntity as { description?: string } | undefined)?.description ?? null;
  const websiteUrl = (dbEntity as { website?: string } | undefined)?.website ?? null;

  // Headquarters text
  const hqText =
    hqFact?.value.type === "text" ? hqFact.value.value : null;

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <nav className="text-sm text-muted-foreground mb-4">
        <Link href="/organizations" className="hover:underline">
          Organizations
        </Link>
        <span className="mx-1.5">/</span>
        <span>{entity.name}</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {entity.name}
          </h1>
          {orgType && (
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                ORG_TYPE_COLORS[orgType] ?? "bg-gray-100 text-gray-600"
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

        {/* Metadata row: website, headquarters, links */}
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

      {/* Stat cards — uses FactValueDisplay for proper ref resolution */}
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
          {/* Funding rounds (timeline style like KB page) */}
          {sortedRounds.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <SectionHeader title="Funding History" count={sortedRounds.length} />
                <Link
                  href={`/organizations/${slug}/funding`}
                  className="text-xs text-primary hover:underline shrink-0"
                >
                  View all &rarr;
                </Link>
              </div>
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {sortedRounds.slice(0, 8).map((round) => {
                  const name = field(round, "name") ?? titleCase(round.key);
                  const date = field(round, "date");
                  const raised = round.fields.raised;
                  const valuation = round.fields.valuation;
                  const leadInvestor = field(round, "lead_investor");
                  const instrument = field(round, "instrument");
                  const notes = field(round, "notes");
                  const source = field(round, "source");
                  const leadEntity = leadInvestor ? getKBEntity(leadInvestor) : null;

                  return (
                    <div
                      key={round.key}
                      className="flex gap-4 py-4 border-b border-border/40 last:border-b-0 group/row hover:bg-muted/20 -mx-4 px-4 transition-colors"
                    >
                      {/* Timeline dot */}
                      <div className="flex flex-col items-center pt-1">
                        <div className="w-3 h-3 rounded-full border-2 border-primary/50 bg-card shrink-0 group-hover/row:border-primary transition-colors" />
                        <div className="w-px flex-1 bg-gradient-to-b from-border/50 to-transparent mt-1" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-semibold text-sm">{name}</span>
                          {instrument && (
                            <Badge>{instrument}</Badge>
                          )}
                          {date && (
                            <span className="text-xs text-muted-foreground/70">
                              {formatKBDate(date)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-baseline gap-4 mt-1.5 flex-wrap">
                          {raised != null && (
                            <span className="text-base font-bold tabular-nums tracking-tight">
                              {formatAmount(raised)}
                            </span>
                          )}
                          {valuation != null && (
                            <span className="text-xs text-muted-foreground">
                              at {formatAmount(valuation)} valuation
                            </span>
                          )}
                          {leadInvestor && (
                            <span className="text-xs text-muted-foreground">
                              Led by{" "}
                              {leadEntity ? (
                                <Link
                                  href={`/kb/entity/${leadInvestor}`}
                                  className="text-primary hover:underline"
                                >
                                  {leadEntity.name}
                                </Link>
                              ) : (
                                titleCase(leadInvestor)
                              )}
                            </span>
                          )}
                        </div>
                        {notes && (
                          <div className="text-[10px] text-muted-foreground/50 mt-1.5 line-clamp-2">
                            {notes}
                          </div>
                        )}
                        <SourceLink source={source} />
                      </div>
                    </div>
                  );
                })}
              </div>
              {sortedRounds.length > 8 && (
                <Link
                  href={`/organizations/${slug}/funding`}
                  className="block mt-2 text-xs text-primary hover:underline text-center"
                >
                  +{sortedRounds.length - 8} more rounds
                </Link>
              )}
            </section>
          )}

          {/* Investments (investor participation) */}
          {investments.length > 0 && (
            <section>
              <SectionHeader title="Investor Participation" count={investments.length} />
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {investments.map((inv) => {
                  const investorRef = field(inv, "investor");
                  const { name: investorName, href: investorHref } =
                    resolveRefName(
                      investorRef,
                      inv.displayName ?? field(inv, "display_name"),
                    );
                  const roundName = field(inv, "round_name");
                  const amount = inv.fields.amount;
                  const date = field(inv, "date");
                  const notes = field(inv, "notes");

                  return (
                    <div
                      key={inv.key}
                      className="px-4 py-3"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex-1 min-w-0">
                          {investorHref ? (
                            <Link
                              href={investorHref}
                              className="font-semibold text-sm text-primary hover:underline"
                            >
                              {investorName}
                            </Link>
                          ) : (
                            <span className="font-semibold text-sm">
                              {investorName}
                            </span>
                          )}
                          {roundName && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {roundName}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-sm tabular-nums">
                          {amount != null && (
                            <span className="font-bold">
                              {formatAmount(amount)}
                            </span>
                          )}
                          {date && (
                            <span className="text-xs text-muted-foreground">
                              {formatKBDate(date)}
                            </span>
                          )}
                        </div>
                      </div>
                      {notes && (
                        <div className="text-[10px] text-muted-foreground/50 mt-1 line-clamp-2">
                          {notes}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Model releases */}
          {sortedModels.length > 0 && (
            <section>
              <SectionHeader title="Model Releases" count={sortedModels.length} />
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {sortedModels.map((model) => {
                  const name = field(model, "name") ?? titleCase(model.key);
                  const released = field(model, "released");
                  const safetyLevel = field(model, "safety_level");
                  const description = field(model, "description");
                  const source = field(model, "source");

                  return (
                    <div
                      key={model.key}
                      className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-b-0"
                    >
                      <div className="min-w-[70px] text-xs text-muted-foreground pt-0.5">
                        {released ? formatKBDate(released) : "\u2014"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-medium text-sm">{name}</span>
                          {safetyLevel && (
                            <Badge
                              color={
                                SAFETY_LEVEL_COLORS[safetyLevel] ??
                                "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                              }
                            >
                              {safetyLevel}
                            </Badge>
                          )}
                        </div>
                        {description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {description}
                          </p>
                        )}
                        <SourceLink source={source} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Products (card grid like KB page) */}
          {products.length > 0 && (
            <section>
              <SectionHeader title="Products" count={products.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {products.map((prod) => {
                  const name = field(prod, "name") ?? titleCase(prod.key);
                  const launched = field(prod, "launched");
                  const description = field(prod, "description");
                  const source = field(prod, "source");

                  return (
                    <div
                      key={prod.key}
                      className="group rounded-xl border border-border/60 bg-card p-4 transition-all hover:shadow-md hover:border-border"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-semibold text-sm group-hover:text-primary transition-colors">
                          {name}
                        </span>
                        {launched && (
                          <span className="text-[10px] text-muted-foreground/60">
                            {formatKBDate(launched)}
                          </span>
                        )}
                      </div>
                      {description && (
                        <div className="text-xs text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
                          {description}
                        </div>
                      )}
                      {source && isUrl(source) && (
                        <div className="mt-1.5">
                          <SourceLink source={source} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Safety milestones */}
          {sortedMilestones.length > 0 && (
            <section>
              <SectionHeader title="Safety Milestones" count={sortedMilestones.length} />
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {sortedMilestones.map((ms) => {
                  const name = field(ms, "name") ?? titleCase(ms.key);
                  const date = field(ms, "date");
                  const msType = field(ms, "type");
                  const description = field(ms, "description");
                  const source = field(ms, "source");

                  return (
                    <div key={ms.key} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{name}</span>
                        {msType && (
                          <Badge
                            color={
                              MILESTONE_TYPE_COLORS[msType] ??
                              "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                            }
                          >
                            {titleCase(msType)}
                          </Badge>
                        )}
                        {date && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatKBDate(date)}
                          </span>
                        )}
                      </div>
                      {description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {description}
                        </p>
                      )}
                      <SourceLink source={source} />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Strategic partnerships */}
          {sortedPartnerships.length > 0 && (
            <section>
              <SectionHeader title="Strategic Partnerships" count={sortedPartnerships.length} />
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {sortedPartnerships.map((sp) => {
                  const partnerRef = field(sp, "partner");
                  const { name: partnerName, href: partnerHref } =
                    resolveRefName(partnerRef, sp.displayName);
                  const date = field(sp, "date");
                  const spType = field(sp, "type");
                  const investmentAmount = sp.fields.investment_amount;
                  const computeCommitment = sp.fields.compute_commitment;
                  const notes = field(sp, "notes");
                  const source = field(sp, "source");

                  return (
                    <div key={sp.key} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        {partnerHref ? (
                          <Link
                            href={partnerHref}
                            className="font-semibold text-sm text-primary hover:underline"
                          >
                            {partnerName}
                          </Link>
                        ) : (
                          <span className="font-semibold text-sm">
                            {partnerName}
                          </span>
                        )}
                        {spType && (
                          <Badge>{spType}</Badge>
                        )}
                        {date && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatKBDate(date)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        {investmentAmount != null && (
                          <span>
                            Investment: <span className="font-semibold text-foreground">{formatAmount(investmentAmount)}</span>
                          </span>
                        )}
                        {computeCommitment != null && (
                          <span>
                            Compute: <span className="font-semibold text-foreground">{formatAmount(computeCommitment)}</span>
                          </span>
                        )}
                      </div>
                      {notes && (
                        <div className="text-[10px] text-muted-foreground/50 mt-1 line-clamp-2">
                          {notes}
                        </div>
                      )}
                      <SourceLink source={source} />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Other data (dynamic rendering for non-curated collections) */}
          {otherCollections.length > 0 && (
            <section>
              <SectionHeader title="Other Data" />
              {otherCollections.map(([name]) => (
                <KBRecordCollection
                  key={name}
                  entity={entity.id}
                  collection={name}
                />
              ))}
            </section>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Key People */}
          {sortedPersons.length > 0 && (
            <section>
              <SectionHeader title="Key People" count={sortedPersons.length} />
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {sortedPersons.map((person) => {
                  const personRef = field(person, "person");
                  const personEntityId = personRef
                    ? resolveKBSlug(personRef)
                    : undefined;
                  const personEntity = personEntityId
                    ? getKBEntity(personEntityId)
                    : undefined;
                  const name =
                    field(person, "display_name") ??
                    personEntity?.name ??
                    titleCase(personRef ?? person.key);

                  return (
                    <PersonRow
                      key={person.key}
                      name={name}
                      title={field(person, "title")}
                      slug={personRef}
                      entityType={personEntity?.type}
                      isFounder={!!person.fields.is_founder}
                      start={field(person, "start")}
                      end={field(person, "end")}
                      notes={field(person, "notes")}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* Facts sidebar with FactValueDisplay for proper ref resolution */}
          {allFacts.length > 0 && (
            <section>
              <SectionHeader title="Facts" count={allFacts.length} />
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
      </div>
    </div>
  );
}
