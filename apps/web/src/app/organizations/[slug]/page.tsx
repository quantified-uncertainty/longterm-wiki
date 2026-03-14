import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import { resolveSlugAlias } from "@/data/kb";
import {
  getKBLatest,
  getKBProperty,
  resolveKBSlug,
  getKBEntity,
} from "@/data/kb";
import {
  formatKBDate,
  titleCase,
  shortDomain,
} from "@/components/wiki/kb/format";
import { formatCompactCurrency } from "@/lib/format-compact";
import Link from "next/link";
import {
  Breadcrumbs,
  FactValueDisplay,
  FactsPanel,
} from "@/components/directory";
import { RelatedPages } from "@/components/RelatedPages";

// Shared components & helpers
import {
  StatCard,
  SectionHeader,
  PeopleTable,
  field,
  safeHref,
} from "./org-shared";

// Data loading & constants
import {
  loadOrgPageData,
  resolveAuthor,
  HERO_STATS,
  ORG_TYPE_LABELS,
  ORG_TYPE_COLORS,
  DEFAULT_ORG_TYPE_COLOR,
} from "./org-data";
import type { AuthorRef } from "./org-data";

// Section components
import { RelatedOrganizationsSection } from "./related-orgs-section";
import { EquityPositionsSection } from "./equity-section";
import { DivisionsSection } from "./divisions-section";
import { FundingProgramsSection } from "./programs-section";
import { AiModelsSection } from "./ai-models-section";
import { PolicyPositionsSection, getOrgPolicyPositions } from "./policy-positions-section";

// Section components — publications
import { KeyPublicationsSection } from "./publications-section";

// Section components — grants (main content column)
import { GrantsSection } from "./grants-section";

// Section components — resources
import { OrgResourcesSection } from "./resources-section";

// Section components — main content column
import {
  FundingHistorySection,
  InvestorParticipationSection,
  ProductsSection,
  SafetyMilestonesSection,
  StrategicPartnershipsSection,
  OtherDataSection,
} from "./main-content-sections";

// Charts
import { ChartsSection } from "./charts-section";

// Client-side tabs
import { OrgProfileTabs, type OrgTab } from "./org-tabs";

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

// ── Main page ─────────────────────────────────────────────────────────

