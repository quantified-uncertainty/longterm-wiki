/**
 * LegislationVotes — shows the vote breakdown for a piece of legislation.
 *
 * Server component that accepts pre-fetched vote data as props.
 * Displays a tally summary bar and a detailed table of individual votes,
 * grouped by chamber (Senate/House) when both are present.
 *
 * Usage:
 *   import { LegislationVotes, fetchLegislationVotes } from "@/components/political";
 *   const votes = await fetchLegislationVotes(legislationEntityId);
 *   <LegislationVotes votes={votes} />
 */

import { cn } from "@/lib/utils";
import { safeHref, formatIntroducedDate } from "@/lib/format-compact";
import { getEntityHref } from "@/data/entity-nav";
import type { PoliticalVoteRecord } from "./types";

// ── Vote styling ────────────────────────────────────────────────────

const VOTE_BADGE: Record<string, { badge: string; label: string }> = {
  yea: {
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    label: "Yea",
  },
  nay: {
    badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    label: "Nay",
  },
  abstain: {
    badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
    label: "Abstain",
  },
  not_voting: {
    badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
    label: "Not Voting",
  },
  present: {
    badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
    label: "Present",
  },
};

function getVoteBadge(vote: string) {
  return (
    VOTE_BADGE[vote.toLowerCase()] ?? {
      badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
      label: titleCase(vote),
    }
  );
}

// ── Party styling ───────────────────────────────────────────────────

const PARTY_BADGE: Record<string, string> = {
  democratic: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  republican: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  independent: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

function partyBadgeClass(party: string | null): string | null {
  if (!party) return null;
  return (
    PARTY_BADGE[party.toLowerCase()] ??
    "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400"
  );
}

// ── Label formatting ────────────────────────────────────────────────

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function chamberLabel(chamber: string | null): string {
  if (!chamber) return "Unknown";
  const lower = chamber.toLowerCase();
  if (lower === "senate") return "Senate";
  if (lower === "house") return "House";
  return titleCase(chamber);
}

// ── Tally computation ───────────────────────────────────────────────

interface VoteTally {
  yea: number;
  nay: number;
  abstain: number;
  other: number;
  total: number;
}

function computeTally(votes: PoliticalVoteRecord[]): VoteTally {
  let yea = 0;
  let nay = 0;
  let abstain = 0;
  let other = 0;

  for (const v of votes) {
    const lower = v.vote.toLowerCase();
    if (lower === "yea") yea++;
    else if (lower === "nay") nay++;
    else if (lower === "abstain" || lower === "not_voting" || lower === "present")
      abstain++;
    else other++;
  }

  return { yea, nay, abstain, other, total: votes.length };
}

// ── Chamber grouping ────────────────────────────────────────────────

interface ChamberGroup {
  chamber: string;
  label: string;
  votes: PoliticalVoteRecord[];
  tally: VoteTally;
}

/**
 * Group votes by chamber. Returns null if there's only a single group
 * (all votes are from the same chamber or no chamber specified).
 */
function groupByChamber(
  votes: PoliticalVoteRecord[]
): ChamberGroup[] | null {
  const map = new Map<string, PoliticalVoteRecord[]>();
  for (const v of votes) {
    const key = v.chamber?.toLowerCase() ?? "unknown";
    const existing = map.get(key);
    if (existing) existing.push(v);
    else map.set(key, [v]);
  }

  if (map.size <= 1) return null;

  // Sort: Senate first, then House, then others
  const order: Record<string, number> = { senate: 0, house: 1 };
  return Array.from(map.entries())
    .map(([key, votes]) => ({
      chamber: key,
      label: chamberLabel(key === "unknown" ? null : key),
      votes: sortVotesByName(votes),
      tally: computeTally(votes),
    }))
    .sort((a, b) => (order[a.chamber] ?? 9) - (order[b.chamber] ?? 9));
}

function sortVotesByName(
  votes: PoliticalVoteRecord[]
): PoliticalVoteRecord[] {
  return [...votes].sort((a, b) => {
    const aName = a.politicianDisplayName ?? "";
    const bName = b.politicianDisplayName ?? "";
    return aName.localeCompare(bName);
  });
}

// ── Component ───────────────────────────────────────────────────────

export interface LegislationVotesProps {
  votes: PoliticalVoteRecord[];
}

export function LegislationVotes({ votes }: LegislationVotesProps) {
  if (votes.length === 0) return null;

  const overallTally = computeTally(votes);
  const chambers = groupByChamber(votes);

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Vote Breakdown
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {votes.length} {votes.length === 1 ? "vote" : "votes"}
        </span>
      </h2>

      {/* Overall tally bar */}
      <TallySummary tally={overallTally} />

      {/* Votes table — grouped by chamber or as a single table */}
      <div className="mt-3 space-y-3">
        {chambers ? (
          chambers.map((group) => (
            <ChamberSection key={group.chamber} group={group} />
          ))
        ) : (
          <VotesTable votes={sortVotesByName(votes)} />
        )}
      </div>
    </section>
  );
}

