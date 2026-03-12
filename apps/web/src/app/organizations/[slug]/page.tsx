import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import {
  getKBLatest,
  getKBFacts,
  getKBProperty,
} from "@/data/kb";
import { getTypedEntityById, isOrganization } from "@/data";
import {
  formatKBDate,
  titleCase,
  shortDomain,
} from "@/components/wiki/kb/format";
import Link from "next/link";
import {
  Breadcrumbs,
  FactValueDisplay,
  FactsPanel,
} from "@/components/directory";

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

  // All facts for the panel
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

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
          {allFacts.length > 0 && (
            <FactsPanel facts={allFacts} entityId={entity.id} />
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
