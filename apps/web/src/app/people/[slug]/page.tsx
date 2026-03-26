import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { resolveSlugAlias } from "@/data/factbase";
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
} from "@/data/factbase";
import {
  resolveEntityRef,
  formatAmount,
  getEntityWikiHref,
} from "@/lib/directory-utils";
import {
  ProfileStatCard,
  Breadcrumbs,
  FactsPanel,
  ProfileTabs,
  type ProfileTab,
} from "@/components/directory";
import { formatKBDate } from "@/components/wiki/factbase/format";
import { getPublicationsForPerson, getPersonEntityById, getTypedEntityById, isPerson } from "@/data";
import type { Entity } from "@longterm-wiki/factbase";
import { ExpertPositions } from "./expert-positions";
import { SocialLinks } from "./social-links";
import { CareerHistory } from "./career-history";
import { EducationSection } from "./education-section";
import { PublicationsSection } from "./publications-section";
import { FundingConnections } from "./funding-connections";
import { OrgRoles } from "./org-roles";
import { BoardSeats } from "./board-seats";
import { getPersonPolicyPositions, PolicyPositionsSection } from "./policy-positions";
import { WikiOverview } from "./wiki-overview";

// Allow dynamic rendering of person pages not in generateStaticParams
// (e.g., entities created via tablebase enrichment in the wiki-server DB)
export const dynamicParams = true;

export function generateStaticParams() {
  return getPersonSlugs().map((slug) => ({ slug }));
}

/** Resolve a slug to a person entity (TableBase-first, wiki-server fallback). */
function resolvePersonEntity(slug: string): Entity | undefined {
  const resolved = resolvePersonBySlug(slug);
  if (resolved) {
    return {
      id: resolved.stableId ?? resolved.id,
      stableId: resolved.stableId ?? resolved.id,
      type: "person",
      name: resolved.title,
      wikiId: resolved.wikiId,
      wikiPageId: resolved.wikiId,
    };
  }

  // Fall back to typed entity from database.json (direct slug lookup)
  const typedEntity = getTypedEntityById(slug);
  if (typedEntity && isPerson(typedEntity)) {
    return {
      id: slug,
      stableId: slug,
      type: "person",
      name: typedEntity.title,
      wikiId: typedEntity.wikiId,
      wikiPageId: typedEntity.wikiId,
    };
  }
  return undefined;
}

