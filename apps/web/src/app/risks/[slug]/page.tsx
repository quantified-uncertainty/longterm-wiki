import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { resolveRiskBySlug, getRiskSlugs } from "@/app/risks/risk-utils";
import { getKBEntity, getKBEntitySlug } from "@/data/kb";
import { getTypedEntityById, isRisk } from "@/data";
import { getEntityWikiHref } from "@/lib/directory-utils";
import {
  ProfileStatCard,
  Breadcrumbs,
} from "@/components/directory";
import { titleCase } from "@/components/wiki/kb/format";
import type { RiskEntity } from "@/data/entity-schemas";

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

// ── Severity badge colors ─────────────────────────────────────────────
const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "medium-high": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  catastrophic: "bg-red-200 text-red-900 dark:bg-red-900/40 dark:text-red-200",
};

// ── Helpers to extract display values from entity data ─────────────────

function getLikelihoodDisplay(risk: RiskEntity): string | null {
  if (!risk.likelihood) return null;
  if (typeof risk.likelihood === "string") return titleCase(risk.likelihood);
  const parts: string[] = [];
  if (risk.likelihood.level) parts.push(titleCase(risk.likelihood.level));
  if (risk.likelihood.status) parts.push(`(${risk.likelihood.status})`);
  if (risk.likelihood.display) return risk.likelihood.display;
  return parts.length > 0 ? parts.join(" ") : null;
}

