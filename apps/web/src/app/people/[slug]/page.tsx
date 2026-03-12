import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  resolvePersonBySlug,
  getPersonSlugs,
  getOrgRolesForPerson,
} from "../people-utils";
import {
  getKBFacts,
  getKBLatest,
  getKBProperty,
  getKBEntity,
  getKBEntitySlug,
} from "@/data/kb";
import {
  resolveEntityRef,
  formatAmount,
  formatDateRange,
  getEntityWikiHref,
  fieldStr,
} from "@/lib/directory-utils";
import {
  ProfileStatCard,
  Breadcrumbs,
  CurrentBadge,
  FounderBadge,
  SourceLink,
  DirectoryEntityLink,
} from "@/components/directory";
import {
  formatKBDate,
  formatKBFactValue,
  titleCase,
} from "@/components/wiki/kb/format";
import type { Fact, Property } from "@longterm-wiki/kb";

export function generateStaticParams() {
  return getPersonSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolvePersonBySlug(slug);
  return {
    title: entity ? `${entity.name} | People` : "Person Not Found",
    description: entity
      ? `Profile for ${entity.name} — roles, career history, and affiliations.`
      : undefined,
  };
}

// ── Fact display helpers ──────────────────────────────────────────────

const FACT_CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "financial", label: "Financial", order: 0 },
  { id: "product", label: "Products & Usage", order: 1 },
  { id: "organization", label: "Organization", order: 2 },
  { id: "safety", label: "Safety & Research", order: 3 },
  { id: "people", label: "People", order: 4 },
  { id: "other", label: "Other", order: 99 },
];

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

// ── Main page ─────────────────────────────────────────────────────────

