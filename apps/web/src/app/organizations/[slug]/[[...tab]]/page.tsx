import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { ORG_TAB_IDS } from "../tabs";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import { getTypedEntityById, getTypedEntityByStableId, getTypedEntities, isOrganization, isProject } from "@/data";

import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";
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

import { buildOrgShellSlots } from "../org-profile-header";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  fetchEntitySourcingSummary,
  rollupVerdictFromSummary,
} from "@/components/entity/entity-sourcing";
import { RelatedPages } from "@/components/RelatedPages";
import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";
import { getPropertyLabel } from "@/components/factbase/entity-detail-shared";
import { EntityDbPage } from "@/components/directory/EntityDbPage";
import { EntityTimeline } from "@/components/wiki/EntityTimeline";

// Shared components & helpers
import {
  StatCard,
  SectionHeader,
  field,
  safeHref,
} from "../org-shared";

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
} from "../org-data";

// Section components

import { EquityPositionsSection } from "../equity-section";
import { DivisionsSection, DivisionsOverview } from "../divisions-section";
import { FundingProgramsSection } from "../programs-section";
import { AiModelsSection } from "../ai-models-section";
import { PolicyPositionsSection, getOrgPolicyPositions } from "../policy-positions-section";

// Section components — publications

// Section components — grants (main content column)
import { GrantsSection } from "../grants-section";

// Section components — resources
import { OrgResourcesSection } from "../resources-section";

// Section components — main content column
import {
  FundingHistorySection,
  InvestorParticipationSection,
  ProductsSection,
  SafetyMilestonesSection,
  StrategicPartnershipsSection,
  OtherDataSection,
} from "../main-content-sections";

// Charts
import { ChartsSection } from "../charts-section";

// People section — PG personnel data integration
import {
  fetchPgPersonnel,
  pgPersonnelToEntries,
  mergePgPersonnel,
  PeopleSection,
  type PersonEntry,
} from "../people-section";

// Market data section — secondary market prices + prediction markets
import {
  fetchMarketData,
  hasMarketData,
  getMarketDataCount,
  MarketDataSection,
  MarketHighlights,
} from "../market-data-section";

// PG grants integration — fetch grants from wiki-server for orgs that are funders
import { fetchFromWikiServer } from "@/lib/wiki-server";
import type { RpcGrantsByEntityResult } from "@/lib/wiki-server";
import Markdown from "react-markdown";

// External scorecard mirror (QUA-688)
import {
  loadScorecardsForEntity,
  ScorecardsSection,
} from "../scorecards-section";

import type { ProfileTab as OrgTab } from "@/components/directory";
import { ORG_TAB_GROUPS, ORG_TAB_ICON_CLASS as ICON_CLASS } from "../tabs";

// `ORG_TAB_IDS` is the canonical list of path-routable tab ids — link-tabs
// (e.g. `wiki`, which navigates to `/wiki/E<N>`) are excluded by construction,
// so a `Set` over the catalog is the validation surface.
const PATH_ROUTABLE_TAB_IDS: ReadonlySet<string> = new Set(ORG_TAB_IDS);
import {
  Home,
  Users,
  LayoutGrid,
  DollarSign,
  TrendingUp,
  Package,
  FileText,
  Bell,
  Newspaper,
  Shield,
  Landmark,
  Briefcase,
  PieChart,
  Gift,
  Coins,
  Banknote,
  Handshake,
  BookOpen,
  Database,
  ListTree,
  Clock,
  Award,
} from "lucide-react";

// ISR revalidation: refresh PG personnel data every hour (matches divisions/grants pages)
export const revalidate = 3600;

