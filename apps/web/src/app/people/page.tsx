import { Suspense } from "react";
import type { Metadata } from "next";
import { getKBEntities, getKBLatest, getKBRecords, getKBFacts, getKBEntity, getKBEntitySlug } from "@/data/factbase";
import type { Fact } from "@longterm-wiki/factbase";
import { ProfileStatCard } from "@/components/directory";
import { PeopleTable, type PersonRow } from "./people-table";
import { getExpertById, getPublicationsForPerson, getTypedEntities, isPerson } from "@/data";
import { fetchDetailed } from "@lib/wiki-server";
import Link from "next/link";

export const metadata: Metadata = {
  title: "People",
  description:
    "Directory of key people in AI safety, frontier AI research, policy, and effective altruism with roles, affiliations, and key metrics.",
};

// ── Types for API response ────────────────────────────────────────────────

interface DirectoryFact {
  value: string | null;
  numeric: number | null;
  asOf: string | null;
  label: string | null;
  format: string | null;
  formatDivisor: number | null;
}

interface DirectoryEntity {
  id: string;
  numericId: string | null;
  stableId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  facts: Record<string, DirectoryFact>;
  resolvedRefs: Record<string, { name: string; entityId: string }>;
  counts: { careerHistory: number; grantsGiven: number; grantsReceived: number };
}

interface DirectoryResult {
  entities: DirectoryEntity[];
  total: number;
}

// ── API-first data loading ────────────────────────────────────────────────

const PERSON_MEASURES = ["role", "employed-by", "born-year", "net-worth"];

function apiEntityToPersonRow(e: DirectoryEntity): PersonRow {
  const role = e.facts["role"];
  const bornYear = e.facts["born-year"];
  const netWorth = e.facts["net-worth"];
  const employer = e.resolvedRefs["employed-by"];

  // Expert data from entity metadata (synced from experts.yaml)
  const meta = e.metadata ?? {};
  const expertPositions = meta.expertPositions as Array<{ topic: string; view: string }> | undefined;
  const knownFor = meta.knownFor as string[] | undefined;
  const publicationCount = (meta.publicationCount as number) ?? 0;
  const topics = expertPositions?.map((p) => p.topic) ?? [];

  // Build search text from all available API data
  const searchParts: string[] = [e.title];
  if (e.description) searchParts.push(e.description);
  if (role?.value) searchParts.push(role.value);
  if (employer?.name) searchParts.push(employer.name);
  if (e.tags) searchParts.push(...e.tags);
  if (knownFor) searchParts.push(...knownFor);
  if (expertPositions) {
    for (const p of expertPositions) {
      searchParts.push(p.topic, p.view);
    }
  }

  return {
    id: e.stableId ?? e.id,
    slug: e.id,
    name: e.title,
    numericId: e.numericId ?? null,
    wikiPageId: e.numericId ?? null,

    role: role?.value ?? null,

    employerId: employer?.entityId ?? null,
    employerName: employer?.name ?? null,
    employerSlug: employer ? getKBEntitySlug(employer.entityId) ?? null : null,

    bornYear: bornYear?.numeric ?? null,
    netWorthNum: netWorth?.numeric ?? null,

    positionCount: expertPositions?.length ?? 0,
    topics,
    publicationCount,
    careerHistoryCount: e.counts.careerHistory,

    searchText: searchParts.join(" ").toLowerCase(),
  };
}

async function loadFromApi(): Promise<{ rows: PersonRow[]; source: "api" | "local" }> {
  const result = await fetchDetailed<DirectoryResult>(
    `/api/entities/directory?entityType=person&measures=${PERSON_MEASURES.join(",")}`,
    { revalidate: 60 },
  );

  if (result.ok) {
    return {
      rows: result.data.entities.map(apiEntityToPersonRow),
      source: "api",
    };
  }

  // Log fallback reason to server console — not shown to users
  const reason = !result.ok && result.error
    ? `type=${result.error.type}${"message" in result.error ? `, message=${result.error.message}` : ""}`
    : "unknown";
  console.warn(`[people] Using local data (wiki-server unavailable: ${reason})`);

  return { rows: loadFromLocal(), source: "local" };
}

// ── Local data loading (fallback) ─────────────────────────────────────────

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

