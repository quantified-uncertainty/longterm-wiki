import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  resolvePersonBySlug,
  getPersonSlugs,
  getOrgRolesForPerson,
  getBoardSeatsForPerson,
  getCareerHistory,
  getFundingConnectionsForPerson,
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
  formatCompactCurrency,
} from "@/lib/directory-utils";
import {
  ProfileStatCard,
  Breadcrumbs,
  CurrentBadge,
  FounderBadge,
  FactsPanel,
} from "@/components/directory";
import { formatKBDate } from "@/components/wiki/kb/format";
import { getExpertById, getPublicationsForPerson } from "@/data";
import { ExpertPositions } from "./expert-positions";

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

  // Expert positions from experts.yaml
  const expert = getExpertById(slug);
  const positions = expert?.positions ?? [];

  // Publications linked to this person (from literature.yaml via people-resources.yaml)
  const publications = getPublicationsForPerson(slug);

  // Reverse lookup: org key-person records referencing this person
  const orgRoles = getOrgRolesForPerson(entity.id);

  // Board seats across all organizations referencing this person
  const boardSeats = getBoardSeatsForPerson(entity.id);

  // Career history from KB records (populated via personnel table)
  const careerHistory = getCareerHistory(entity.id);

  // Funding connections (grants via org affiliations or personal grants)
  const fundingConnections = getFundingConnectionsForPerson(entity.id);

  // All facts for count
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  // Resolve employer reference
  const employer =
    employedByFact?.value.type === "ref"
      ? resolveEntityRef(employedByFact.value.value)
      : null;

  // Sort org roles: current first, then by start date
  const sortedOrgRoles = [...orgRoles].sort((a, b) => {
    const endA = a.record.fields.end ? 1 : 0;
    const endB = b.record.fields.end ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const sa = a.record.fields.start ? String(a.record.fields.start) : "";
    const sb = b.record.fields.start ? String(b.record.fields.start) : "";
    return sb.localeCompare(sa);
  });

  // Sort board seats: current first, then by appointment date
  const sortedBoardSeats = [...boardSeats].sort((a, b) => {
    const endA = a.record.fields.departed ? 1 : 0;
    const endB = b.record.fields.departed ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const sa = a.record.fields.appointed
      ? String(a.record.fields.appointed)
      : "";
    const sb = b.record.fields.appointed
      ? String(b.record.fields.appointed)
      : "";
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
          {/* Expert Positions */}
          <ExpertPositions positions={positions} />

          {/* Career Timeline */}
          {careerHistory.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Career History
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {careerHistory.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {careerHistory.map((entry) => {
                  const orgRef = resolveEntityRef(entry.organization);
                  const orgSlug = orgRef
                    ? getKBEntitySlug(orgRef.id)
                    : undefined;
                  const isCurrent = !entry.endDate;
                  const isFounder = /founder/i.test(entry.title);

                  return (
                    <div key={entry.key} className="px-5 py-3.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">
                          {entry.title}
                        </span>
                        {isFounder && <FounderBadge />}
                        {isCurrent && <CurrentBadge />}
                      </div>
                      <div className="text-sm text-muted-foreground mt-0.5">
                        {orgSlug ? (
                          <Link
                            href={`/organizations/${orgSlug}`}
                            className="hover:text-primary transition-colors"
                          >
                            {orgRef?.name ?? entry.organization}
                          </Link>
                        ) : (
                          <span>{orgRef?.name ?? entry.organization}</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground/60 mt-1">
                        {formatDateRange(entry.startDate, entry.endDate)}
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

          {/* Publications & Resources */}
          {publications.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Publications & Resources
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {publications.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {publications
                  .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
                  .map((pub, idx) => (
                    <div
                      key={`${idx}-${pub.title}`}
                      className="px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          {pub.link ? (
                            <a
                              href={pub.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-sm text-foreground hover:text-primary transition-colors"
                            >
                              {pub.title}
                            </a>
                          ) : (
                            <span className="font-medium text-sm">
                              {pub.title}
                            </span>
                          )}
                          <div className="flex items-center gap-2 mt-0.5">
                            {pub.year && (
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {pub.year}
                              </span>
                            )}
                            {pub.type && (
                              <span className="text-xs text-muted-foreground/60">
                                {pub.type}
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground/40">
                              {pub.category}
                            </span>
                          </div>
                        </div>
                        {pub.link && (
                          <a
                            href={pub.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-xs text-muted-foreground/50 hover:text-primary transition-colors"
                            title="Open link"
                          >
                            &rarr;
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* Funding Connections */}
          {fundingConnections.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Funding Connections
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {fundingConnections.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
                {/* Summary stats */}
                {(() => {
                  const totalAmount = fundingConnections.reduce(
                    (sum, c) => sum + (c.amount ?? 0),
                    0,
                  );
                  const gaveCount = fundingConnections.filter(
                    (c) => c.direction === "gave",
                  ).length;
                  const receivedCount = fundingConnections.filter(
                    (c) =>
                      c.direction === "received" || c.direction === "personal",
                  ).length;
                  return (
                    <div className="px-5 py-3 bg-muted/30 border-b border-border/40 flex items-center gap-4 text-xs text-muted-foreground">
                      {totalAmount > 0 && (
                        <span>
                          Total:{" "}
                          <span className="font-semibold text-foreground">
                            {formatCompactCurrency(totalAmount)}
                          </span>
                        </span>
                      )}
                      {gaveCount > 0 && (
                        <span>
                          Gave:{" "}
                          <span className="font-medium">{gaveCount}</span>
                        </span>
                      )}
                      {receivedCount > 0 && (
                        <span>
                          Received:{" "}
                          <span className="font-medium">{receivedCount}</span>
                        </span>
                      )}
                    </div>
                  );
                })()}
                <div className="divide-y divide-border/40">
                  {fundingConnections.slice(0, 20).map((conn) => (
                    <div key={conn.key} className="px-5 py-3.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            conn.direction === "gave"
                              ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                              : conn.direction === "personal"
                                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                                : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                          }`}
                        >
                          {conn.direction === "gave"
                            ? "Funded"
                            : conn.direction === "personal"
                              ? "Received"
                              : "Org received"}
                        </span>
                        <span className="font-semibold text-sm">
                          {conn.name}
                        </span>
                        {conn.amount != null && (
                          <span className="text-sm font-semibold tabular-nums text-foreground">
                            {formatCompactCurrency(conn.amount)}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                        {conn.direction === "gave" && conn.counterparty && (
                          <span>
                            to{" "}
                            {conn.counterparty.href ? (
                              <Link
                                href={conn.counterparty.href}
                                className="hover:text-primary transition-colors"
                              >
                                {conn.counterparty.name}
                              </Link>
                            ) : (
                              conn.counterparty.name
                            )}
                          </span>
                        )}
                        {(conn.direction === "received" ||
                          conn.direction === "personal") &&
                          conn.counterparty && (
                            <span>
                              from{" "}
                              {conn.counterparty.href ? (
                                <Link
                                  href={conn.counterparty.href}
                                  className="hover:text-primary transition-colors"
                                >
                                  {conn.counterparty.name}
                                </Link>
                              ) : (
                                conn.counterparty.name
                              )}
                            </span>
                          )}
                        {conn.viaOrg && (
                          <span className="text-muted-foreground/60">
                            via{" "}
                            {conn.viaOrg.slug ? (
                              <Link
                                href={`/organizations/${conn.viaOrg.slug}`}
                                className="hover:text-primary transition-colors"
                              >
                                {conn.viaOrg.name}
                              </Link>
                            ) : (
                              conn.viaOrg.name
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground/60">
                        {conn.date && <span>{conn.date}</span>}
                        {conn.program && (
                          <span className="text-muted-foreground/40">
                            {conn.program}
                          </span>
                        )}
                        {conn.status && (
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                              conn.status === "active"
                                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                                : conn.status === "completed"
                                  ? "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300"
                                  : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {conn.status}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {fundingConnections.length > 20 && (
                  <div className="px-5 py-3 border-t border-border/40 text-center">
                    <span className="text-xs text-muted-foreground">
                      Showing 20 of {fundingConnections.length} connections
                    </span>
                  </div>
                )}
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
          {sortedBoardSeats.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Board Seats
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sortedBoardSeats.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card">
                {sortedBoardSeats.map(({ org, record }) => {
                  const role = fieldStr(record.fields, "role");
                  const appointed = fieldStr(record.fields, "appointed");
                  const departed = fieldStr(record.fields, "departed");
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
                        {!departed && <CurrentBadge />}
                      </div>
                      {role && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {role}
                        </div>
                      )}
                      <div className="text-[10px] text-muted-foreground/50 mt-1">
                        {formatDateRange(appointed, departed)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Facts */}
          {allFacts.length > 0 && (
            <FactsPanel facts={allFacts} entityId={entity.id} />
          )}
        </div>
      </div>
    </div>
  );
}
