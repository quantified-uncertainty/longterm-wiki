import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchDetailed, fetchFromWikiServer } from "@/lib/wiki-server";
import { ProfileStatCard } from "@/components/directory";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  RACE_STATUS_COLORS,
  AI_STANCE_COLORS,
  AI_STANCE_LABELS,
  RACE_LEVEL_LABELS,
  CANDIDATE_STATUS_COLORS,
} from "../races-constants";

/**
 * Race data lives in Postgres and is fetched from the wiki-server at request
 * time. Force dynamic rendering so Next.js does not attempt to statically
 * generate these pages (which would 404 when the wiki-server is unreachable
 * during the build).
 */
export const dynamic = "force-dynamic";

interface RaceDetail {
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
  measureTitle: string | null;
  measureDescription: string | null;
  source: string | null;
  notes: string | null;
  candidates: CandidateDetail[];
}

interface CandidateDetail {
  id: string;
  candidateDisplayName: string;
  candidate: { entityId: string | null; slug: string | null; name: string | null };
  status: string;
  aiStance: string | null;
  isIncumbent: boolean;
  isWinner: boolean;
  voteShare: number | null;
  party: string | null;
  endorsements: string | null;
  pacDisplayName: string | null;
  pac: { entityId: string | null; slug: string | null; name: string | null };
  pacAmount: number | null;
  pacPosition: string | null;
  source: string | null;
  notes: string | null;
}

