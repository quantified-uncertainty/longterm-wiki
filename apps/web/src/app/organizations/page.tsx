import { Suspense } from "react";
import type { Metadata } from "next";
import { getKBLatest, getKBFacts, getKBRecords, getKBEntities } from "@/data/factbase";
import { getTypedEntityById } from "@/data/tablebase";
import { getTypedEntities, isOrganization, getPageById, type OrganizationEntity } from "@/data";
import { formatKBFactValue } from "@/components/wiki/factbase/format";
import type { Fact, Property } from "@longterm-wiki/factbase";
import { OrganizationsTable, type OrgRow, type OrgStatDef } from "@/app/organizations/organizations-table";
import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { computeCompletionScore } from "@/app/organizations/org-constants";

export const metadata: Metadata = {
  title: "Organizations",
  description:
    "Directory of AI safety organizations, frontier labs, research groups, and funders with key metrics.",
};

/** Extract a numeric value from a fact for sorting. */
function numericValue(fact: Fact | undefined): number | null {
  if (!fact) return null;
  if (fact.value.type === "number") return fact.value.value;
  return null;
}

/** Format a fact value for display, returning null if no fact. */
function formatFact(
  fact: Fact | undefined,
  property?: Partial<Property>,
): string | null {
  if (!fact) return null;
  return formatKBFactValue(fact, property?.unit, property?.display);
}

/** Build a pre-computed lowercase text blob for full-text search across all org fields. */
function buildOrgSearchText(
  org: OrganizationEntity,
  orgToEmployeeNames: Map<string, string[]>,
): string {
  const parts: string[] = [org.title];

  // Entity description, tags, clusters
  if (org.description) parts.push(org.description);
  parts.push(...org.tags);
  parts.push(...org.clusters);

  // Org-specific typed fields
  if (org.orgType) parts.push(org.orgType);
  if (org.headquarters) parts.push(org.headquarters);
  if (org.parentOrg) {
    const parent = getTypedEntityById(org.parentOrg);
    if (parent) parts.push(parent.title);
  }

  // NOTE: TableBase entities don't have aliases; aliases from FactBase are not indexed here.

  // KB fact text values (description, headquarters, notable-for, etc.)
  // getKBFacts resolves slugs to FactBase entity IDs internally
  const SKIP_PROPERTIES = new Set([
    "social-media", "wikipedia-url", "github-profile", "website",
    "revenue", "valuation", "headcount", "total-funding", "founded-date",
  ]);
  const allFacts = getKBFacts(org.id);
  for (const fact of allFacts) {
    if (SKIP_PROPERTIES.has(fact.propertyId)) continue;
    if (fact.value.type === "text") {
      parts.push(fact.value.value);
    } else if (fact.value.type === "ref") {
      const refEntity = getTypedEntityById(fact.value.value);
      if (refEntity) parts.push(refEntity.title);
    }
  }

  // Funding program names from KB records
  const fundingPrograms = getKBRecords(org.id, "funding-programs");
  for (const fp of fundingPrograms) {
    if (typeof fp.fields.name === "string") parts.push(fp.fields.name);
    if (typeof fp.fields.description === "string") parts.push(fp.fields.description);
  }

  // Key people names (people employed by this org)
  // orgToEmployeeNames is keyed by FactBase entity ID; use org.stableId or org.id
  const tbEntity = getTypedEntityById(org.id);
  const stableId = tbEntity?.stableId;
  if (stableId) {
    const employeeNames = orgToEmployeeNames.get(stableId) ?? [];
    parts.push(...employeeNames);
  }

  // Related entries names
  for (const rel of org.relatedEntries) {
    const relEntity = getTypedEntityById(rel.id);
    if (relEntity) parts.push(relEntity.title);
  }

  return parts.join(" ").toLowerCase();
}

// ── API response shape (matches wiki-server GET /api/entities/organizations) ──

interface ApiOrg {
  id: string;
  wikiId: string | null;
  stableId: string | null;
  title: string;
  description: string | null;
  website: string | null;
  revenueNum: number | null;
  revenueDate: string | null;
  valuationNum: number | null;
  valuationDate: string | null;
  headcount: number | null;
  headcountDate: string | null;
  totalFundingNum: number | null;
  foundedDate: string | null;
}

interface ApiOrgsResponse {
  organizations: ApiOrg[];
  total: number;
  limit: number;
  offset: number;
}

// ── Data loading helpers ─────────────────────────────────────────────────

