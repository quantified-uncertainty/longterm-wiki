import type { Metadata } from "next";
import { fetchFromWikiServer } from "@/lib/wiki-server";
import { getRecordVerdict } from "@/data/tablebase";
import { ProfileStatCard } from "@/components/directory";
import { RACE_LEVEL_LABELS } from "./races-constants";
import { RacesTable, type RaceRow, type CandidateRow } from "./races-table";

export const metadata: Metadata = {
  title: "Political Races",
  description:
    "Directory of AI-relevant political races tracked in the knowledge base, including 2026 midterms and ballot measures.",
};

interface RaceApiRow {
  id: string;
  name: string;
  raceType: string;
  party: string | null;
  level: string;
  state: string | null;
  district: string | null;
  electionDate: string | null;
  status: string;
  outcome: string | null;
  outcomeDetails: string | null;
  aiAngle: string | null;
  aiAngleSummary: string | null;
  policy: { entityId: string | null; slug: string | null; name: string | null };
  source: string | null;
}

interface StatsApiResult {
  races: { total: number; upcoming: number; active: number; resolved: number };
  candidates: { total: number };
}

export default async function RacesPage() {
  // Fetch races, stats, and all candidates in 3 parallel bulk calls (not per-race)
  const [racesData, stats, candidatesData] = await Promise.all([
    fetchFromWikiServer<{
      races: RaceApiRow[];
      total: number;
    }>("/api/political-races/all?limit=200", { revalidate: 300 }),
    fetchFromWikiServer<StatsApiResult>(
      "/api/political-races/stats",
      { revalidate: 300 },
    ),
    fetchFromWikiServer<{
      candidates: (CandidateRow & { raceId: string })[];
      total: number;
    }>("/api/political-races/candidates/all?limit=1000", { revalidate: 300 }),
  ]);

  // Group candidates by raceId for O(1) lookup, attaching verdict data
  const candidatesByRace = new Map<string, CandidateRow[]>();
  for (const c of candidatesData?.candidates ?? []) {
    const list = candidatesByRace.get(c.raceId) ?? [];
    list.push({
      ...c,
      verdictString: getRecordVerdict("race-candidate", String(c.id))?.verdict ?? null,
    });
    candidatesByRace.set(c.raceId, list);
  }

  const races = racesData?.races ?? [];
  const raceRows: RaceRow[] = races.map((race) => ({
    id: race.id,
    name: race.name,
    raceType: race.raceType,
    party: race.party,
    level: race.level,
    state: race.state,
    district: race.district,
    electionDate: race.electionDate,
    status: race.status,
    outcome: race.outcome,
    outcomeDetails: race.outcomeDetails,
    aiAngle: race.aiAngle,
    candidates: candidatesByRace.get(race.id) ?? [],
    verdictString: getRecordVerdict("race", String(race.id))?.verdict ?? null,
  }));

  const raceStats = stats?.races ?? { total: 0, upcoming: 0, active: 0, resolved: 0 };
  const candidateStats = stats?.candidates ?? { total: 0 };

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Political Races</h1>
        <p className="text-muted-foreground">
          AI-relevant political races, including 2026 midterm primaries and
          ballot measures. Tracks candidates, PAC spending, and AI policy
          stances.
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <ProfileStatCard label="Upcoming" value={String(raceStats.upcoming)} />
        <ProfileStatCard label="Active" value={String(raceStats.active)} />
        <ProfileStatCard label="Resolved" value={String(raceStats.resolved)} />
        <ProfileStatCard label="Candidates" value={String(candidateStats.total)} />
      </div>

      {races.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No political races data available yet.</p>
          <p className="text-sm mt-2">
            Check back soon — data will be added as elections approach.
          </p>
        </div>
      ) : (
        <RacesTable rows={raceRows} />
      )}
    </div>
  );
}