// Pre-render the bare profile URL for every org. Tab-segment URLs (e.g.
// `/organizations/anthropic/people`) are served via ISR — they render the
// same DOM and only differ in the active tab styling, so pre-rendering the
// 5,500-page Cartesian product (orgs × tabs) is wasteful.
export function generateStaticParams() {
  // Empty array tells Next.js "no extra path segments" for the optional
  // catch-all — pre-renders the bare `/organizations/<slug>` URL only.
  return getOrgSlugs().map((slug) => ({ slug, tab: [] as string[] }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; tab?: string[] }>;
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
  params: Promise<{ slug: string; tab?: string[] }>;
}) {
  const { slug, tab } = await params;

  // Defensive: Next.js 15 always passes an array for `[[...tab]]`, but guard
  // against unexpected shapes leaking through (e.g. middleware tampering).
  const tabSegments: string[] = Array.isArray(tab) ? tab : [];

  const result = resolveOrgEntity(slug);
  if (!result) return notFound();
  if ("redirect" in result) {
    // Preserve the first tab segment when an org slug aliases to its canonical
    // form so deep links (e.g. /organizations/google-deepmind/people) keep
    // pointing at the same tab after the redirect. Only forward known-valid
    // tab ids — an attacker-controlled or stale segment falls back to the
    // bare canonical URL rather than producing a redirect chain into a
    // suspicious path. Sub-record routes (`data`, `db`, `divisions/<slug>`,
    // `funding`, `grants/<id>`) never reach this catch-all because Next.js
    // resolves the more-specific route first.
    const firstSegment = tabSegments[0];
    const tabSuffix =
      firstSegment && PATH_ROUTABLE_TAB_IDS.has(firstSegment)
        ? `/${firstSegment}`
        : "";
    permanentRedirect(`/organizations/${result.redirect}${tabSuffix}`);
  }

  const { entity } = result;
  const data = loadOrgPageData(entity, slug);

  // ── Fetch PG data (personnel + market data + grants + sourcing) in parallel ──
  const entityStableId = entity.stableId ?? entity.id;
  const [pgPersonnelRows, marketData, pgGrantsData, pgReceivedData, sourcingSummary, scorecardsData, aiModelVerdictsRaw] = await Promise.all([
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
    fetchEntitySourcingSummary([entity.id, entityStableId, slug]),
    loadScorecardsForEntity(entityStableId),
    // QUA-685: pull all ai-model verdicts so the Products & Models table dots
    // can render real sourcing status. A single shared fetch (capped at the
    // wiki-server's MAX_PAGE_SIZE=200) is cheaper than per-model lookups even
    // when only a couple of models match this org. The truncation check
    // below logs a warning if the verdicts table grows past 200 rows so we
    // catch it before silent data loss (~50 entities × multiple verdict
    // rounds could approach the cap as more labs are backfilled).
    // typed-client-ok: QUA-685 baseline — single ad-hoc list call against
    // /api/sourcing/verdicts. A typed client wrapper would be appropriate
    // when more callers consume this endpoint with a similar shape.
    fetchFromWikiServer<{ verdicts: Array<{ recordType: string; recordId: string; verdict: string; fieldName: string | null }>; total: number }>(
      `/api/sourcing/verdicts?record_type=ai-model&limit=200`,
      { revalidate: 300, timeoutMs: 10_000 },
    ),
  ]);
  const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);

  // QUA-685: build a recordId → verdict map so AiModelsSection can render the
  // sourcing dot per row without making per-model network calls.
  const aiModelVerdictByModelId = new Map<string, string>();
  if (aiModelVerdictsRaw) {
    if (aiModelVerdictsRaw.total > aiModelVerdictsRaw.verdicts.length) {
      console.warn(
        `[org-profile] ai-model verdicts truncated: total=${aiModelVerdictsRaw.total} ` +
        `received=${aiModelVerdictsRaw.verdicts.length}. Bump the page-size or paginate ` +
        `/api/sourcing/verdicts?record_type=ai-model.`,
      );
    }
    for (const v of aiModelVerdictsRaw.verdicts) {
      // Skip per-field verdicts (fieldName != null); we display the row-level
      // rollup so each model has at most one dot.
      if (v.fieldName) continue;
      aiModelVerdictByModelId.set(v.recordId, v.verdict);
    }
  }

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
        label={getPropertyLabel(prop, propId)}
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

  tabs.push({
    id: "overview",
    label: "Overview",
    content: overviewContent,
    group: "entity",
    icon: <Home className={ICON_CLASS} />,
  });

  // ── Wiki tab — navigates to the standalone /wiki/E<N> page.
  // We render as a link-tab (not inline) because MDX wiki content references
  // resources by stableId that may only exist in the wiki-server (not in the
  // build-time database.json), and the R component falls back to [sid_...]
  // which breaks the no-raw-ids e2e test. The standalone wiki page has its
  // own resource-resolution path that handles this correctly.
  if (entity.wikiPageId && data.wikiHref) {
    tabs.push({
      id: "wiki",
      label: "Wiki",
      group: "entity",
      icon: <BookOpen className={ICON_CLASS} />,
      href: data.wikiHref,
    });
  }

  // ── Facts tab (structured FactBase view) ──
  tabs.push({
    id: "facts",
    label: "Facts",
    group: "data",
    icon: <ListTree className={ICON_CLASS} />,
    content: <FactBaseEntityBody entityId={entity.id} skipVerdicts skipHeroStats />,
  });

  // ── Database Records tab (embedded EntityProfileViewer) ──
  tabs.push({
    id: "database",
    label: "Database",
    group: "data",
    icon: <Database className={ICON_CLASS} />,
    content: (
      <EntityDbPage
        slug={slug}
        backHref={`/organizations/${slug}`}
        backLabel="Back to Organization profile"
        embedded
      />
    ),
  });

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
      group: "about",
      icon: <Users className={ICON_CLASS} />,
    });
  }

  // ── Timeline tab (entity_events from PG, merged into factbase-data.json) ──
  if (data.entityEvents.length > 0) {
    tabs.push({
      id: "timeline",
      label: "Timeline",
      count: data.entityEvents.length,
      group: "about",
      icon: <Clock className={ICON_CLASS} />,
      content: <EntityTimeline events={data.entityEvents} />,
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

  // ── Funding Rounds tab ──
  if (data.sortedRounds.length > 0 || meaningfulInvestments.length > 0) {
    tabs.push({
      id: "funding-rounds",
      label: "Funding Rounds",
      count: data.sortedRounds.length || meaningfulInvestments.length,
      group: "business",
      icon: <DollarSign className={ICON_CLASS} />,
      content: (
        <div className="space-y-8">
          {data.sortedRounds.length > 0 && (
            <FundingHistorySection rounds={data.sortedRounds} />
          )}
          {meaningfulInvestments.length > 0 && (
            <InvestorParticipationSection investments={meaningfulInvestments} />
          )}
        </div>
      ),
    });
  }

  // ── Shareholders / Equity Positions tab ──
  if (meaningfulEquity.length > 0) {
    tabs.push({
      id: "shareholders",
      label: "Shareholders",
      count: meaningfulEquity.length,
      group: "business",
      icon: <PieChart className={ICON_CLASS} />,
      content: (
        <EquityPositionsSection
          positions={meaningfulEquity}
          investments={data.investmentsReceived}
          latestValuation={data.chartData.latestValuation}
          charitablePledges={data.charitablePledges}
        />
      ),
    });
  }

  // ── Grants Made tab ──
  if (data.grantsMade.length > 0 || pgGrantCount > 0) {
    tabs.push({
      id: "grants-made",
      label: "Grants Made",
      count: Math.max(data.grantsMade.length, pgGrantCount),
      group: "business",
      icon: <Gift className={ICON_CLASS} />,
      content: (
        <GrantsSection
          grants={data.grantsMade}
          direction="given"
          entityId={entityStableId}
          orgSlug={slug}
          pgGrantCount={pgGrantCount}
        />
      ),
    });
  }

  // ── Grants Received tab ──
  if (data.grantsReceived.length > 0 || pgReceivedCount > 0) {
    tabs.push({
      id: "grants-received",
      label: "Grants Received",
      count: Math.max(data.grantsReceived.length, pgReceivedCount),
      group: "business",
      icon: <Coins className={ICON_CLASS} />,
      content: (
        <GrantsSection
          grants={data.grantsReceived}
          direction="received"
          entityId={entityStableId}
          orgSlug={slug}
          pgGrantCount={pgReceivedCount}
        />
      ),
    });
  }

  // ── Funding Programs tab ──
  if (data.fundingPrograms.length > 0) {
    tabs.push({
      id: "funding-programs",
      label: "Funding Programs",
      count: data.fundingPrograms.length,
      group: "business",
      icon: <Banknote className={ICON_CLASS} />,
      content: <FundingProgramsSection programs={data.fundingPrograms} />,
    });
  }

  // ── Partnerships & MOUs tab (governance) ──
  if (data.sortedPartnerships.length > 0) {
    tabs.push({
      id: "partnerships",
      label: "Partners & MOUs",
      count: data.sortedPartnerships.length,
      group: "governance",
      icon: <Handshake className={ICON_CLASS} />,
      content: <StrategicPartnershipsSection partnerships={data.sortedPartnerships} />,
    });
  }

  // ── Market Data tab: secondary market prices + prediction markets ──
  if (hasMarketData(marketData)) {
    tabs.push({
      id: "market-data",
      label: "Market Data",
      count: getMarketDataCount(marketData),
      content: <MarketDataSection data={marketData} />,
      group: "business",
      icon: <TrendingUp className={ICON_CLASS} />,
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
      group: "business",
      icon: <Package className={ICON_CLASS} />,
      content: (
        <div className="space-y-8">
          <AiModelsSection
            models={data.orgModels}
            benchmarksByModel={data.modelBenchmarks}
            verdictByModelId={aiModelVerdictByModelId}
          />
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
      group: "output",
      icon: <Shield className={ICON_CLASS} />,
      content: (
        <div className="space-y-8">
          <SafetyMilestonesSection milestones={data.sortedMilestones} />
        </div>
      ),
    });
  }

  // ── Build resource verdict maps (server-side, passed to client components) ──
  // resource has no sourcing verdicts yet (QUA-211); pass empty maps
  const pubVerdicts: Record<string, string | null> = {};
  const announcementVerdicts: Record<string, string | null> = {};
  const pressVerdicts: Record<string, string | null> = {};

  // ── Publications tab (research papers from entity_resources) ──
  if (data.resourcePublications.length > 0) {
    tabs.push({
      id: "publications",
      label: "Publications",
      count: data.resourcePublications.length,
      group: "output",
      icon: <FileText className={ICON_CLASS} />,
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
      group: "output",
      icon: <Bell className={ICON_CLASS} />,
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
      group: "output",
      icon: <Newspaper className={ICON_CLASS} />,
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
      group: "about",
      icon: <LayoutGrid className={ICON_CLASS} />,
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
      group: "governance",
      icon: <Landmark className={ICON_CLASS} />,
      content: (
        <PolicyPositionsSection positions={policyPositions} />
      ),
    });
  }

  // ── Scorecards tab — external safety/transparency scorecards (QUA-688) ──
  if (scorecardsData) {
    if ("fetchError" in scorecardsData) {
      // Transient wiki-server failure — surface an unavailable state rather
      // than silently dropping the tab.
      tabs.push({
        id: "scorecards",
        label: "Scorecards",
        group: "governance",
        icon: <Award className={ICON_CLASS} />,
        content: <ScorecardsSection groups={[]} fetchError />,
      });
    } else if (scorecardsData.groups.length > 0) {
      tabs.push({
        id: "scorecards",
        label: "Scorecards",
        count: scorecardsData.groups.length,
        group: "governance",
        icon: <Award className={ICON_CLASS} />,
        content: <ScorecardsSection groups={scorecardsData.groups} />,
      });
    }
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
      group: "output",
      icon: <Briefcase className={ICON_CLASS} />,
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
                  const projectVerdict = null; // project has no sourcing verdicts yet (QUA-211)
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
                        <SourcingDot
                          status={recordVerdictToStatus(projectVerdict)}
                          originalVerdict={projectVerdict}
                          size="md"
                          // QUA-540: project has no sourcing verdicts → /sourcing/project/:id 404s.
                          href={undefined}
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
    // QUA-867 item D — credit orgs evaluated by external scorecards. Count
    // distinct sources (one panel per source) rather than total grade rows
    // (which would double-count multi-dimension scorecards). `fetchError`
    // is treated as 0 so a transient wiki-server outage doesn't pessimize
    // the score.
    externalScorecardCount:
      scorecardsData && !("fetchError" in scorecardsData)
        ? scorecardsData.groups.length
        : 0,
  };

  const shellSlots = buildOrgShellSlots(
    {
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
      verdict: rollupVerdict,
    },
    {},
  );

  return (
    <EntityProfileShell
      {...shellSlots}
      tabs={tabs}
      tabsAriaLabel="Organization sections"
      tabsLayout="vertical"
      tabGroups={ORG_TAB_GROUPS}
      tabRouting={{ mode: "path", basePath: `/organizations/${slug}` }}
    />
  );
}