interface OrgPageData {
  rows: OrgRow[];
  stats: OrgStatDef[];
  orgTypeMap: Record<string, string>;
  serverEnabled: boolean;
}

/**
 * Try loading organizations from the wiki-server API.
 * orgTypeMap is always built from local data since orgType is not in the DB.
 *
 * After building rows from the API, merges in any local-only organizations
 * that the API didn't return. This ensures entities that haven't been synced
 * to the wiki-server PG database (e.g., recently added YAML entities) still
 * appear in the directory with their correct orgType.
 */
async function loadFromApi(
  orgTypeMap: Record<string, string>,
  localOrgs: OrganizationEntity[],
): Promise<FetchResult<OrgPageData>> {
  const result = await fetchDetailed<ApiOrgsResponse>(
    "/api/entities/organizations?limit=500",
    { revalidate: 60 },
  );

  if (!result.ok) return result;

  const { organizations } = result.data;

  const rows: OrgRow[] = organizations.map((org) => {
    const orgType = orgTypeMap[org.id] ?? null;
    const searchParts = [org.title];
    if (org.description) searchParts.push(org.description);
    if (orgType) searchParts.push(orgType);

    return {
      id: org.id,
      slug: org.id,
      name: org.title,
      wikiId: org.wikiId,
      orgType,
      wikiPageId: org.wikiId,

      revenue: null, // Display formatting handled by client component
      revenueNum: org.revenueNum,
      revenueDate: org.revenueDate,

      valuation: null,
      valuationNum: org.valuationNum,
      valuationDate: org.valuationDate,

      headcount: org.headcount,
      headcountDate: org.headcountDate,

      totalFunding: null,
      totalFundingNum: org.totalFundingNum,

      foundedDate: org.foundedDate,

      peopleCount: null, // Not available from API
      completionScore: computeCompletionScore(org),

      searchText: searchParts.join(" ").toLowerCase(),
    };
  });

  // Merge local-only orgs that the API didn't return (not yet synced to PG).
  // This prevents entities added to YAML but not yet synced from disappearing
  // in the directory. Without this, orgType filter tabs show incorrect counts.
  const apiIds = new Set(organizations.map((o) => o.id));
  for (const org of localOrgs) {
    if (apiIds.has(org.id)) continue;
    const orgType = org.orgType ?? null;
    const searchParts = [org.title];
    if (org.description) searchParts.push(org.description);
    if (orgType) searchParts.push(orgType);
    const foundedFact = getKBLatest(org.id, "founded-date");
    const foundedDate = foundedFact?.value.type === "date"
      ? foundedFact.value.value
      : foundedFact?.value.type === "text"
        ? foundedFact.value.value
        : foundedFact?.value.type === "number"
          ? String(foundedFact.value.value)
          : null;

    rows.push({
      id: org.id,
      slug: org.id,
      name: org.title,
      wikiId: org.wikiId ?? null,
      orgType,
      wikiPageId: org.wikiId && getPageById(org.id) ? org.wikiId : null,

      revenue: null,
      revenueNum: null,
      revenueDate: null,

      valuation: null,
      valuationNum: null,
      valuationDate: null,

      headcount: null,
      headcountDate: null,

      totalFunding: null,
      totalFundingNum: null,

      foundedDate,

      peopleCount: null,
      completionScore: computeCompletionScore({}),

      searchText: searchParts.join(" ").toLowerCase(),
    });
  }

  const stats = buildStats(rows);

  return {
    ok: true,
    data: { rows, stats, orgTypeMap, serverEnabled: true },
  };
}

