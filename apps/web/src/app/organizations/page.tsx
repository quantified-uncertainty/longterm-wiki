import type { Metadata } from "next";
import { getKBEntities, getKBLatest, getKBRecords, getKBEntitySlug } from "@/data/kb";
import { getTypedEntityById, isOrganization } from "@/data";
import { formatKBFactValue } from "@/components/wiki/kb/format";
import type { Fact, Property } from "@longterm-wiki/kb";
import { OrganizationsTable, type OrgRow } from "@/app/organizations/organizations-table";

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

export default function OrganizationsPage() {
  const allEntities = getKBEntities();
  const orgs = allEntities.filter((e) => e.type === "organization");

  const rows: OrgRow[] = orgs.map((entity) => {
    const typedEntity = getTypedEntityById(entity.id);

    const revenueFact = getKBLatest(entity.id, "revenue");
    const valuationFact = getKBLatest(entity.id, "valuation");
    const headcountFact = getKBLatest(entity.id, "headcount");
    const totalFundingFact = getKBLatest(entity.id, "total-funding");
    const foundedFact = getKBLatest(entity.id, "founded-date");

    const fundingRounds = getKBRecords(entity.id, "funding-rounds");
    const keyPersons = getKBRecords(entity.id, "key-persons");

    return {
      id: entity.id,
      slug: getKBEntitySlug(entity.id) ?? null,
      name: entity.name,
      numericId: entity.numericId ?? null,
      orgType: (typedEntity && isOrganization(typedEntity) ? typedEntity.orgType : null) ?? null,
      wikiPageId: entity.wikiPageId ?? entity.numericId ?? null,

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

      fundingRoundsCount: fundingRounds.length,
      keyPeopleCount: keyPersons.length,
    };
  });

  // Compute summary stats
  const withRevenue = rows.filter((r) => r.revenueNum != null).length;
  const withValuation = rows.filter((r) => r.valuationNum != null).length;
  const withHeadcount = rows.filter((r) => r.headcount != null).length;
  const totalKeyPeople = rows.reduce((s, r) => s + r.keyPeopleCount, 0);
  const totalRounds = rows.reduce((s, r) => s + r.fundingRoundsCount, 0);

  const stats = [
    { label: "Organizations", value: String(rows.length) },
    { label: "With Revenue Data", value: String(withRevenue) },
    { label: "With Valuation Data", value: String(withValuation) },
    { label: "With Headcount", value: String(withHeadcount) },
    { label: "Key People Tracked", value: String(totalKeyPeople) },
    { label: "Funding Rounds", value: String(totalRounds) },
  ];

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

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
              {stat.label}
            </div>
            <div className="text-2xl font-bold tabular-nums tracking-tight">
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <OrganizationsTable rows={rows} />
    </div>
  );
}
