import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import { getTypedEntityById, getTypedEntityByStableId, getTypedEntities, isOrganization, isProject } from "@/data";
import { getRecordVerdict } from "@data/tablebase";
import { SourceCheckDot } from "@/components/source-check/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/source-check/source-check-status";
import { getSourceCheckHref } from "@/app/source-checks/source-checks-shared";
import { isSid } from "@/lib/stable-id";
import {
  getKBLatest,
  getKBProperty,
  resolveKBSlug,
  getKBEntitySlug,
} from "@/data/factbase";
import {
  formatKBDate,
  titleCase,
  shortDomain,
} from "@/components/wiki/factbase/format";
import { formatCompactCurrency } from "@/lib/format-compact";
import Link from "next/link";
import {
  FactValueDisplay,
  FactsPanel,
} from "@/components/directory";

import { OrgProfileHeader } from "./org-profile-header";
import { RelatedPages } from "@/components/RelatedPages";

// Shared components & helpers
import {
  StatCard,
  SectionHeader,
  field,
  safeHref,
} from "./org-shared";

// Data loading & constants
import {
  loadOrgPageData,
  resolveOrgEntity,
  HERO_STATS,
  ORG_TYPE_LABELS,
  ORG_TYPE_COLORS,
  DEFAULT_ORG_TYPE_COLOR,
  ORG_STATUS_LABELS,
  ORG_STATUS_COLORS,
  type OrgEntity,
} from "./org-data";

// Section components

import { EquityPositionsSection } from "./equity-section";
import { DivisionsSection, DivisionsOverview } from "./divisions-section";
import { FundingProgramsSection } from "./programs-section";
import { AiModelsSection } from "./ai-models-section";
import { PolicyPositionsSection, getOrgPolicyPositions } from "./policy-positions-section";

// Section components — publications

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

// People section — PG personnel data integration
import {
  fetchPgPersonnel,
  pgPersonnelToEntries,
  mergePgPersonnel,
  PeopleSection,
  type PersonEntry,
} from "./people-section";

// Market data section — secondary market prices + prediction markets
import {
  fetchMarketData,
  hasMarketData,
  getMarketDataCount,
  MarketDataSection,
  MarketHighlights,
} from "./market-data-section";

// PG grants integration — fetch grants from wiki-server for orgs that are funders
import { fetchFromWikiServer } from "@/lib/wiki-server";
import type { RpcGrantsByEntityResult } from "@/lib/wiki-server";
import Markdown from "react-markdown";

// Client-side tabs
import { OrgProfileTabs, type OrgTab } from "./org-tabs";

// ISR revalidation: refresh PG personnel data every hour (matches divisions/grants pages)
export const revalidate = 3600;

export function generateStaticParams() {
  return getOrgSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const resolved = resolveOrgBySlug(slug);
  if (resolved) {
    return {
      title: `${resolved.title} | Organizations`,
      description: `Profile and key metrics for ${resolved.title}.`,
    };
  }
  const typedEntity = getTypedEntityById(slug);
  if (typedEntity && isOrganization(typedEntity)) {
    return {
      title: `${typedEntity.title} | Organizations`,
      description: `Profile and key metrics for ${typedEntity.title}.`,
    };
  }
  return { title: "Organization Not Found" };
}

// ── Main page ─────────────────────────────────────────────────────────