/** Load organizations from local database.json + KB data. */
function loadFromLocal(): OrgPageData {
  const allEntities = getTypedEntities();
  const orgs = allEntities.filter(isOrganization);

  // Build reverse index: org slug → names of people employed there
  // People have "employed-by" facts referencing the org's KB entity ID
  const orgToEmployeeNames = new Map<string, string[]>();
  const kbPeople = getKBEntities().filter((e) => e.type === "person");
  for (const person of kbPeople) {
    const employedByFact = getKBLatest(person.id, "employed-by");
    if (employedByFact?.value.type === "ref") {
      const orgId = employedByFact.value.value;
      const existing = orgToEmployeeNames.get(orgId) ?? [];
      existing.push(person.name);
      orgToEmployeeNames.set(orgId, existing);
    }
  }

  const rows: OrgRow[] = orgs.map((org) => {
    // org.id is the slug — getKBLatest resolves slugs to KB entity IDs
    const revenueFact = getKBLatest(org.id, "revenue");
    const valuationFact = getKBLatest(org.id, "valuation");
    const headcountFact = getKBLatest(org.id, "headcount");
    const totalFundingFact = getKBLatest(org.id, "total-funding");
    const foundedFact = getKBLatest(org.id, "founded-date");

    // People count from the reverse index (keyed by FactBase stableId)
    const orgTbEntity = getTypedEntityById(org.id);
    const orgStableId = orgTbEntity?.stableId;
    const peopleCount = orgStableId ? (orgToEmployeeNames.get(orgStableId)?.length ?? 0) : 0;

    const revenueNum = numericValue(revenueFact);
    const valuationNum = numericValue(valuationFact);
    const headcountVal = headcountFact?.value.type === "number" ? headcountFact.value.value : null;
    const totalFundingNum = numericValue(totalFundingFact);
    const foundedDate = foundedFact?.value.type === "date"
      ? foundedFact.value.value
      : foundedFact?.value.type === "text"
        ? foundedFact.value.value
        : foundedFact?.value.type === "number"
          ? String(foundedFact.value.value)
          : null;

    return {
      id: org.id,
      slug: org.id,
      name: org.title,
      wikiId: org.wikiId ?? null,
      orgType: org.orgType ?? null,
      wikiPageId: org.wikiId && getPageById(org.id) ? org.wikiId : null,

      revenue: formatFact(revenueFact, { unit: "USD", display: { divisor: 1e9, prefix: "$", suffix: "B" } }),
      revenueNum,
      revenueDate: revenueFact?.asOf ?? null,

      valuation: formatFact(valuationFact, { unit: "USD", display: { divisor: 1e9, prefix: "$", suffix: "B" } }),
      valuationNum,
      valuationDate: valuationFact?.asOf ?? null,

      headcount: headcountVal,
      headcountDate: headcountFact?.asOf ?? null,

      totalFunding: formatFact(totalFundingFact, { unit: "USD", display: { divisor: 1e9, prefix: "$", suffix: "B" } }),
      totalFundingNum,

      foundedDate,

      peopleCount,
      completionScore: computeCompletionScore({
        revenueNum, valuationNum, headcount: headcountVal, totalFundingNum, foundedDate,
      }),

      searchText: buildOrgSearchText(org, orgToEmployeeNames),
    };
  });

  const stats = buildStats(rows);

  // Build orgType lookup map for enriching server-side results
  // (orgType is only in database.json, not synced to wiki-server)
  const orgTypeMap: Record<string, string> = {};
  for (const org of orgs) {
    if (org.orgType) {
      orgTypeMap[org.id] = org.orgType;
    }
  }

  // Server mode is enabled when wiki-server is configured
  const serverEnabled = !!process.env.LONGTERMWIKI_SERVER_URL;

  return { rows, stats, orgTypeMap, serverEnabled };
}

/** Compute summary stats from rows (shared between API and local paths). */
function buildStats(rows: OrgRow[]): OrgStatDef[] {
  const withRevenue = rows.filter((r) => r.revenueNum != null).length;
  const withValuation = rows.filter((r) => r.valuationNum != null).length;
  const withHeadcount = rows.filter((r) => r.headcount != null).length;
  return [
    { key: "all", label: "Organizations", value: String(rows.length) },
    { key: "withRevenue", label: "With Revenue Data", value: String(withRevenue) },
    { key: "withValuation", label: "With Valuation Data", value: String(withValuation) },
    { key: "withHeadcount", label: "With Headcount", value: String(withHeadcount) },
  ];
}

// ── Page component ───────────────────────────────────────────────────────

export default async function OrganizationsPage() {
  // Always build orgTypeMap from local data — orgType is not in the wiki-server DB
  const allEntities = getTypedEntities();
  const orgs = allEntities.filter(isOrganization);
  const orgTypeMap: Record<string, string> = {};
  for (const org of orgs) {
    if (org.orgType) {
      orgTypeMap[org.id] = org.orgType;
    }
  }

  const { data, source, apiError } = await withApiFallback(
    () => loadFromApi(orgTypeMap, orgs),
    () => loadFromLocal(),
  );

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Organizations
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of AI safety organizations, frontier labs,
          research groups, and funders tracked in the knowledge base.
        </p>
      </div>

      <DataSourceBanner source={source} apiError={apiError} />

      <Suspense fallback={<div>Loading...</div>}>
        <OrganizationsTable
          rows={data.rows}
          stats={data.stats}
          serverEnabled={data.serverEnabled}
          orgTypeMap={data.orgTypeMap}
        />
      </Suspense>
    </div>
  );
}