export default async function OrgProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  if (!entity) {
    const canonical = resolveSlugAlias(slug);
    if (canonical) permanentRedirect(`/organizations/${canonical}`);
    return notFound();
  }

  const data = loadOrgPageData(entity, slug);

  // ── Build tabs from available data ──────────────────────────────────

  const tabs: OrgTab[] = [];

  // ── Build stat cards for Overview ──
  const heroStatCards = HERO_STATS.map((propId) => {
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
  }).filter(Boolean);

  // Add grants made stat (for funders)
  if (data.totalGrantsMade > 0) {
    heroStatCards.push(
      <StatCard
        key="grants-made"
        label="Grants Made"
        value={<span>{formatCompactCurrency(data.totalGrantsMade)}</span>}
        sub={`${data.grantsMade.length} ${data.grantsMade.length === 1 ? "grant" : "grants"}`}
      />
    );
  }
  // Add AI models count
  if (data.orgModels.length > 0) {
    heroStatCards.push(
      <StatCard
        key="ai-models"
        label="AI Models"
        value={<span>{data.orgModels.length}</span>}
      />
    );
  }

  // ── Overview tab: stat cards, facts, related wiki pages, related orgs ──
  const overviewContent = (
    <div className="space-y-8">
      {/* Stat cards */}
      {heroStatCards.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {heroStatCards}
        </div>
      )}

      {/* Charts */}
      <ChartsSection chartData={data.chartData} orgName={entity.name} dilutionStages={data.dilutionStages} />

      {/* Facts + Other Data */}
      {(data.allFacts.length > 0 || data.otherCollections.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {data.allFacts.length > 0 && (
            <FactsPanel facts={data.allFacts} entityId={entity.id} />
          )}
          {data.otherCollections.length > 0 && (
            <OtherDataSection collections={data.otherCollections} entityId={entity.id} />
          )}
        </div>
      )}

      {/* Related Orgs */}
      {data.relatedOrgs.length > 0 && (
        <RelatedOrganizationsSection orgs={data.relatedOrgs} />
      )}

      {/* Related Wiki Pages */}
      <RelatedPages entityId={slug} entity={{ type: "organization" }} />
    </div>
  );

  tabs.push({ id: "overview", label: "Overview", content: overviewContent });

  // ── People tab: key personnel + board of directors ──
  const hasPeopleData =
    data.sortedPersons.length > 0 || data.boardMembers.length > 0;

  if (hasPeopleData) {
    // Build unified people list from key-persons + board members, deduplicating
    const peopleByName = new Map<string, {
      name: string;
      title?: string;
      slug?: string;
      entityType?: string;
      isFounder: boolean;
      isBoard: boolean;
      isCurrent: boolean;
      start?: string;
      end?: string;
    }>();

    // Add key persons first
    for (const person of data.sortedPersons) {
      const personRef = field(person, "person");
      const personEntityId = personRef ? resolveKBSlug(personRef) : undefined;
      const personEntity = personEntityId ? getKBEntity(personEntityId) : undefined;
      const name =
        field(person, "display_name") ??
        personEntity?.name ??
        titleCase(personRef ?? person.key);
      peopleByName.set(name, {
        name,
        title: field(person, "title"),
        slug: personRef,
        entityType: personEntity?.type,
        isFounder: !!person.fields.is_founder,
        isBoard: false,
        isCurrent: !person.fields.end,
        start: field(person, "start"),
        end: field(person, "end"),
      });
    }

    // Merge board members — if already present, just add board flag
    for (const bm of data.boardMembers) {
      const existing = peopleByName.get(bm.personName);
      if (existing) {
        existing.isBoard = true;
      } else {
        peopleByName.set(bm.personName, {
          name: bm.personName,
          title: bm.role ?? "Board Member",
          slug: bm.personHref?.replace(/^\/(people|organizations)\//, ""),
          entityType: bm.personHref?.startsWith("/people") ? "person" : undefined,
          isFounder: false,
          isBoard: true,
          isCurrent: !bm.departed,
          start: bm.appointed ?? undefined,
          end: bm.departed ?? undefined,
        });
      }
    }

    const allPeople = [...peopleByName.values()].sort((a, b) => {
      // Current before former
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      // Founders first
      if (a.isFounder !== b.isFounder) return a.isFounder ? -1 : 1;
      // Then alphabetical
      return a.name.localeCompare(b.name);
    });

    tabs.push({
      id: "people",
      label: "People",
      count: allPeople.length,
      content: (
        <section>
          <SectionHeader title="People" count={allPeople.length} />
          <PeopleTable people={allPeople} />
        </section>
      ),
    });
  }

  // ── Funding tab: rounds, investments, equity, grants, programs ──
  // Filter out founding-round entries with no amount (these are founders, not investors)
  const meaningfulInvestments = data.investments.filter((inv) => {
    const roundName = typeof inv.fields.round_name === "string" ? inv.fields.round_name.toLowerCase() : "";
    const hasAmount = inv.fields.amount != null;
    if (roundName === "founding" && !hasAmount) return false;
    return true;
  });

  // Filter equity positions to only those with a resolved holder name
  const meaningfulEquity = data.equityPositions.filter((pos) => pos.holderName && pos.holderName !== "");

  const hasFundingData =
    data.sortedRounds.length > 0 ||
    meaningfulInvestments.length > 0 ||
    meaningfulEquity.length > 0 ||
    data.grantsReceived.length > 0 ||
    data.grantsMade.length > 0 ||
    data.sortedPartnerships.length > 0 ||
    data.fundingPrograms.length > 0;

  if (hasFundingData) {
    const fundingCount =
      data.sortedRounds.length +
      meaningfulInvestments.length +
      data.sortedPartnerships.length +
      data.grantsMade.length +
      data.grantsReceived.length;

    tabs.push({
      id: "funding",
      label: "Funding",
      count: fundingCount,
      content: (
        <div className="space-y-8">
          <FundingHistorySection rounds={data.sortedRounds} />

          {(meaningfulInvestments.length > 0 || meaningfulEquity.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {meaningfulInvestments.length > 0 && (
                <InvestorParticipationSection investments={meaningfulInvestments} />
              )}
              {meaningfulEquity.length > 0 && (
                <EquityPositionsSection positions={meaningfulEquity} />
              )}
            </div>
          )}

          {data.grantsMade.length > 0 && (
            <GrantsSection
              grants={data.grantsMade}
              direction="given"
              entityId={entity.id}
            />
          )}
          {data.grantsReceived.length > 0 && (
            <GrantsSection
              grants={data.grantsReceived}
              direction="received"
            />
          )}

          {data.sortedPartnerships.length > 0 && (
            <StrategicPartnershipsSection partnerships={data.sortedPartnerships} />
          )}

          {data.fundingPrograms.length > 0 && (
            <FundingProgramsSection programs={data.fundingPrograms} />
          )}
        </div>
      ),
    });
  }

  // ── Products & Models tab ──
  const hasProductData =
    data.products.length > 0 ||
    data.orgModels.length > 0;

  if (hasProductData) {
    const productCount = data.products.length + data.orgModels.length;

    tabs.push({
      id: "products",
      label: "Products & Models",
      count: productCount,
      content: (
        <div className="space-y-8">
          <AiModelsSection models={data.orgModels} benchmarksByModel={data.modelBenchmarks} />
          <ProductsSection products={data.products} />
        </div>
      ),
    });
  }

  // ── Safety tab (milestones — renamed from "Research & Safety" since papers are in Publications) ──
  const hasSafetyData = data.sortedMilestones.length > 0;

  if (hasSafetyData) {
    tabs.push({
      id: "safety",
      label: "Safety",
      count: data.sortedMilestones.length,
      content: (
        <div className="space-y-8">
          <SafetyMilestonesSection milestones={data.sortedMilestones} />
        </div>
      ),
    });
  }

  // ── Publications tab (research papers + literature papers, deduplicated) ──
  // Deduplicate key publications that already appear in the resources table (by title match)
  const resourcePubTitles = new Set(
    data.resourcePublications.map((r) => r.title.toLowerCase().trim()),
  );
  const dedupedKeyPubs = data.keyPublications.filter(
    (p) => !resourcePubTitles.has(p.title.toLowerCase().trim()),
  );

  // Build resolved author map for key publications author linking
  const keyPubAuthorMap = new Map<string, AuthorRef>();
  for (const pub of dedupedKeyPubs) {
    for (const name of pub.authors) {
      if (!keyPubAuthorMap.has(name)) {
        keyPubAuthorMap.set(name, resolveAuthor(name));
      }
    }
  }

  const hasPublications = data.resourcePublications.length > 0 || dedupedKeyPubs.length > 0;
  if (hasPublications) {
    const pubCount = data.resourcePublications.length + dedupedKeyPubs.length;
    tabs.push({
      id: "publications",
      label: "Publications",
      count: pubCount,
      content: (
        <div className="space-y-8">
          {data.resourcePublications.length > 0 && (
            <OrgResourcesSection
              resources={data.resourcePublications}
              title="Research & Technical Papers"
              emptyMessage=""
            />
          )}
          {dedupedKeyPubs.length > 0 && (
            <KeyPublicationsSection
              publications={dedupedKeyPubs}
              resolvedAuthors={keyPubAuthorMap}
            />
          )}
        </div>
      ),
    });
  }

  // ── Announcements tab (news, blog posts, other org content) ──
  if (data.resourceAnnouncements.length > 0) {
    tabs.push({
      id: "announcements",
      label: "Announcements",
      count: data.resourceAnnouncements.length,
      content: (
        <OrgResourcesSection
          resources={data.resourceAnnouncements}
          title="News & Announcements"
          emptyMessage=""
        />
      ),
    });
  }

  // ── Coverage tab (external resources about the org) ──
  if (data.resourcesAboutOrg.length > 0) {
    tabs.push({
      id: "coverage",
      label: "Coverage",
      count: data.resourcesAboutOrg.length,
      content: (
        <OrgResourcesSection
          resources={data.resourcesAboutOrg}
          title="External Coverage & References"
          emptyMessage=""
        />
      ),
    });
  }

  // ── Structure tab (divisions only — funding programs are in Funding) ──
  if (data.divisions.length > 0) {
    tabs.push({
      id: "structure",
      label: "Structure",
      count: data.divisions.length,
      content: (
        <div className="space-y-8">
          <DivisionsSection divisions={data.divisions} leadResolved={data.divisionLeadResolved} />
        </div>
      ),
    });
  }

  // ── Policy Positions tab ──
  const policyPositions = getOrgPolicyPositions(entity.id, entity.name);
  if (policyPositions.length > 0) {
    tabs.push({
      id: "policy",
      label: "Policy Positions",
      count: policyPositions.length,
      content: (
        <PolicyPositionsSection positions={policyPositions} />
      ),
    });
  }

  // ── Initials for avatar (skip stop words like "and", "the", "of", "for") ──
  const STOP_WORDS = new Set(["and", "the", "of", "for", "in", "on", "at"]);
  const initials = entity.name
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, ""))
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          { label: entity.name },
        ]}
      />

      {/* ── Compact Header ─────────────────────────────────────── */}
      <div className="mb-6">
        <div className="flex items-start gap-5">
          {/* Org avatar/icon */}
          <div className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xl font-bold text-primary/70" aria-hidden="true">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h1 className="text-2xl font-extrabold tracking-tight">
                {entity.name}
              </h1>
              {data.orgType && (
                <Link
                  href={`/organizations?type=${data.orgType}`}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider hover:opacity-80 transition-opacity ${
                    ORG_TYPE_COLORS[data.orgType] ?? DEFAULT_ORG_TYPE_COLOR
                  }`}
                >
                  {ORG_TYPE_LABELS[data.orgType] ?? data.orgType}
                </Link>
              )}
            </div>
            {entity.aliases && entity.aliases.length > 0 && (
              <p className="text-xs text-muted-foreground/70 mb-0.5">
                Also known as: {entity.aliases.join(", ")}
              </p>
            )}

            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              {data.foundedDateStr && (
                <span>
                  Founded {formatKBDate(data.foundedDateStr)}
                  {data.orgAge && <span suppressHydrationWarning> ({data.orgAge})</span>}
                </span>
              )}
              {data.hqText && <span>HQ: {data.hqText}</span>}
              {data.websiteUrl && (
                <a
                  href={safeHref(data.websiteUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 font-medium transition-colors"
                >
                  {shortDomain(data.websiteUrl)} &#8599;
                </a>
              )}
              {data.wikiHref && (
                <Link href={data.wikiHref} className="text-primary hover:text-primary/80 font-medium transition-colors">
                  Wiki page &rarr;
                </Link>
              )}
              <Link href={`/kb/entity/${entity.id}`} className="text-primary hover:text-primary/80 font-medium transition-colors">
                KB data &rarr;
              </Link>
            </div>

            {data.founders.length > 0 && (
              <p className="text-sm text-muted-foreground mt-1">
                Founded by{" "}
                {data.founders.map((f, i) => (
                  <span key={i}>
                    {i > 0 && (i === data.founders.length - 1 ? ", and " : ", ")}
                    {f.href ? (
                      <Link href={f.href} className="text-primary hover:underline">{f.name}</Link>
                    ) : (
                      f.name
                    )}
                  </span>
                ))}
              </p>
            )}

            {data.descriptionText && (
              <p className="text-sm text-muted-foreground leading-relaxed mt-1 max-w-prose line-clamp-3">
                {data.descriptionText}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Tabbed content ─────────────────────────────────────── */}
      <OrgProfileTabs tabs={tabs} />
    </div>
  );
}
