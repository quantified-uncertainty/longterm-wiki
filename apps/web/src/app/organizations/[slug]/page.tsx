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

// Section components — sidebar
import { BoardOfDirectorsSection } from "./board-section";
import { RelatedOrganizationsSection } from "./related-orgs-section";
import { EquityPositionsSection } from "./equity-section";
import { DivisionsSection } from "./divisions-section";
import { FundingProgramsSection } from "./programs-section";
import { AiModelsSection } from "./ai-models-section";

// Section components — publications
import { KeyPublicationsSection } from "./publications-section";

// Section components — grants (main content column)
import {
  GrantsGivenSection,
  GrantsReceivedSection,
} from "./grants-section";

// Section components — main content column
import {
  FundingHistorySection,
  InvestorParticipationSection,
  ModelReleasesSection,
  ProductsSection,
  SafetyMilestonesSection,
  StrategicPartnershipsSection,
  OtherDataSection,
} from "./main-content-sections";

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

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          { label: entity.name },
        ]}
      />

      {/* Header */}
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

            {/* Founded info */}
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

            {/* Description */}
            {data.descriptionText && (
              <p className="text-sm text-muted-foreground leading-relaxed mb-2 max-w-prose">
                {data.descriptionText}
              </p>
            )}

            {/* Metadata row: website, headquarters, links */}
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

      {/* Stat cards — KB hero stats + computed counts */}
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-8">
          <FundingHistorySection rounds={data.sortedRounds} slug={slug} />
          <InvestorParticipationSection investments={data.investments} />
          <GrantsGivenSection
            grants={data.grantsMade}
            orgName={entity.name}
          />
          <GrantsReceivedSection grants={data.grantsReceived} />
          <ModelReleasesSection models={data.sortedModels} />
          <ProductsSection products={data.products} />
          <SafetyMilestonesSection milestones={data.sortedMilestones} />
          <StrategicPartnershipsSection partnerships={data.sortedPartnerships} />
          <KeyPublicationsSection publications={data.keyPublications} />
          <OtherDataSection collections={data.otherCollections} entityId={entity.id} />
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Key People */}
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
          <RelatedOrganizationsSection orgs={data.relatedOrgs} />

          {data.allFacts.length > 0 && (
            <FactsPanel facts={data.allFacts} entityId={entity.id} />
          )}

          <DivisionsSection divisions={data.divisions} leadResolved={data.divisionLeadResolved} />
          <FundingProgramsSection programs={data.fundingPrograms} />
          <EquityPositionsSection positions={data.equityPositions} />
          <AiModelsSection models={data.orgModels} benchmarksByModel={data.modelBenchmarks} />
        </div>
      </div>
    </div>
  );
}