function getTimeframeDisplay(risk: RiskEntity): string | null {
  if (!risk.timeframe) return null;
  if (typeof risk.timeframe === "string") return risk.timeframe;
  if (risk.timeframe.display) return risk.timeframe.display;
  const parts: string[] = [];
  if (risk.timeframe.earliest && risk.timeframe.latest) {
    parts.push(`${risk.timeframe.earliest}--${risk.timeframe.latest}`);
  }
  if (risk.timeframe.median) {
    if (parts.length > 0) {
      parts.push(`(median ${risk.timeframe.median})`);
    } else {
      parts.push(`~${risk.timeframe.median}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

// ── Main page ─────────────────────────────────────────────────────────

export default async function RiskProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveRiskBySlug(slug);
  if (!entity) return notFound();

  // Use the URL slug directly — typed entities are keyed by slug, not KB internal IDs
  const typedEntity = getTypedEntityById(slug);
  const risk = typedEntity && isRisk(typedEntity) ? typedEntity : null;

  const riskCategory = risk?.riskCategory ?? null;
  const descriptionText = risk?.description ?? null;

  const wikiHref = getEntityWikiHref(entity);

  // Build stat cards from entity data
  const stats: Array<{
    label: string;
    value: string;
    sub?: string;
  }> = [];

  if (risk?.severity) {
    stats.push({ label: "Severity", value: titleCase(risk.severity) });
  }
  const likelihoodStr = risk ? getLikelihoodDisplay(risk) : null;
  if (likelihoodStr) {
    stats.push({ label: "Likelihood", value: likelihoodStr });
  }
  const timeframeStr = risk ? getTimeframeDisplay(risk) : null;
  if (timeframeStr) {
    stats.push({ label: "Time Horizon", value: timeframeStr });
  }
  if (risk?.maturity) {
    stats.push({ label: "Maturity", value: risk.maturity });
  }

  // Related entities from YAML data
  const relatedEntries = risk?.relatedEntries ?? [];
  const resolvedRelated = relatedEntries.map((entry) => {
    const kbEntity = getKBEntity(entry.id);
    const entrySlug = kbEntity ? getKBEntitySlug(entry.id) : undefined;
    return {
      id: entry.id,
      type: entry.type,
      relationship: entry.relationship,
      name: kbEntity?.name ?? titleCase(entry.id.replace(/-/g, " ")),
      href: entrySlug && entry.type === "risk"
        ? `/risks/${entrySlug}`
        : entrySlug && entry.type === "organization"
          ? `/organizations/${entrySlug}`
          : entrySlug && entry.type === "person"
            ? `/people/${entrySlug}`
            : kbEntity?.numericId
              ? `/wiki/${kbEntity.numericId}`
              : `/kb/entity/${entry.id}`,
    };
  });

  // Sources from YAML data
  const sources = risk?.sources ?? [];

  // Custom fields from YAML data
  const customFields = risk?.customFields ?? [];

  // Tags
  const tags = risk?.tags ?? [];

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
                RISK_CATEGORY_COLORS[riskCategory] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {RISK_CATEGORY_LABELS[riskCategory] ?? riskCategory}
            </span>
          )}
          {risk?.severity && (
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                SEVERITY_COLORS[risk.severity] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(risk.severity)}
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {stats.map((s) => (
            <ProfileStatCard key={s.label} {...s} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-8">
          {/* Wiki page call-to-action */}
          {wikiHref && (
            <section className="border border-primary/20 rounded-xl bg-primary/5 p-5">
              <h2 className="text-base font-bold tracking-tight mb-2">
                Full Wiki Article
              </h2>
              <p className="text-sm text-muted-foreground mb-3">
                Read the full wiki article for detailed analysis, background, and references.
              </p>
              <Link
                href={wikiHref}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
              >
                Read wiki article &rarr;
              </Link>
            </section>
          )}

          {/* Related Entities */}
          {resolvedRelated.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Related Entities
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {resolvedRelated.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {resolvedRelated.map((rel) => (
                  <div
                    key={rel.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <Link
                        href={rel.href}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        {rel.name}
                      </Link>
                      {rel.relationship && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({rel.relationship})
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 shrink-0">
                      {rel.type}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Sources */}
          {sources.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Sources
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sources.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {sources.map((src, i) => (
                  <div key={i} className="px-4 py-3">
                    <div className="text-sm font-medium">
                      {src.url ? (
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {src.title} &#8599;
                        </a>
                      ) : (
                        <span>{src.title}</span>
                      )}
                    </div>
                    {(src.author || src.date) && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {[src.author, src.date].filter(Boolean).join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Assessment details from entity data */}
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Assessment
            </h2>
            <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
              {risk?.severity && (
                <div className="flex items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground text-xs">Severity</span>
                  <span className="font-medium text-xs">{titleCase(risk.severity)}</span>
                </div>
              )}
              {likelihoodStr && (
                <div className="flex items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground text-xs">Likelihood</span>
                  <span className="font-medium text-xs">{likelihoodStr}</span>
                </div>
              )}
              {timeframeStr && (
                <div className="flex items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground text-xs">Time Horizon</span>
                  <span className="font-medium text-xs">{timeframeStr}</span>
                </div>
              )}
              {risk?.maturity && (
                <div className="flex items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground text-xs">Maturity</span>
                  <span className="font-medium text-xs">{risk.maturity}</span>
                </div>
              )}
              {riskCategory && (
                <div className="flex items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground text-xs">Category</span>
                  <span className="font-medium text-xs">
                    {RISK_CATEGORY_LABELS[riskCategory] ?? riskCategory}
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* Custom fields */}
          {customFields.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Details
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {customFields.map((cf, i) => (
                  <div
                    key={i}
                    className="flex items-baseline justify-between gap-2 px-4 py-2.5 text-sm"
                  >
                    <span className="text-muted-foreground text-xs truncate">
                      {cf.label}
                    </span>
                    <span className="font-medium text-xs text-right shrink-0 max-w-[60%]">
                      {cf.link ? (
                        <a
                          href={cf.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          {cf.value}
                        </a>
                      ) : (
                        cf.value
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Tags
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Quick links */}
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Quick Links
            </h2>
            <div className="flex flex-col gap-2">
              {wikiHref && (
                <Link
                  href={wikiHref}
                  className="text-xs text-primary hover:underline"
                >
                  Wiki page &rarr;
                </Link>
              )}
              <Link
                href={`/kb/entity/${entity.id}`}
                className="text-xs text-primary hover:underline"
              >
                View in KB explorer &rarr;
              </Link>
              <Link
                href="/risks"
                className="text-xs text-primary hover:underline"
              >
                All risks &rarr;
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
