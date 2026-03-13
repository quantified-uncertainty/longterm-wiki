import type { Metadata } from "next";
import Link from "next/link";
import { getKBEntities, getKBLatest, getKBRecords, getKBEntity, getKBEntitySlug } from "@/data/kb";
import type { Fact } from "@longterm-wiki/kb";
import { ProfileStatCard } from "@/components/directory";
import { PeopleTable, type PersonRow } from "./people-table";
import { getExpertById, getPublicationsForPerson } from "@/data";

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

    const slug = getKBEntitySlug(entity.id) ?? entity.id;
    const expert = getExpertById(slug);
    const positionCount = expert?.positions?.length ?? 0;
    const topics = expert?.positions?.map((p) => p.topic) ?? [];
    const publicationCount = getPublicationsForPerson(slug).length;

    return {
      id: entity.id,
      slug,
      name: entity.name,
      numericId: entity.numericId ?? null,
      wikiPageId: entity.wikiPageId ?? entity.numericId ?? null,

      role: roleFact?.value.type === "text" ? roleFact.value.value : null,

      employerId: employer?.id ?? null,
      employerName: employer?.name ?? null,

      bornYear: numericValue(bornYearFact),
      netWorthNum: numericValue(netWorthFact),

      positionCount,
      topics,
      publicationCount,
      careerHistoryCount: careerHistory.length,
    };
  });

  const withRole = rows.filter((r) => r.role != null).length;
  const withEmployer = rows.filter((r) => r.employerName != null).length;
  const withBornYear = rows.filter((r) => r.bornYear != null).length;
  const withNetWorth = rows.filter((r) => r.netWorthNum != null).length;
  const withPositions = rows.filter((r) => r.positionCount > 0).length;
  const withPublications = rows.filter((r) => r.publicationCount > 0).length;
  const totalCareerEntries = rows.reduce((s, r) => s + r.careerHistoryCount, 0);
  const uniqueTopics = new Set(rows.flatMap((r) => r.topics)).size;

  const stats = [
    { label: "People", value: String(rows.length) },
    { label: "With Role Data", value: String(withRole) },
    { label: "With Employer", value: String(withEmployer) },
    { label: "With Birth Year", value: String(withBornYear) },
    { label: "With Net Worth", value: String(withNetWorth) },
    { label: "With Expert Positions", value: String(withPositions) },
    { label: "With Publications", value: String(withPublications) },
    { label: "Career Entries", value: String(totalCareerEntries) },
    { label: "Topics Covered", value: String(uniqueTopics) },
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
        <Link
          href="/people/network"
          className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path d="M15.5 2A1.5 1.5 0 0014 3.5v13a1.5 1.5 0 001.5 1.5h1a1.5 1.5 0 001.5-1.5v-13A1.5 1.5 0 0016.5 2h-1zM9.5 6A1.5 1.5 0 008 7.5v9A1.5 1.5 0 009.5 18h1a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0010.5 6h-1zM3.5 10A1.5 1.5 0 002 11.5v5A1.5 1.5 0 003.5 18h1A1.5 1.5 0 006 16.5v-5A1.5 1.5 0 004.5 10h-1z" />
          </svg>
          View relationship network
        </Link>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <PeopleTable rows={rows} />
    </div>
  );
}
