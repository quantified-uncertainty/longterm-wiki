import type { Metadata } from "next";
import { fetchFromWikiServer } from "@/lib/wiki-server";
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
  // Fetch races (all, with ISR revalidation)
  const racesData = await fetchFromWikiServer<{
    races: RaceApiRow[];
    total: number;
  }>("/api/political-races/all?limit=200", { revalidate: 300 });

  const stats = await fetchFromWikiServer<StatsApiResult>(
    "/api/political-races/stats",
    { revalidate: 300 },
  );

  // Fetch each race's candidates
  const races = racesData?.races ?? [];
  const raceRows: RaceRow[] = await Promise.all(
    races.map(async (race) => {
      const detail = await fetchFromWikiServer<{
        candidates: CandidateRow[];
      }>(`/api/political-races/${race.id}`, { revalidate: 300 });

      return {
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
        candidates: detail?.candidates ?? [],
      };
    }),
  );

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
        <ProfileStatCard label="Total Races" value={String(raceStats.total)} />
        <ProfileStatCard label="Upcoming" value={String(raceStats.upcoming)} />
        <ProfileStatCard label="Active" value={String(raceStats.active)} />
        <ProfileStatCard label="Candidates" value={String(candidateStats.total)} />
      </div>

      {races.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No political races data available.</p>
          <p className="text-sm mt-2">
            Seed data with: <code>pnpm crux tb races seed</code>
          </p>
        </div>
      ) : (
        <RacesTable rows={raceRows} />
      )}
    </div>
  );
}
