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

// Shared components & helpers
import {
  StatCard,
  SectionHeader,
  PersonRow,
  field,
  safeHref,
} from "./org-shared";

// Data loading & constants
import {
  loadOrgPageData,
  HERO_STATS,
  ORG_TYPE_LABELS,
  ORG_TYPE_COLORS,
} from "./org-data";

// Section components
import { BoardOfDirectorsSection } from "./board-section";
import { RelatedOrganizationsSection } from "./related-orgs-section";
import { EquityPositionsSection } from "./equity-section";
import { GrantsMadeSection, FundingReceivedSection } from "./grants-section";
import { DivisionsSection } from "./divisions-section";
import { FundingProgramsSection } from "./programs-section";
import { AiModelsSection } from "./ai-models-section";
import {
  FundingHistorySection,
  InvestorParticipationSection,
  ModelReleasesSection,
  ProductsSection,
  SafetyMilestonesSection,
  StrategicPartnershipsSection,
  OtherDataSection,
} from "./main-content-sections";

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

  // Overview tab: always present — key stats, people, facts, related orgs
  const overviewContent = (
    <div className="space-y-8">
      {/* Key People + Board side by side */}
      {(data.sortedPersons.length > 0 || data.boardMembers.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {data.sortedPersons.length > 0 && (
            <section>
              <SectionHeader title="Key People" count={data.sortedPersons.length} />
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {data.sortedPersons.map((person) => {
                  const personRef = field(person, "person");
                  const personEntityId = personRef
                    ? resolveKBSlug(personRef)
                    : undefined;
                  const personEntity = personEntityId
                    ? getKBEntity(personEntityId)
                    : undefined;
                  const name =
                    field(person, "display_name") ??
                    personEntity?.name ??
                    titleCase(personRef ?? person.key);

                  return (
                    <PersonRow
                      key={person.key}
                      name={name}
                      title={field(person, "title")}
                      slug={personRef}
                      entityType={personEntity?.type}
                      isFounder={!!person.fields.is_founder}
                      start={field(person, "start")}
                      end={field(person, "end")}
                      notes={field(person, "notes")}
                    />
                  );
                })}
              </div>
            </section>
          )}
          <BoardOfDirectorsSection members={data.boardMembers} />
        </div>
      )}

      {/* Related Orgs */}
      {data.relatedOrgs.length > 0 && (
        <RelatedOrganizationsSection orgs={data.relatedOrgs} />
      )}

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
    </div>
  );

  tabs.push({ id: "overview", label: "Overview", content: overviewContent });

  // Funding tab
  const hasFundingData =
    data.sortedRounds.length > 0 ||
    data.investments.length > 0 ||
    data.equityPositions.length > 0 ||
    data.grantsReceived.length > 0 ||
    data.grantsMade.length > 0;

  if (hasFundingData) {
    const fundingCount =
      data.sortedRounds.length +
      data.investments.length +
      data.grantsMade.length +
      data.grantsReceived.length;

    tabs.push({
      id: "funding",
      label: "Funding",
      count: fundingCount,
      content: (
        <div className="space-y-8">
          <FundingHistorySection rounds={data.sortedRounds} slug={slug} />

          {(data.investments.length > 0 || data.equityPositions.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {data.investments.length > 0 && (
                <InvestorParticipationSection investments={data.investments} />
              )}
              {data.equityPositions.length > 0 && (
                <EquityPositionsSection positions={data.equityPositions} />
              )}
            </div>
          )}

          {(data.grantsMade.length > 0 || data.grantsReceived.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <GrantsMadeSection
                grants={data.grantsMade}
                orgName={entity.name}
                totalCount={data.grantsMade.length}
              />
              <FundingReceivedSection grants={data.grantsReceived} />
            </div>
          )}
        </div>
      ),
    });
  }

  // Products & Models tab
  const hasProductData =
    data.sortedModels.length > 0 ||
    data.products.length > 0 ||
    data.orgModels.length > 0;

  if (hasProductData) {
    const productCount =
      data.sortedModels.length + data.products.length + data.orgModels.length;

    tabs.push({
      id: "products",
      label: "Products & Models",
      count: productCount,
      content: (
        <div className="space-y-8">
          <ModelReleasesSection models={data.sortedModels} />
          <ProductsSection products={data.products} />
          <AiModelsSection models={data.orgModels} />
        </div>
      ),
    });
  }

  // Safety & Research tab
  const hasSafetyData =
    data.sortedMilestones.length > 0 || data.sortedPartnerships.length > 0;

  if (hasSafetyData) {
    tabs.push({
      id: "safety",
      label: "Safety & Research",
      count: data.sortedMilestones.length + data.sortedPartnerships.length,
      content: (
        <div className="space-y-8">
          <SafetyMilestonesSection milestones={data.sortedMilestones} />
          <StrategicPartnershipsSection partnerships={data.sortedPartnerships} />
        </div>
      ),
    });
  }

  // Structure tab (divisions, programs)
  const hasStructureData =
    data.divisions.length > 0 || data.fundingPrograms.length > 0;

  if (hasStructureData) {
    tabs.push({
      id: "structure",
      label: "Structure",
      count: data.divisions.length + data.fundingPrograms.length,
      content: (
        <div className="space-y-8">
          <DivisionsSection divisions={data.divisions} />
          <FundingProgramsSection programs={data.fundingPrograms} />
        </div>
      ),
    });
  }

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          { label: entity.name },
        ]}
      />

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-start gap-5">
          {/* Org avatar/icon */}
          <div className="shrink-0 w-16 h-16 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-2xl font-bold text-primary/70" aria-hidden="true">
            {entity.name
              .split(/\s+/)
              .map((w) => w[0])
              .filter(Boolean)
              .slice(0, 2)
              .join("")
              .toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-3xl font-extrabold tracking-tight">
                {entity.name}
              </h1>
              {data.orgType && (
                <span
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                    ORG_TYPE_COLORS[data.orgType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                  }`}
                >
                  {ORG_TYPE_LABELS[data.orgType] ?? data.orgType}
                </span>
              )}
            </div>
            {entity.aliases && entity.aliases.length > 0 && (
              <p className="text-sm text-muted-foreground/70 mb-1">
                Also known as: {entity.aliases.join(", ")}
              </p>
            )}

            {(data.foundedDateStr || data.founders.length > 0) && (
              <p className="text-sm text-muted-foreground mb-1">
                {data.foundedDateStr && (
                  <span>
                    Founded {formatKBDate(data.foundedDateStr)}
                    {data.orgAge && <span className="text-muted-foreground"> ({data.orgAge})</span>}
                  </span>
                )}
                {data.founders.length > 0 && (
                  <span>
                    {data.foundedDateStr ? " by " : "Founded by "}
                    {data.founders.map((f, i) => (
                      <span key={i}>
                        {i > 0 && (i === data.founders.length - 1 ? ", and " : ", ")}
                        {f.href ? (
                          <Link href={f.href} className="text-primary hover:underline">
                            {f.name}
                          </Link>
                        ) : (
                          f.name
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </p>
            )}

            {data.descriptionText && (
              <p className="text-sm text-muted-foreground leading-relaxed mb-2 max-w-prose">
                {data.descriptionText}
              </p>
            )}

            <div className="flex items-center gap-4 text-sm flex-wrap">
              {data.websiteUrl && (
                <a
                  href={safeHref(data.websiteUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 font-medium transition-colors"
                >
                  {shortDomain(data.websiteUrl)}{" "}
                  &#8599;
                  <span className="sr-only">(opens in new tab)</span>
                </a>
              )}
              {data.hqText && (
                <span className="text-muted-foreground">
                  HQ: {data.hqText}
                </span>
              )}
              {data.wikiHref && (
                <Link
                  href={data.wikiHref}
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
        </div>
      </div>

      {/* ── Stat cards ─────────────────────────────────────────── */}
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
        {data.currentKeyPeople > 0 && (
          <StatCard
            label="Key People"
            value={<span>{data.currentKeyPeople}</span>}
            sub={`${data.sortedPersons.length} total tracked`}
          />
        )}
        {data.currentBoardMembers > 0 && (
          <StatCard
            label="Board Members"
            value={<span>{data.currentBoardMembers}</span>}
            sub={`${data.boardMembers.length} total`}
          />
        )}
        {data.totalGrantsMade > 0 && (
          <StatCard
            label="Grants Made"
            value={<span>{formatCompactCurrency(data.totalGrantsMade)}</span>}
            sub={`${data.grantsMade.length} grants`}
          />
        )}
        {data.totalGrantsReceived > 0 && (
          <StatCard
            label="Funding Received"
            value={<span>{formatCompactCurrency(data.totalGrantsReceived)}</span>}
            sub={`${data.grantsReceived.length} grants`}
          />
        )}
        {data.orgModels.length > 0 && (
          <StatCard
            label="AI Models"
            value={<span>{data.orgModels.length}</span>}
          />
        )}
      </div>

      {/* ── Tabbed content ─────────────────────────────────────── */}
      <OrgProfileTabs tabs={tabs} />
    </div>
  );
}