/** Async fallback: try wiki-server for entities not in local data. */
async function resolvePersonFromServer(slug: string): Promise<Entity | undefined> {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL || process.env.PROD_LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) return undefined;
  try {
    const res = await fetch(`${serverUrl}/api/entities/${encodeURIComponent(slug)}`, {
      headers: {
        ...(process.env.LONGTERMWIKI_SERVER_API_KEY && {
          Authorization: `Bearer ${process.env.LONGTERMWIKI_SERVER_API_KEY}`,
        }),
      },
      next: { revalidate: 300 }, // Cache for 5 minutes
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    if (data.entityType !== "person") return undefined;
    return {
      id: data.id,
      stableId: data.stableId || data.id,
      type: "person",
      name: data.title,
      wikiId: data.wikiId,
      wikiPageId: data.wikiId,
    };
  } catch (e: unknown) {
    // Best-effort fallback — wiki-server may be unreachable during build
    console.warn(`[people] Failed to resolve person "${slug}" from server: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolvePersonEntity(slug) ?? await resolvePersonFromServer(slug);
  if (!entity) return { title: "Person Not Found" };

  const roleFact = getKBLatest(entity.id, "role");
  const employedByFact = getKBLatest(entity.id, "employed-by");
  const roleText =
    roleFact?.value.type === "text" ? roleFact.value.value : null;
  const employerRef =
    employedByFact?.value.type === "ref"
      ? resolveEntityRef(employedByFact.value.value)
      : null;

  let description: string;
  if (roleText && employerRef) {
    description = `Profile for ${entity.name}, ${roleText} at ${employerRef.name} — career history, positions, and publications.`;
  } else if (roleText) {
    description = `Profile for ${entity.name}, ${roleText} — career history, positions, and publications.`;
  } else {
    description = `Profile for ${entity.name} — roles, career history, and affiliations.`;
  }

  return {
    title: `${entity.name} | People`,
    description,
  };
}

export default async function PersonProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolvePersonEntity(slug) ?? await resolvePersonFromServer(slug);
  if (!entity) {
    const canonical = resolveSlugAlias(slug);
    if (canonical) permanentRedirect(`/people/${canonical}`);
    return notFound();
  }

  // Facts
  const roleFact = getKBLatest(entity.id, "role");
  const employedByFact = getKBLatest(entity.id, "employed-by");
  const bornYearFact = getKBLatest(entity.id, "born-year");
  const netWorthFact = getKBLatest(entity.id, "net-worth");
  const educationFact = getKBLatest(entity.id, "education");
  const notableForFact = getKBLatest(entity.id, "notable-for");
  const socialMediaFact = getKBLatest(entity.id, "social-media");
  const websiteFact = getKBLatest(entity.id, "website");
  const googleScholarFact = getKBLatest(entity.id, "google-scholar");
  const githubFact = getKBLatest(entity.id, "github-profile");
  const wikipediaFact = getKBLatest(entity.id, "wikipedia-url");

  // Social links facts for the sidebar component
  const socialLinkFacts = {
    "website": websiteFact,
    "social-media": socialMediaFact,
    "github-profile": githubFact,
    "google-scholar": googleScholarFact,
    "wikipedia-url": wikipediaFact,
  };

  // Expert positions from typed entity (consolidated from experts.yaml at build time)
  const personEntity = getPersonEntityById(slug);
  const positions = personEntity?.positions ?? [];

  // Publications linked to this person (from people-resources.yaml via database.json).
  const publications = getPublicationsForPerson(slug);

  // Reverse lookup: org key-person records referencing this person
  const orgRoles = getOrgRolesForPerson(entity.id);

  // Board seats across all organizations referencing this person
  const boardSeats = getBoardSeatsForPerson(entity.id);

  // Career history from KB records
  const careerHistory = getCareerHistory(entity.id);

  // Funding connections
  const fundingConnections = getFundingConnectionsForPerson(entity.id);

  // Policy positions (reverse lookup: find legislation where this person is a stakeholder)
  const policyPositions = getPersonPolicyPositions(entity.id, entity.name);

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
    suppressHydrationWarning?: boolean;
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
        : undefined,
    });
  }
  if (bornYearFact?.value.type === "number") {
    const age = new Date().getFullYear() - bornYearFact.value.value;
    stats.push({
      label: "Born",
      value: String(bornYearFact.value.value),
      sub: `Age ~${age}`,
      suppressHydrationWarning: true,
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

  // Education text (if available)
  const educationText =
    educationFact?.value.type === "text" ? educationFact.value.value : null;

  // ── Build tabs from available data ──
  const overviewCount =
    positions.length + sortedOrgRoles.length + sortedBoardSeats.length + policyPositions.length + (educationText ? 1 : 0);

  const hasWikiPage = !!entity.wikiId;

  const tabs: ProfileTab[] = [];

  // Overview: expert positions, org roles, board seats, education, wiki excerpt
  tabs.push({
    id: "overview",
    label: "Overview",
    content: (
      <div className="space-y-8">
        <ExpertPositions positions={positions} />
        <PolicyPositionsSection positions={policyPositions} />
        <OrgRoles orgRoles={sortedOrgRoles} />
        <BoardSeats boardSeats={sortedBoardSeats} />
        {educationText && <EducationSection education={educationText} />}
        {overviewCount === 0 && !hasWikiPage && (
          <div className="border border-border/40 border-dashed rounded-xl px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground/60">
              No positions, roles, or education recorded yet.
            </p>
          </div>
        )}
        {hasWikiPage && <WikiOverview wikiId={entity.wikiId!} />}
      </div>
    ),
  });

  // Career history (hidden when empty to avoid unfulfilled expectations)
  if (careerHistory.length > 0) {
    tabs.push({
      id: "career",
      label: "Career",
      count: careerHistory.length,
      content: <CareerHistory careerHistory={careerHistory} />,
    });
  }

  // Publications (only shown when local publication records exist)
  if (publications.length > 0) {
    tabs.push({
      id: "publications",
      label: "Publications",
      count: publications.length,
      content: <PublicationsSection publications={publications} />,
    });
  }

  // Funding connections (hidden when empty to avoid unfulfilled expectations)
  if (fundingConnections.length > 0) {
    tabs.push({
      id: "funding",
      label: "Funding",
      count: fundingConnections.length,
      content: <FundingConnections fundingConnections={fundingConnections} />,
    });
  }

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
              href={`/factbase/entity/${entity.id}`}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              KB data &rarr;
            </Link>
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
        {/* Main content — tabbed */}
        <div className="lg:col-span-2">
          <ProfileTabs tabs={tabs} ariaLabel="Person sections" />
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          <SocialLinks facts={socialLinkFacts} />
          {allFacts.length > 0 && (
            <FactsPanel facts={allFacts} entityId={entity.id} />
          )}
        </div>
      </div>
    </div>
  );
}