export default async function OrgProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const result = resolveOrgEntity(slug);
  if (!result) return notFound();
  if ("redirect" in result) permanentRedirect(`/organizations/${result.redirect}`);

  const { entity } = result;
  const data = loadOrgPageData(entity, slug);

  // ── Fetch PG data (personnel + market data + grants) in parallel ──
  const entityStableId = entity.stableId ?? entity.id;
  const [pgPersonnelRows, marketData, pgGrantsData, pgReceivedData] = await Promise.all([
    fetchPgPersonnel(entityStableId),
    fetchMarketData(entity.id),
    fetchFromWikiServer<RpcGrantsByEntityResult>(
      `/api/grants/by-entity/${encodeURIComponent(entityStableId)}?limit=200&offset=0`,
      { revalidate: 3600, timeoutMs: 10_000 },
    ),
    fetchFromWikiServer<RpcGrantsByEntityResult>(
      `/api/grants/by-entity/${encodeURIComponent(entityStableId)}?role=grantee&limit=1&offset=0`,
      { revalidate: 3600, timeoutMs: 10_000 },
    ),
  ]);

  // PG grants: check if wiki-server has grants for this org (as funder)
  if (!pgGrantsData && entityStableId) {
    console.warn(`[org-profile] Failed to fetch PG grants for ${entityStableId} — wiki-server may be unavailable`);
  }
  const pgGrantCount = pgGrantsData?.total ?? 0;
  const pgReceivedCount = pgReceivedData?.total ?? 0;

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
      {/* Description */}
      {data.descriptionText && (
        <div className="text-sm text-muted-foreground leading-relaxed prose prose-sm prose-neutral dark:prose-invert max-w-none [&>p]:my-1.5">
          <Markdown
            components={{
              // Sanitize links: only allow http/https URLs
              a: ({ href, children, ...props }) => {
                const normalizedHref = typeof href === "string" ? href.trim() : "";
                const safeLink = /^https?:\/\//i.test(normalizedHref) ? normalizedHref : undefined;
                return safeLink
                  ? <a href={safeLink} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
                  : <span {...props}>{children}</span>;
              },
            }}
          >{data.descriptionText}</Markdown>
        </div>
      )}

      {/* Stat cards */}
      {heroStatCards.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {heroStatCards}
        </div>
      )}

      {/* Charts */}
      <ChartsSection chartData={data.chartData} orgName={entity.name} dilutionStages={data.dilutionStages} />

      {/* Facts */}
      {data.allFacts.length > 0 && (
        <FactsPanel facts={data.allFacts} entityId={entity.id} />
      )}

      {/* Other Data */}
      {data.otherCollections.length > 0 && (
        <OtherDataSection collections={data.otherCollections} entityId={entity.id} />
      )}

      {/* Divisions overview */}
      {data.divisions.length > 0 && (
        <DivisionsOverview divisions={data.divisions} leadResolved={data.divisionLeadResolved} members={data.divisionMembers} />
      )}

      {/* Prediction Market Highlights */}
      {hasMarketData(marketData) && <MarketHighlights data={marketData} />}

      {/* Related Wiki Pages */}
      <RelatedPages entityId={slug} entity={{ entityType: "organization" }} />
    </div>
  );

  tabs.push({ id: "overview", label: "Overview", content: overviewContent });

  // ── People tab: key personnel + board + PG personnel data ──
  const pgResult = pgPersonnelToEntries(pgPersonnelRows);

  const hasPeopleData =
    data.sortedPersons.length > 0 ||
    data.boardMembers.length > 0 ||
    pgResult.entries.length > 0;

  if (hasPeopleData) {
    // Build unified people list from key-persons + board members + PG personnel
    const peopleByName = new Map<string, PersonEntry>();

    // Add key persons first (from FactBase)
    for (const person of data.sortedPersons) {
      const personRef = field(person, "person");
      // Resolve person ref through TableBase (handles slugs, E-numbers, stableIds)
      let typedPerson = personRef ? getTypedEntityById(personRef) : undefined;
      if (!typedPerson && personRef) {
        // Try resolving as a FactBase slug -> stableId -> TableBase
        const resolvedId = resolveKBSlug(personRef);
        if (resolvedId) typedPerson = getTypedEntityById(resolvedId);
      }
      if (!typedPerson && personRef) {
        // Try direct stableId lookup (covers entities not in idRegistry.byStableId)
        typedPerson = getTypedEntityByStableId(personRef);
      }
      // Build display name: prefer explicit display_name, then resolved title,
      // then humanized slug. Never display raw stableIds or numeric IDs.
      const isMachineId = isSid(personRef ?? "");
      const fallbackName = isMachineId
        ? "Unknown"
        : titleCase(personRef ?? person.key);
      const name =
        person.displayName ??
        field(person, "display_name") ??
        typedPerson?.title ??
        fallbackName;
      // Resolve slug for linking — typedPerson.id is the slug
      const personSlug = typedPerson?.id ?? personRef;
      const personEntityId = typedPerson?.stableId ?? typedPerson?.id;
      // Use entity ID as the dedup key when available; fall back to name.
      // This prevents two different people with the same display name from
      // silently overwriting each other.
      const dedupKey = personEntityId ?? name;
      const existingByName = !personEntityId ? peopleByName.get(name) : undefined;
      const finalKey = existingByName ? `${name}__${person.key}` : dedupKey;
      peopleByName.set(finalKey, {
        name,
        title: field(person, "title"),
        slug: personSlug,
        entityType: typedPerson?.entityType,
        isFounder: !!person.fields.is_founder,
        isBoard: false,
        isCurrent: !person.fields.end,
        start: field(person, "start"),
        end: field(person, "end"),
      });
    }

    // Merge board members — if already present, just add board flag.
    // Try to match by entity ID first, then fall back to name match.
    for (const bm of data.boardMembers) {
      const bmSlug = bm.personHref?.replace(/^\/(people|organizations)\//, "");
      const bmEntityId = bmSlug ? resolveKBSlug(bmSlug) : undefined;

      // Look up by entity ID first (most reliable), then by name
      let existingKey: string | undefined;
      if (bmEntityId && peopleByName.has(bmEntityId)) {
        existingKey = bmEntityId;
      } else {
        // Scan values for a name match
        for (const [key, val] of peopleByName) {
          if (val.name === bm.personName) {
            existingKey = key;
            break;
          }
        }
      }

      if (existingKey) {
        const existing = peopleByName.get(existingKey)!;
        existing.isBoard = true;
      } else {
        const bmKey = bmEntityId ?? bm.personName;
        peopleByName.set(bmKey, {
          name: bm.personName,
          title: bm.role ?? "Board Member",
          slug: bmSlug,
          entityType: bm.personHref?.startsWith("/people") ? "person" : undefined,
          isFounder: false,
          isBoard: true,
          isCurrent: !bm.departed,
          start: bm.appointed ?? undefined,
          end: bm.departed ?? undefined,
        });
      }
    }

    // Merge PG personnel data (supplements FactBase data, deduplicates by slug/name)
    mergePgPersonnel(peopleByName, pgResult.entries);

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
      content: <PeopleSection people={allPeople} unresolvedCount={pgResult.unresolvedCount} />,
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
    pgGrantCount > 0 ||
    data.sortedPartnerships.length > 0 ||
    data.fundingPrograms.length > 0;

  if (hasFundingData) {
    const fundingCount =
      data.sortedRounds.length +
      meaningfulInvestments.length +
      meaningfulEquity.length +
      data.sortedPartnerships.length +
      Math.max(data.grantsMade.length, pgGrantCount) +
      data.grantsReceived.length;

    tabs.push({
      id: "funding",
      label: "Funding",
      count: fundingCount,
      content: (
        <div className="space-y-8">
          <FundingHistorySection rounds={data.sortedRounds} />

          {meaningfulInvestments.length > 0 && (
            <InvestorParticipationSection investments={meaningfulInvestments} />
          )}

          {meaningfulEquity.length > 0 && (
            <EquityPositionsSection
              positions={meaningfulEquity}
              investments={data.investmentsReceived}
              latestValuation={data.chartData.latestValuation}
              charitablePledges={data.charitablePledges}
            />
          )}

          {(data.grantsMade.length > 0 || pgGrantCount > 0) && (
            <GrantsSection
              grants={data.grantsMade}
              direction="given"
              entityId={entityStableId}
              orgSlug={slug}
              pgGrantCount={pgGrantCount}
            />
          )}
          {(data.grantsReceived.length > 0 || pgReceivedCount > 0) && (
            <GrantsSection
              grants={data.grantsReceived}
              direction="received"
              entityId={entityStableId}
              orgSlug={slug}
              pgGrantCount={pgReceivedCount}
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

  // ── Market Data tab: secondary market prices + prediction markets ──
  if (hasMarketData(marketData)) {
    tabs.push({
      id: "market-data",
      label: "Market Data",
      count: getMarketDataCount(marketData),
      content: <MarketDataSection data={marketData} />,
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

  // ── Build resource verdict maps (server-side, passed to client components) ──
  function buildResourceVerdicts(resources: typeof data.resourcePublications): Record<string, string | null> {
    const map: Record<string, string | null> = {};
    for (const r of resources) {
      const v = getRecordVerdict("resource", r.id);
      map[r.id] = v?.verdict ?? null;
    }
    return map;
  }
  const pubVerdicts = buildResourceVerdicts(data.resourcePublications);
  const announcementVerdicts = buildResourceVerdicts(data.resourceAnnouncements);
  const pressVerdicts = buildResourceVerdicts(data.resourcesAboutOrg);

  // ── Publications tab (research papers from entity_resources) ──
  if (data.resourcePublications.length > 0) {
    tabs.push({
      id: "publications",
      label: "Publications",
      count: data.resourcePublications.length,
      content: (
        <OrgResourcesSection
          resources={data.resourcePublications}
          title="Research & Technical Papers"
          emptyMessage=""
          verdicts={pubVerdicts}
        />
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
          alwaysShowColumns={{ date: true }}
          verdicts={announcementVerdicts}
        />
      ),
    });
  }

  // ── Coverage tab (external resources about the org) ──
  if (data.resourcesAboutOrg.length > 0) {
    tabs.push({
      id: "press",
      label: "Press",
      count: data.resourcesAboutOrg.length,
      content: (
        <OrgResourcesSection
          resources={data.resourcesAboutOrg}
          title="External Coverage & References"
          emptyMessage=""
          alwaysShowColumns={{ date: true, publication: true }}
          verdicts={pressVerdicts}
        />
      ),
    });
  }

  // ── Structure tab (divisions only — funding programs are in Funding) ──
  if (data.divisions.length > 0) {
    tabs.push({
      id: "divisions",
      label: "Divisions",
      count: data.divisions.length,
      content: (
        <div className="space-y-8">
          <DivisionsSection divisions={data.divisions} leadResolved={data.divisionLeadResolved} spending={data.divisionSpending} members={data.divisionMembers} />
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

  // ── Projects tab: projects founded by this org ──
  // Match by entity.id (stableId like "Khej79OA8g") or slug ("quri")
  const orgIdSet = new Set([entity.id, slug]);
  const resolvedSlugId = resolveKBSlug(slug);
  if (resolvedSlugId) orgIdSet.add(resolvedSlugId);

  const orgProjects = getTypedEntities()
    .filter(isProject)
    .filter((p) => {
      const foundedBy = getKBLatest(p.id, "founded-by");
      if (foundedBy?.value.type === "refs") {
        return foundedBy.value.value.some((ref) => orgIdSet.has(ref));
      }
      return orgIdSet.has(p.organization ?? "");
    });

  if (orgProjects.length > 0) {
    tabs.push({
      id: "projects",
      label: "Projects",
      count: orgProjects.length,
      content: (
        <section>
          <SectionHeader title="Projects" count={orgProjects.length} />
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium">Project</th>
                  <th className="text-left py-2 px-3 font-medium">Description</th>
                  <th className="text-center py-2 px-3 font-medium">Status</th>
                  <th className="text-center py-2 px-3 font-medium">Links</th>
                  <th scope="col" className="py-2 px-1 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {orgProjects.map((p) => {
                  const websiteFact = getKBLatest(p.id, "website");
                  const pUrl = (websiteFact?.value.type === "text" ? websiteFact.value.value : null) ?? p.projectUrl ?? p.website;
                  const pStatus = p.projectStatus ?? p.status;
                  const projectVerdict = getRecordVerdict("project", p.id)?.verdict;
                  return (
                    <tr key={p.id} className="hover:bg-muted/20 transition-colors">
                      <td className="py-2.5 px-3 font-medium">
                        <Link href={`/projects/${p.id}`} className="text-foreground hover:text-primary transition-colors">
                          {p.title}
                        </Link>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground max-w-[320px]">
                        {p.description && <span className="line-clamp-2">{p.description}</span>}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {pStatus && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize bg-muted text-muted-foreground">
                            {pStatus}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          {pUrl && (
                            <a href={pUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline">
                              website
                            </a>
                          )}
                          {p.wikiId && (
                            <Link href={`/wiki/${p.wikiId}`} className="text-[10px] text-muted-foreground/50 hover:text-primary transition-colors">
                              wiki
                            </Link>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 px-1">
                        <SourceCheckDot
                          status={recordVerdictToStatus(projectVerdict)}
                          originalVerdict={projectVerdict}
                          size="md"
                          href={getSourceCheckHref("project", p.id)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ),
    });
  }

  // Coverage scoring input for the header popover
  const revFact = getKBLatest(entity.id, "revenue");
  const valFact = getKBLatest(entity.id, "valuation");
  const hcFact = getKBLatest(entity.id, "headcount");
  const fundFact = getKBLatest(entity.id, "total-funding");
  const coverageInput = {
    revenueNum: revFact?.value.type === "number" ? revFact.value.value : null,
    valuationNum: valFact?.value.type === "number" ? valFact.value.value : null,
    headcount: hcFact?.value.type === "number" ? hcFact.value.value : null,
    totalFundingNum: fundFact?.value.type === "number" ? fundFact.value.value : null,
    foundedDate: data.foundedDateStr,
    peopleCount: data.sortedPersons.length,
    wikiPageId: entity.wikiPageId,
  };

  const entityVerdict = getRecordVerdict("entity", entity.id);

  const headerData = {
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases,
    orgType: data.orgType,
    orgStatus: data.orgStatus,
    foundedDateStr: data.foundedDateStr ?? null,
    orgAge: data.orgAge ?? null,
    hqText: data.hqText,
    websiteUrl: data.websiteUrl,
    wikiHref: data.wikiHref,
    founders: data.founders,
    coverageInput,
    verdict: entityVerdict?.verdict ?? null,
  };

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8 overflow-x-hidden">
      <OrgProfileHeader data={headerData} activePage="profile" />

      {/* ── Tabbed content ─────────────────────────────────────── */}
      <OrgProfileTabs tabs={tabs} ariaLabel="Organization sections" />
    </div>
  );
}