type Params = Promise<{ id: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  const race = await fetchFromWikiServer<RaceDetail>(
    `/api/political-races/${id}`,
    { revalidate: 300 },
  );

  return {
    title: race?.name ?? "Political Race",
    description: race?.aiAngle ?? "Political race tracked for AI policy relevance.",
  };
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `\$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `\$${(amount / 1_000).toFixed(0)}K`;
  return `\$${amount.toFixed(0)}`;
}

/** Extract the domain from a URL for compact display. */
function extractSourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function RaceDetailPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const result = await fetchDetailed<RaceDetail>(
    `/api/political-races/${id}`,
    { revalidate: 300 },
  );

  if (!result.ok) {
    // Distinguish "race not found" (server returned 404) from "server
    // unreachable / misconfigured". Only the former should be a true 404.
    if (
      result.error.type === "server-error" &&
      result.error.status === 404
    ) {
      return notFound();
    }
    // For connection errors or non-404 server errors, show a user-friendly
    // message instead of a misleading 404.
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <nav className="text-sm text-muted-foreground mb-4">
          <Link href="/races" className="hover:underline">
            Political Races
          </Link>
        </nav>
        <h1 className="text-2xl font-bold mb-2">Unable to load race</h1>
        <p className="text-muted-foreground">
          The race data could not be loaded at this time. Please try again
          later or return to the{" "}
          <Link href="/races" className="text-blue-600 dark:text-blue-400 hover:underline">
            races directory
          </Link>.
        </p>
      </div>
    );
  }

  const race = result.data;

  const proRegCandidates = race.candidates.filter((c) => c.aiStance === "pro_regulation");
  const antiRegCandidates = race.candidates.filter((c) => c.aiStance === "anti_regulation");
  const totalPacSpending = race.candidates.reduce(
    (sum, c) => sum + (c.pacAmount ?? 0),
    0,
  );

  const titlePills = (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        RACE_STATUS_COLORS[race.status] ?? ""
      }`}
    >
      {race.status}
    </span>
  );

  const metadata = (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{RACE_LEVEL_LABELS[race.level] ?? race.level}</span>
      {race.district && <span>{race.district}</span>}
      {race.state && <span>{race.state}</span>}
      {race.electionDate && <span>Election: {race.electionDate}</span>}
      {race.party && <span className="capitalize">{race.party}</span>}
    </span>
  );

  const headerLinks = [
    { label: "Data", href: `/races/${race.id}/data` },
  ];

  const statCards = (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <ProfileStatCard label="Candidates" value={String(race.candidates.length)} />
      <ProfileStatCard label="Pro-regulation" value={String(proRegCandidates.length)} />
      <ProfileStatCard label="Anti-regulation" value={String(antiRegCandidates.length)} />
      <ProfileStatCard
        label="PAC Spending"
        value={totalPacSpending > 0 ? formatCurrency(totalPacSpending) : "—"}
      />
    </div>
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "Political Races", href: "/races" },
        { label: race.name },
      ]}
      title={race.name}
      titlePills={titlePills}
      metadata={metadata}
      headerLinks={headerLinks}
      statCards={statCards}
    >
      <div className="space-y-6">
        {/* AI Angle */}
        {(race.aiAngle || race.aiAngleSummary) && (
          <div className="rounded-lg border bg-rose-50 dark:bg-rose-950/20 p-4">
            <h2 className="font-semibold text-rose-900 dark:text-rose-200 mb-1">
              AI Policy Relevance
            </h2>
            {race.aiAngle && (
              <p className="text-sm font-medium text-rose-800 dark:text-rose-300 mb-1">
                {race.aiAngle}
              </p>
            )}
            {race.aiAngleSummary && (
              <p className="text-sm text-rose-700 dark:text-rose-400">
                {race.aiAngleSummary}
              </p>
            )}
          </div>
        )}

        {/* Ballot measure info */}
        {race.raceType === "ballot_measure" && (race.measureTitle || race.measureDescription) && (
          <div className="rounded-lg border p-4">
            <h2 className="font-semibold mb-1">
              {race.measureTitle ?? "Ballot Measure"}
            </h2>
            {race.measureDescription && (
              <p className="text-sm text-muted-foreground">
                {race.measureDescription}
              </p>
            )}
          </div>
        )}

        {/* Outcome */}
        {race.outcomeDetails && (
          <div className="rounded-lg border bg-green-50 dark:bg-green-950/20 p-4">
            <h2 className="font-semibold text-green-900 dark:text-green-200 mb-1">
              Outcome
            </h2>
            <p className="text-sm text-green-800 dark:text-green-300">
              {race.outcomeDetails}
            </p>
          </div>
        )}

        {/* Candidates table */}
        <section>
          <h2 className="text-xl font-semibold mb-3">Candidates</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Candidate</th>
                  <th className="pb-2 pr-4 font-medium">Party</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">AI Stance</th>
                  <th className="pb-2 pr-4 font-medium">PAC</th>
                  <th className="pb-2 pr-4 font-medium text-right">PAC Spend</th>
                  <th className="pb-2 pr-4 font-medium text-right">Vote %</th>
                </tr>
              </thead>
              <tbody>
                {race.candidates.map((c) => (
                  <tr key={c.id} className="border-b hover:bg-muted/50">
                    <td className="py-2 pr-4">
                      {c.candidate.slug ? (
                        <Link
                          href={`/people/${c.candidate.slug}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                        >
                          {c.candidateDisplayName}
                        </Link>
                      ) : (
                        <span className="font-medium">{c.candidateDisplayName}</span>
                      )}
                      {c.isIncumbent && (
                        <span className="ml-1 text-xs text-muted-foreground">(I)</span>
                      )}
                      {c.isWinner && (
                        <span className="ml-1 text-green-600 text-xs font-medium">Winner</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 capitalize">
                      {c.party ?? "—"}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          CANDIDATE_STATUS_COLORS[c.status] ?? ""
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      {c.aiStance ? (
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            AI_STANCE_COLORS[c.aiStance] ?? ""
                          }`}
                        >
                          {AI_STANCE_LABELS[c.aiStance] ?? c.aiStance}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {c.pac.slug ? (
                        <Link
                          href={`/organizations/${c.pac.slug}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline text-xs"
                        >
                          {c.pac.name ?? c.pacDisplayName}
                        </Link>
                      ) : (
                        <span className="text-xs">{c.pacDisplayName ?? "—"}</span>
                      )}
                      {c.pacPosition && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({c.pacPosition})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {c.pacAmount != null ? formatCurrency(c.pacAmount) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {c.voteShare != null
                        ? `${(c.voteShare * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Linked policy */}
        {race.policy.slug && (
          <div className="text-sm">
            <span className="text-muted-foreground">Linked policy: </span>
            <Link
              href={`/legislation/${race.policy.slug}`}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {race.policy.name ?? race.policy.slug}
            </Link>
          </div>
        )}

        {/* Source */}
        {race.source && (
          <div className="text-sm">
            <span className="text-muted-foreground">Source: </span>
            <a
              href={race.source}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {extractSourceDomain(race.source)}
            </a>
          </div>
        )}

        {/* Notes */}
        {race.notes && (
          <div className="rounded-lg border p-3">
            <h3 className="text-sm font-semibold mb-1">Notes</h3>
            <p className="text-sm text-muted-foreground">{race.notes}</p>
          </div>
        )}
      </div>
    </EntityProfileShell>
  );
}
