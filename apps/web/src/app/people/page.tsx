import type { Metadata } from "next";
import { getKBEntities, getKBLatest, getKBRecords, getKBEntity, getKBEntitySlug } from "@/data/kb";
import type { Fact } from "@longterm-wiki/kb";
import { ProfileStatCard } from "@/components/directory";
import { PeopleTable, type PersonRow } from "./people-table";

export const metadata: Metadata = {
  title: "People",
  description:
    "Directory of key people in AI safety, frontier AI research, policy, and effective altruism with roles, affiliations, and key metrics.",
};

function numericValue(fact: Fact | undefined): number | null {
  if (!fact) return null;
  if (fact.value.type === "number") return fact.value.value;
  return null;
}

function resolveRef(fact: Fact | undefined): { id: string; name: string } | null {
  if (!fact) return null;
  if (fact.value.type !== "ref") return null;
  const refId = fact.value.value;
  const entity = getKBEntity(refId);
  if (!entity) return null;
  return { id: entity.id, name: entity.name };
}

export default function PeoplePage() {
  const allEntities = getKBEntities();
  const people = allEntities.filter((e) => e.type === "person");

  const rows: PersonRow[] = people.map((entity) => {
    const roleFact = getKBLatest(entity.id, "role");
    const employedByFact = getKBLatest(entity.id, "employed-by");
    const bornYearFact = getKBLatest(entity.id, "born-year");
    const netWorthFact = getKBLatest(entity.id, "net-worth");

    const careerHistory = getKBRecords(entity.id, "career-history");
    const employer = resolveRef(employedByFact);

    return {
      id: entity.id,
      slug: getKBEntitySlug(entity.id) ?? entity.id,
      name: entity.name,
      numericId: entity.numericId ?? null,
      wikiPageId: entity.wikiPageId ?? entity.numericId ?? null,

      role: roleFact?.value.type === "text" ? roleFact.value.value : null,

      employerId: employer?.id ?? null,
      employerName: employer?.name ?? null,

      bornYear: numericValue(bornYearFact),
      netWorthNum: numericValue(netWorthFact),

      careerHistoryCount: careerHistory.length,
    };
  });

  const withRole = rows.filter((r) => r.role != null).length;
  const withEmployer = rows.filter((r) => r.employerName != null).length;
  const withBornYear = rows.filter((r) => r.bornYear != null).length;
  const withNetWorth = rows.filter((r) => r.netWorthNum != null).length;
  const totalCareerEntries = rows.reduce((s, r) => s + r.careerHistoryCount, 0);

  const stats = [
    { label: "People", value: String(rows.length) },
    { label: "With Role Data", value: String(withRole) },
    { label: "With Employer", value: String(withEmployer) },
    { label: "With Birth Year", value: String(withBornYear) },
    { label: "With Net Worth", value: String(withNetWorth) },
    { label: "Career Entries", value: String(totalCareerEntries) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          People
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of key people in AI safety, frontier AI research, policy,
          and effective altruism tracked in the knowledge base.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <PeopleTable rows={rows} />
    </div>
  );
}