/** Properties already handled explicitly or not useful for search (URLs/handles). */
const SKIP_PROPERTIES = new Set(['role', 'employed-by', 'social-media', 'google-scholar', 'github-profile', 'wikipedia-url']);

function loadFromLocal(): PersonRow[] {
  // Start with KB-backed people (rich data: facts, records, career history)
  const kbPeople = getKBEntities().filter((e) => e.type === "person");
  const kbSlugs = new Set<string>();

  const rows: PersonRow[] = kbPeople.map((entity) => {
    const roleFact = getKBLatest(entity.id, "role");
    const employedByFact = getKBLatest(entity.id, "employed-by");
    const bornYearFact = getKBLatest(entity.id, "born-year");
    const netWorthFact = getKBLatest(entity.id, "net-worth");

    const careerHistory = getKBRecords(entity.id, "career-history");
    const employer = resolveRef(employedByFact);

    const slug = getKBEntitySlug(entity.id) ?? entity.id;
    kbSlugs.add(slug);
    const expert = getExpertById(slug);
    const positionCount = expert?.positions?.length ?? 0;
    const topics = expert?.positions?.map((p) => p.topic) ?? [];
    const publications = getPublicationsForPerson(slug);

    const roleText = roleFact?.value.type === "text" ? roleFact.value.value : null;

    const searchParts: string[] = [entity.name];
    if (entity.aliases) searchParts.push(...entity.aliases);
    if (roleText) searchParts.push(roleText);
    if (employer?.name) searchParts.push(employer.name);
    if (expert?.positions) {
      for (const p of expert.positions) {
        searchParts.push(p.topic, p.view);
      }
    }
    if (expert?.knownFor) searchParts.push(...expert.knownFor);
    for (const pub of publications) {
      searchParts.push(pub.title);
    }
    for (const entry of careerHistory) {
      const fields = entry.fields;
      if (typeof fields.role === "string") searchParts.push(fields.role);
      if (typeof fields.title === "string") searchParts.push(fields.title);
      if (typeof fields.organization === "string") {
        searchParts.push(fields.organization);
        const org = getKBEntity(fields.organization);
        if (org && org.name !== fields.organization) {
          searchParts.push(org.name);
        }
      }
    }
    const allFacts = getKBFacts(entity.id);
    for (const fact of allFacts) {
      if (SKIP_PROPERTIES.has(fact.propertyId)) continue;
      if (fact.value.type === "text") {
        searchParts.push(fact.value.value);
      }
    }

    return {
      id: entity.id,
      slug,
      name: entity.name,
      numericId: entity.numericId ?? null,
      wikiPageId: entity.wikiPageId ?? entity.numericId ?? null,
      role: roleText,
      employerId: employer?.id ?? null,
      employerName: employer?.name ?? null,
      employerSlug: employer?.id ? getKBEntitySlug(employer.id) ?? null : null,
      bornYear: numericValue(bornYearFact),
      netWorthNum: numericValue(netWorthFact),
      positionCount,
      topics,
      publicationCount: publications.length,
      careerHistoryCount: careerHistory.length,
      searchText: searchParts.join(" ").toLowerCase(),
    };
  });

  // Merge in typed entity people that aren't in KB
  const typedPeople = getTypedEntities().filter(isPerson);
  for (const tp of typedPeople) {
    if (kbSlugs.has(tp.id)) continue;
    rows.push({
      id: tp.id,
      slug: tp.id,
      name: tp.title,
      numericId: tp.numericId ?? null,
      wikiPageId: tp.numericId ?? null,
      role: null,
      employerId: null,
      employerName: null,
      employerSlug: null,
      bornYear: null,
      netWorthNum: null,
      positionCount: 0,
      topics: [],
      publicationCount: 0,
      careerHistoryCount: 0,
      searchText: [tp.title, tp.description ?? ""].join(" ").toLowerCase(),
    });
  }

  return rows;
}

// ── Page component ────────────────────────────────────────────────────────

export default async function PeoplePage() {
  const { rows, source } = await loadFromApi();

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
          className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-primary hover:underline"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          View Network Graph
        </Link>
      </div>

      {source === "local" && (
        <p className="text-[11px] text-muted-foreground/50 mb-2">Using local data</p>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <Suspense fallback={<div>Loading...</div>}>
        <PeopleTable rows={rows} />
      </Suspense>
    </div>
  );
}