// ── Tally summary bar ───────────────────────────────────────────────

function TallySummary({ tally }: { tally: VoteTally }) {
  const { yea, nay, abstain, other, total } = tally;

  return (
    <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
      <div className="p-4">
        {/* Tally numbers */}
        <div className="flex items-center gap-6 mb-3">
          <TallyBadge
            label="Yea"
            count={yea}
            className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
          />
          <TallyBadge
            label="Nay"
            count={nay}
            className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
          />
          {(abstain > 0 || other > 0) && (
            <TallyBadge
              label="Abstain"
              count={abstain + other}
              className="bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400"
            />
          )}
        </div>

        {/* Stacked bar */}
        {total > 0 && (
          <div
            className="flex h-3 rounded-full overflow-hidden bg-muted/30"
            role="img"
            aria-label={`Vote tally: ${yea} yea, ${nay} nay, ${abstain + other} abstain`}
          >
            {yea > 0 && (
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${(yea / total) * 100}%` }}
                title={`Yea: ${yea}`}
              />
            )}
            {nay > 0 && (
              <div
                className="h-full bg-red-500 transition-all"
                style={{ width: `${(nay / total) * 100}%` }}
                title={`Nay: ${nay}`}
              />
            )}
            {abstain + other > 0 && (
              <div
                className="h-full bg-gray-400 transition-all"
                style={{ width: `${((abstain + other) / total) * 100}%` }}
                title={`Abstain/Other: ${abstain + other}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TallyBadge({
  label,
  count,
  className,
}: {
  label: string;
  count: number;
  className: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "inline-block px-2.5 py-1 rounded-lg text-sm font-bold tabular-nums",
          className
        )}
      >
        {count}
      </span>
      <span className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

// ── Chamber section ─────────────────────────────────────────────────

function ChamberSection({ group }: { group: ChamberGroup }) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-sm font-semibold">{group.label}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {group.tally.yea}Y &ndash; {group.tally.nay}N
          {group.tally.abstain > 0 && ` \u2013 ${group.tally.abstain}A`}
        </span>
      </div>
      <VotesTable votes={group.votes} />
    </div>
  );
}

// ── Votes table ─────────────────────────────────────────────────────

function VotesTable({ votes }: { votes: PoliticalVoteRecord[] }) {
  return (
    <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 bg-muted/10">
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Politician
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Party
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Vote
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Date
              </th>
              <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            {votes.map((vote) => (
              <LegislationVoteRow key={vote.id} vote={vote} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Individual vote row ─────────────────────────────────────────────

/**
 * Extracts party from the vote record. The PoliticalVoteRecord doesn't have
 * a direct party field, so this returns null. In a future version, the API
 * may include party information on the vote record or we can cross-reference
 * with the entity data.
 */
function extractParty(_vote: PoliticalVoteRecord): string | null {
  // The PoliticalVoteRecord type doesn't include a party field.
  // This is a placeholder for when the backend enriches votes with party info.
  return null;
}

function LegislationVoteRow({ vote }: { vote: PoliticalVoteRecord }) {
  const style = getVoteBadge(vote.vote);
  const party = extractParty(vote);
  const partyClass = partyBadgeClass(party);

  return (
    <tr className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors">
      <td className="px-4 py-2.5 font-medium">
        {vote.politicianEntityId ? (
          <a
            href={getEntityHref(vote.politicianEntityId)}
            className="text-foreground hover:text-primary transition-colors"
          >
            {vote.politicianDisplayName ?? "Unknown"}
          </a>
        ) : (
          <span>{vote.politicianDisplayName ?? "Unknown"}</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {party && partyClass ? (
          <span
            className={cn(
              "inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold",
              partyClass
            )}
          >
            {titleCase(party)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">&mdash;</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <span
          className={cn(
            "inline-block px-2 py-0.5 rounded-full text-xs font-semibold",
            style.badge
          )}
        >
          {style.label}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
        {formatIntroducedDate(vote.voteDate) ?? "\u2014"}
      </td>
      <td className="px-4 py-2.5 text-xs">
        {vote.sourceUrl ? (
          <a
            href={safeHref(vote.sourceUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Source
          </a>
        ) : (
          <span className="text-muted-foreground/40">&mdash;</span>
        )}
      </td>
    </tr>
  );
}