export default async function PersonProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolvePersonBySlug(slug);
  if (!entity) return notFound();

  // Facts
  const roleFact = getKBLatest(entity.id, "role");
  const employedByFact = getKBLatest(entity.id, "employed-by");
  const bornYearFact = getKBLatest(entity.id, "born-year");
  const netWorthFact = getKBLatest(entity.id, "net-worth");
  const educationFact = getKBLatest(entity.id, "education");
  const notableForFact = getKBLatest(entity.id, "notable-for");
  const socialMediaFact = getKBLatest(entity.id, "social-media");

  // Records removed — these collections now return empty arrays
  const careerHistory: Array<{ key: string; fields: Record<string, unknown> }> = [];
  const boardSeats: Array<{ key: string; fields: Record<string, unknown> }> = [];

  // Reverse lookup: org key-person records referencing this person
  const orgRoles = getOrgRolesForPerson(entity.id);

  // All facts for count
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  // Resolve employer reference
  const employer =
    employedByFact?.value.type === "ref"
      ? resolveEntityRef(employedByFact.value.value)
      : null;

  // Sort career history by start date (most recent first)
  const sortedCareer = [...careerHistory].sort((a, b) => {
    const sa = a.fields.start ? String(a.fields.start) : "";
    const sb = b.fields.start ? String(b.fields.start) : "";
    return sb.localeCompare(sa);
  });

  // Sort org roles: current first, then by start date
  const sortedOrgRoles = [...orgRoles].sort((a, b) => {
    const endA = a.record.fields.end ? 1 : 0;
    const endB = b.record.fields.end ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const sa = a.record.fields.start ? String(a.record.fields.start) : "";
    const sb = b.record.fields.start ? String(b.record.fields.start) : "";
    return sb.localeCompare(sa);
  });

  const wikiHref = getEntityWikiHref(entity);

  // Build stat cards
  const stats: Array<{
    label: string;
    value: string;
    sub?: string;
    href?: string;
  }> = [];

  if (roleFact?.value.type === "text") {
    stats.push({ label: "Current Role", value: roleFact.value.value });
  }
  if (employer) {
    stats.push({
      label: "Organization",
      value: employer.name,
      href: employer.slug
        ? `/organizations/${employer.slug}`
        : `/kb/entity/${employer.id}`,
    });
  }
  if (bornYearFact?.value.type === "number") {
    const age = new Date().getFullYear() - bornYearFact.value.value;
    stats.push({
      label: "Born",
      value: String(bornYearFact.value.value),
      sub: `Age ~${age}`,
    });
  }
  if (netWorthFact?.value.type === "number") {
    stats.push({
      label: "Net Worth",
      value: formatAmount(netWorthFact.value.value) ?? "",
      sub: netWorthFact.asOf
        ? `as of ${formatKBDate(netWorthFact.asOf)}`
        : undefined,
    });
  }

  // Initials for avatar
  const initials = entity.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "People", href: "/people" },
          { label: entity.name },
        ]}
      />

      {/* Header */}
      <div className="flex items-start gap-5 mb-8">
        <div className="shrink-0 w-16 h-16 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-2xl font-bold text-primary/70">
          {initials}
        </div>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight mb-1">
            {entity.name}
          </h1>
          {entity.aliases && entity.aliases.length > 0 && (
            <p className="text-sm text-muted-foreground/70 mb-1">
              Also known as: {entity.aliases.join(", ")}
            </p>
          )}
          {notableForFact?.value.type === "text" && (
            <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
              {notableForFact.value.value}
            </p>
          )}
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
            {socialMediaFact?.value.type === "text" && (
              <span className="text-muted-foreground">
                {socialMediaFact.value.value}
              </span>
            )}
          </div>
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
          {/* Career History Timeline */}
          {sortedCareer.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Career History
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sortedCareer.length} positions
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
                {sortedCareer.map((entry) => {
                  const org = resolveEntityRef(entry.fields.organization);
                  const title = fieldStr(entry.fields, "title");
                  const start = fieldStr(entry.fields, "start");
                  const end = fieldStr(entry.fields, "end");
                  const notes = fieldStr(entry.fields, "notes");
                  const source = fieldStr(entry.fields, "source");

                  return (
                    <div
                      key={entry.key}
                      className="flex gap-4 px-5 py-4 border-b border-border/40 last:border-b-0 group hover:bg-muted/20 transition-colors"
                    >
                      {/* Timeline dot */}
                      <div className="flex flex-col items-center pt-1.5">
                        <div
                          className={`w-3 h-3 rounded-full border-2 shrink-0 transition-colors ${
                            !end
                              ? "border-primary bg-primary/20 group-hover:bg-primary/30"
                              : "border-border bg-card group-hover:border-primary/50"
                          }`}
                        />
                        <div className="w-px flex-1 bg-gradient-to-b from-border/50 to-transparent mt-1" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          {title && (
                            <span className="font-semibold text-sm">
                              {title}
                            </span>
                          )}
                          {!end && <CurrentBadge />}
                        </div>
                        {org && (
                          <div className="text-sm mt-0.5">
                            <DirectoryEntityLink
                              entity={org}
                              basePath="/organizations"
                              className="text-primary hover:underline font-medium"
                            />
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground/60 mt-1">
                          {formatDateRange(start, end)}
                        </div>
                        {notes && (
                          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                            {notes}
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

          {/* Education */}
          {educationFact?.value.type === "text" && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Education
              </h2>
              <div className="border border-border/60 rounded-xl bg-card px-5 py-3">
                <p className="text-sm">{educationFact.value.value}</p>
              </div>
            </section>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Organization Roles (from org key-person records) */}
          {sortedOrgRoles.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Organization Roles
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sortedOrgRoles.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card">
                {sortedOrgRoles.map(({ org, record }) => {
                  const title = fieldStr(record.fields, "title");
                  const start = fieldStr(record.fields, "start");
                  const end = fieldStr(record.fields, "end");
                  const isFounder = !!record.fields.is_founder;
                  const orgSlug = getKBEntitySlug(org.id);

                  return (
                    <div
                      key={`${org.id}-${record.key}`}
                      className="px-4 py-3 border-b border-border/40 last:border-b-0"
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {orgSlug ? (
                          <Link
                            href={`/organizations/${orgSlug}`}
                            className="font-semibold text-sm hover:text-primary transition-colors"
                          >
                            {org.name}
                          </Link>
                        ) : (
                          <span className="font-semibold text-sm">
                            {org.name}
                          </span>
                        )}
                        {isFounder && <FounderBadge />}
                        {!end && <CurrentBadge />}
                      </div>
                      {title && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {title}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground/50 mt-1">
                        {formatDateRange(start, end)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Board Seats */}
          {boardSeats.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Board Seats
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {boardSeats.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card">
                {boardSeats.map((seat) => {
                  const org = resolveEntityRef(seat.fields.organization);
                  const role = fieldStr(seat.fields, "role") ?? "Board Member";
                  const start = fieldStr(seat.fields, "start");
                  const end = fieldStr(seat.fields, "end");

                  return (
                    <div
                      key={seat.key}
                      className="px-4 py-3 border-b border-border/40 last:border-b-0"
                    >
                      <div className="flex items-baseline gap-2">
                        <DirectoryEntityLink
                          entity={org}
                          basePath="/organizations"
                          className="font-semibold text-sm hover:text-primary transition-colors"
                        />
                        <span className="text-xs text-muted-foreground">
                          {role}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground/50 mt-1">
                        {formatDateRange(start, end)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Facts */}
          {allFacts.length > 0 && (() => {
            const latestByProp = getLatestFactsByProperty(allFacts);
            const categoryGroups = groupByCategory([...latestByProp.keys()]);
            return (
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
            );
          })()}
        </div>
      </div>
    </div>
  );
}
