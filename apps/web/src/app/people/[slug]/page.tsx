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
import { ResourceLink } from "@components/wiki/ResourceLink";
import { formatKBDate } from "@/components/wiki/kb/format";

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
  const publications: Array<{ key: string; fields: Record<string, unknown> }> = [];
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

  // Sort publications by year (most recent first)
  const sortedPubs = [...publications].sort((a, b) => {
    const ya = a.fields.year ? Number(a.fields.year) : 0;
    const yb = b.fields.year ? Number(b.fields.year) : 0;
    return yb - ya;
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

          {/* Notable Publications */}
          {sortedPubs.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Notable Publications
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sortedPubs.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {sortedPubs.map((pub) => {
                  const title = fieldStr(pub.fields, "title") ?? pub.key;
                  const year = pub.fields.year ? Number(pub.fields.year) : null;
                  const url = fieldStr(pub.fields, "url");
                  const resourceId = fieldStr(pub.fields, "resource");
                  const notes = fieldStr(pub.fields, "notes");

                  return (
                    <div key={pub.key} className="px-5 py-3">
                      <div className="flex items-baseline gap-2">
                        {resourceId ? (
                          <ResourceLink
                            id={resourceId}
                            className="font-semibold text-sm text-primary hover:underline"
                          >
                            {title}
                          </ResourceLink>
                        ) : url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-sm text-primary hover:underline"
                          >
                            {title}
                          </a>
                        ) : (
                          <span className="font-semibold text-sm">{title}</span>
                        )}
                        {year && (
                          <span className="text-xs text-muted-foreground">
                            {year}
                          </span>
                        )}
                      </div>
                      {notes && (
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {notes}
                        </p>
                      )}
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

          {/* Quick facts link */}
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
