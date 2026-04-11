/**
 * VoteRecord — displays a politician's voting record.
 *
 * Server component that accepts pre-fetched vote data as props.
 * Votes are sorted by date descending (most recent first) and displayed
 * as a list with yea/nay/abstain badges.
 *
 * Badge colors: Yea = green, Nay = red, Abstain/Not Voting/Present = gray
 *
 * Usage:
 *   import { VoteRecord, fetchPoliticalVotes } from "@/components/political";
 *   const votes = await fetchPoliticalVotes(entityId);
 *   <VoteRecord votes={votes} />
 */

import { cn } from "@/lib/utils";
import { safeHref, formatIntroducedDate } from "@/lib/format-compact";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";
import { getRecordVerdict } from "@data/tablebase";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import type { PoliticalVoteRecord } from "./types";

// ── Vote styling ────────────────────────────────────────────────────

const VOTE_STYLES: Record<string, { badge: string; label: string }> = {
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

function getVoteStyle(vote: string) {
  return (
    VOTE_STYLES[vote.toLowerCase()] ?? {
      badge: "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400",
      label: titleCase(vote),
    }
  );
}

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Chamber label ───────────────────────────────────────────────────

function chamberLabel(chamber: string | null): string | null {
  if (!chamber) return null;
  const lower = chamber.toLowerCase();
  if (lower === "senate") return "Senate";
  if (lower === "house") return "House";
  return titleCase(chamber);
}

// ── Sort votes ──────────────────────────────────────────────────────

function sortVotesByDate(votes: PoliticalVoteRecord[]): PoliticalVoteRecord[] {
  return [...votes].sort((a, b) => {
    const aDate = a.voteDate ?? "";
    const bDate = b.voteDate ?? "";
    return bDate.localeCompare(aDate);
  });
}

// ── Component ───────────────────────────────────────────────────────

export interface VoteRecordProps {
  votes: PoliticalVoteRecord[];
}

export function VoteRecord({ votes }: VoteRecordProps) {
  if (votes.length === 0) return null;

  const sorted = sortVotesByDate(votes);

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Voting Record
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {votes.length} {votes.length === 1 ? "vote" : "votes"}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/10">
                <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Legislation
                </th>
                <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Vote
                </th>
                <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Chamber
                </th>
                <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Date
                </th>
                <th className="text-left px-4 py-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Source
                </th>
                <th className="px-4 py-2 w-8">
                <span className="sr-only">Source check</span>
              </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((vote) => (
                <VoteRow key={vote.id} vote={vote} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ── Individual vote row ─────────────────────────────────────────────

function VoteRow({ vote }: { vote: PoliticalVoteRecord }) {
  const style = getVoteStyle(vote.vote);
  const chamber = chamberLabel(vote.chamber);

  return (
    <tr className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors">
      <td className="px-4 py-2.5 font-medium max-w-[300px]">
        {vote.legislationEntityId ? (
          <a
            href={`/wiki/${vote.legislationEntityId}`}
            className="text-foreground hover:text-primary transition-colors line-clamp-2"
          >
            {vote.legislationTitle ?? "Unknown Legislation"}
          </a>
        ) : (
          <span className="line-clamp-2">
            {vote.legislationTitle ?? "Unknown Legislation"}
          </span>
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
      <td className="px-4 py-2.5 text-xs text-muted-foreground">
        {chamber ?? "\u2014"}
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
      <td className="px-4 py-2.5 text-center">
        {(() => {
          const verdict = getRecordVerdict("political-vote", String(vote.id))?.verdict;
          return (
            <SourcingDot
              status={recordVerdictToStatus(verdict)}
              originalVerdict={verdict}
              size="md"
              href={getSourcingHref("political-vote", String(vote.id))}
            />
          );
        })()}
      </td>
    </tr>
  );
}
