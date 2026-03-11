import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "../org-utils";
import { getKBLatest, getKBRecords, getKBFacts, getKBEntitySlug } from "@/data/kb";
import { getEntityById } from "@/data";
import { formatKBFactValue, formatKBDate } from "@/components/wiki/kb/format";
import type { Fact, RecordEntry } from "@longterm-wiki/kb";
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

function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  if (num >= 1e12) return `$${(num / 1e12).toFixed(1)}T`;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(0)}M`;
  return `$${num.toLocaleString()}`;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
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

function PersonRow({
  name,
  title,
  entityId,
  isFounder,
  start,
  end,
}: {
  name: string;
  title?: string;
  entityId?: string;
  isFounder?: boolean;
  start?: string;
  end?: string;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/40 last:border-b-0">
      <div className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xs font-semibold text-primary/70">
        {name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {entityId ? (
            <Link
              href={`/kb/entity/${entityId}`}
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
      </div>
      <div className="text-[10px] text-muted-foreground/50 whitespace-nowrap">
        {start && formatKBDate(start)}
        {end ? ` \u2013 ${formatKBDate(end)}` : start ? " \u2013 present" : ""}
      </div>
    </div>
  );
}

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

  // Key metrics
  const revenueFact = getKBLatest(entity.id, "revenue");
  const valuationFact = getKBLatest(entity.id, "valuation");
  const headcountFact = getKBLatest(entity.id, "headcount");
  const totalFundingFact = getKBLatest(entity.id, "total-funding");
  const foundedFact = getKBLatest(entity.id, "founded-date");

  // Records
  const fundingRounds = getKBRecords(entity.id, "funding-rounds");
  const keyPersons = getKBRecords(entity.id, "key-persons");
  const investments = getKBRecords(entity.id, "investments");
  const products = getKBRecords(entity.id, "products");

  // All facts for the sidebar
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

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
    "safety-org": "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
    academic: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
    startup: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    generic: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
    funder: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    government: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  };

  // Build stat cards
  const stats: Array<{ label: string; value: string; sub?: string }> = [];
  if (revenueFact?.value.type === "number") {
    stats.push({
      label: "Revenue",
      value: formatAmount(revenueFact.value.value) ?? "",
      sub: revenueFact.asOf ? `as of ${formatKBDate(revenueFact.asOf)}` : undefined,
    });
  }
  if (valuationFact?.value.type === "number") {
    stats.push({
      label: "Valuation",
      value: formatAmount(valuationFact.value.value) ?? "",
      sub: valuationFact.asOf ? `as of ${formatKBDate(valuationFact.asOf)}` : undefined,
    });
  }
  if (headcountFact?.value.type === "number") {
    stats.push({
      label: "Headcount",
      value: headcountFact.value.value.toLocaleString(),
      sub: headcountFact.asOf ? `as of ${formatKBDate(headcountFact.asOf)}` : undefined,
    });
  }
  if (totalFundingFact?.value.type === "number") {
    stats.push({
      label: "Total Funding",
      value: formatAmount(totalFundingFact.value.value) ?? "",
    });
  }
  if (foundedFact) {
    const foundedValue =
      foundedFact.value.type === "date"
        ? foundedFact.value.value
        : foundedFact.value.type === "number"
          ? String(foundedFact.value.value)
          : foundedFact.value.type === "text"
            ? foundedFact.value.value
            : null;
    if (foundedValue) {
      stats.push({ label: "Founded", value: formatKBDate(foundedValue) });
    }
  }

  // Sort funding rounds by date
  const sortedRounds = [...fundingRounds].sort((a, b) => {
    const da = a.fields.date ? String(a.fields.date) : "";
    const db = b.fields.date ? String(b.fields.date) : "";
    return db.localeCompare(da);
  });

  // Sort key persons: current first, then by start date
  const sortedPersons = [...keyPersons].sort((a, b) => {
    const endA = a.fields.end ? 1 : 0;
    const endB = b.fields.end ? 1 : 0;
    if (endA !== endB) return endA - endB; // current first
    const startA = a.fields.start ? String(a.fields.start) : "";
    const startB = b.fields.start ? String(b.fields.start) : "";
    return startB.localeCompare(startA);
  });

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

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
        <div className="flex items-center gap-4 text-sm">
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
            <StatCard key={s.label} {...s} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-8">
          {/* Funding rounds */}
          {sortedRounds.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold tracking-tight">
                  Funding History
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {sortedRounds.length} rounds
                  </span>
                </h2>
                <Link
                  href={`/organizations/${slug}/funding`}
                  className="text-xs text-primary hover:underline"
                >
                  View all &rarr;
                </Link>
              </div>
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {sortedRounds.slice(0, 5).map((round) => {
                  const name =
                    (round.fields.name as string) ?? round.key;
                  const date = round.fields.date
                    ? String(round.fields.date)
                    : null;
                  const raised = round.fields.raised;
                  const valuation = round.fields.valuation;

                  return (
                    <div
                      key={round.key}
                      className="flex items-center gap-4 px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-sm">{name}</span>
                        {date && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {formatKBDate(date)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-sm tabular-nums">
                        {raised != null && (
                          <span className="font-bold">
                            {formatAmount(raised)}
                          </span>
                        )}
                        {valuation != null && (
                          <span className="text-muted-foreground text-xs">
                            at {formatAmount(valuation)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {sortedRounds.length > 5 && (
                <Link
                  href={`/organizations/${slug}/funding`}
                  className="block mt-2 text-xs text-primary hover:underline text-center"
                >
                  +{sortedRounds.length - 5} more rounds
                </Link>
              )}
            </section>
          )}

          {/* Investments (if this org is an investor) */}
          {investments.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Investments
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {investments.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {investments.map((inv) => {
                  const investee = inv.fields.investee
                    ? String(inv.fields.investee)
                    : null;
                  const round = inv.fields.round
                    ? String(inv.fields.round)
                    : null;
                  const amount = inv.fields.amount;
                  const date = inv.fields.date
                    ? String(inv.fields.date)
                    : null;

                  return (
                    <div
                      key={inv.key}
                      className="flex items-center gap-4 px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        {investee && (
                          <span className="font-semibold text-sm">
                            {investee}
                          </span>
                        )}
                        {round && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {round}
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
                  );
                })}
              </div>
            </section>
          )}

          {/* Products */}
          {products.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Products
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {products.length}
                </span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {products.map((prod) => (
                  <div
                    key={prod.key}
                    className="rounded-xl border border-border/60 bg-card p-4"
                  >
                    <div className="font-semibold text-sm">
                      {(prod.fields.name as string) ?? prod.key}
                    </div>
                    {prod.fields.launched != null && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Launched {formatKBDate(String(prod.fields.launched))}
                      </div>
                    )}
                    {prod.fields.description != null && (
                      <div className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
                        {String(prod.fields.description)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Sidebar: Key People */}
        <div className="space-y-8">
          {sortedPersons.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Key People
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sortedPersons.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {sortedPersons.map((person) => {
                  const personId = person.fields.person
                    ? String(person.fields.person)
                    : undefined;
                  const name =
                    (person.fields.display_name as string) ??
                    (personId
                      ? person.fields.person
                        ? String(person.fields.person)
                            .replace(/-/g, " ")
                            .replace(/\b\w/g, (c) => c.toUpperCase())
                        : undefined
                      : undefined) ??
                    person.key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

                  return (
                    <PersonRow
                      key={person.key}
                      name={name}
                      title={person.fields.title ? String(person.fields.title) : undefined}
                      entityId={personId}
                      isFounder={!!person.fields.is_founder}
                      start={person.fields.start ? String(person.fields.start) : undefined}
                      end={person.fields.end ? String(person.fields.end) : undefined}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* Quick facts */}
          {allFacts.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Facts
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {allFacts.length}
                </span>
              </h2>
              <Link
                href={`/kb/entity/${entity.id}`}
                className="text-xs text-primary hover:underline"
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
