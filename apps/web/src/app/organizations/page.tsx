import type { Metadata } from "next";
import { getKBLatest, getKBFacts, getKBEntity, getKBRecords, getKBEntities } from "@/data/kb";
import { getTypedEntities, isOrganization, type OrganizationEntity } from "@/data";
import { formatKBFactValue } from "@/components/wiki/kb/format";
import type { Fact, Property } from "@longterm-wiki/kb";
import { OrganizationsTable, type OrgRow, type OrgStatDef } from "@/app/organizations/organizations-table";

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
    const parent = getKBEntity(org.parentOrg);
    if (parent) parts.push(parent.name);
  }

  // KB entity aliases (alternative names)
  const kbEntity = getKBEntity(org.id);
  if (kbEntity?.aliases) parts.push(...kbEntity.aliases);

  // KB fact text values (description, headquarters, notable-for, etc.)
  const SKIP_PROPERTIES = new Set([
    "social-media", "wikipedia-url", "github-profile", "website",
    "revenue", "valuation", "headcount", "total-funding", "founded-date",
  ]);
  if (kbEntity) {
    const allFacts = getKBFacts(kbEntity.id);
    for (const fact of allFacts) {
      if (SKIP_PROPERTIES.has(fact.propertyId)) continue;
      if (fact.value.type === "text") {
        parts.push(fact.value.value);
      } else if (fact.value.type === "ref") {
        const refEntity = getKBEntity(fact.value.value);
        if (refEntity) parts.push(refEntity.name);
      }
    }
  }

  // Funding program names from KB records
  if (kbEntity) {
    const fundingPrograms = getKBRecords(kbEntity.id, "funding-programs");
    for (const fp of fundingPrograms) {
      if (typeof fp.fields.name === "string") parts.push(fp.fields.name);
      if (typeof fp.fields.description === "string") parts.push(fp.fields.description);
    }
  }

  // Key people names (people employed by this org)
  if (kbEntity) {
    const employeeNames = orgToEmployeeNames.get(kbEntity.id) ?? [];
    parts.push(...employeeNames);
  }

  // Related entries names
  for (const rel of org.relatedEntries) {
    const relEntity = getKBEntity(rel.id);
    if (relEntity) parts.push(relEntity.name);
  }

  return parts.join(" ").toLowerCase();
}

export default function OrganizationsPage() {
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

    return {
      id: org.id,
      slug: org.id,
      name: org.title,
      numericId: org.numericId ?? null,
      orgType: org.orgType ?? null,
      wikiPageId: org.numericId ?? null,

      revenue: formatFact(revenueFact, { unit: "USD", display: { divisor: 1e9, prefix: "$", suffix: "B" } }),
      revenueNum: numericValue(revenueFact),
      revenueDate: revenueFact?.asOf ?? null,

      valuation: formatFact(valuationFact, { unit: "USD", display: { divisor: 1e9, prefix: "$", suffix: "B" } }),
      valuationNum: numericValue(valuationFact),
      valuationDate: valuationFact?.asOf ?? null,

      headcount: headcountFact?.value.type === "number" ? headcountFact.value.value : null,
      headcountDate: headcountFact?.asOf ?? null,

      totalFunding: formatFact(totalFundingFact, { unit: "USD", display: { divisor: 1e9, prefix: "$", suffix: "B" } }),
      totalFundingNum: numericValue(totalFundingFact),

      foundedDate: foundedFact?.value.type === "date"
        ? foundedFact.value.value
        : foundedFact?.value.type === "text"
          ? foundedFact.value.value
          : foundedFact?.value.type === "number"
            ? String(foundedFact.value.value)
            : null,

      searchText: buildOrgSearchText(org, orgToEmployeeNames),
    };
  });

  // Compute summary stats (clickable in the client component)
  const withRevenue = rows.filter((r) => r.revenueNum != null).length;
  const withValuation = rows.filter((r) => r.valuationNum != null).length;
  const withHeadcount = rows.filter((r) => r.headcount != null).length;
  const stats: OrgStatDef[] = [
    { key: "all", label: "Organizations", value: String(rows.length) },
    { key: "withRevenue", label: "With Revenue Data", value: String(withRevenue) },
    { key: "withValuation", label: "With Valuation Data", value: String(withValuation) },
    { key: "withHeadcount", label: "With Headcount", value: String(withHeadcount) },
  ];

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

      <OrganizationsTable
        rows={rows}
        stats={stats}
        serverEnabled={serverEnabled}
        orgTypeMap={orgTypeMap}
      />
    </div>
  );
}
