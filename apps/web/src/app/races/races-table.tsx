"use client";

import { Fragment, useState, useMemo } from "react";
import Link from "next/link";
import { ChevronRight, ChevronDown } from "lucide-react";
import {
  RACE_STATUS_COLORS,
  AI_STANCE_COLORS,
  AI_STANCE_LABELS,
  RACE_LEVEL_LABELS,
} from "./races-constants";

export interface RaceRow {
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
  candidates: CandidateRow[];
}

export interface CandidateRow {
  id: string;
  candidateDisplayName: string;
  candidate: { entityId: string | null; slug: string | null; name: string | null };
  status: string;
  aiStance: string | null;
  pacDisplayName: string | null;
  pac: { entityId: string | null; slug: string | null; name: string | null };
  pacAmount: number | null;
  pacPosition: string | null;
  voteShare: number | null;
  isWinner: boolean;
  isIncumbent: boolean;
  party: string | null;
}

const PAGE_SIZE = 20;

export function RacesTable({ rows }: { rows: RaceRow[] }) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [expandedRace, setExpandedRace] = useState<string | null>(null);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.status);
    return [...set].sort();
  }, [rows]);

  const levels = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.level);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (levelFilter !== "all" && r.level !== levelFilter) return false;
      return true;
    });
  }, [rows, statusFilter, levelFilter]);

  function formatCurrency(amount: number): string {
    if (amount >= 1_000_000) return `\$${(amount / 1_000_000).toFixed(1)}M`;
    if (amount >= 1_000) return `\$${(amount / 1_000).toFixed(0)}K`;
    return `\$${amount.toFixed(0)}`;
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border px-3 py-1.5 text-sm bg-background"
        >
          <option value="all">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="rounded-md border px-3 py-1.5 text-sm bg-background"
        >
          <option value="all">All levels</option>
          {levels.map((l) => (
            <option key={l} value={l}>
              {RACE_LEVEL_LABELS[l] ?? l}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground self-center">
          {filtered.length} race{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 pr-4 font-medium">Race</th>
              <th className="pb-2 pr-4 font-medium">Level</th>
              <th className="pb-2 pr-4 font-medium">Date</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">AI Angle</th>
              <th className="pb-2 pr-4 font-medium">Candidates</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((race) => (
              <Fragment key={race.id}>
                <tr
                  className="border-b hover:bg-muted/50 cursor-pointer"
                  onClick={() =>
                    setExpandedRace(expandedRace === race.id ? null : race.id)
                  }
                >
                  <td className="py-2 pr-4">
                    <span className="inline-flex items-center gap-1">
                      {expandedRace === race.id ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      )}
                      <Link
                        href={`/races/${race.id}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {race.name}
                      </Link>
                      {race.district ? (
                        <span className="text-muted-foreground ml-1 text-xs">
                          ({race.district})
                        </span>
                      ) : race.state ? (
                        <span className="text-muted-foreground ml-1 text-xs">
                          ({race.state})
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    {RACE_LEVEL_LABELS[race.level] ?? race.level}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {race.electionDate ?? "TBD"}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        RACE_STATUS_COLORS[race.status] ?? ""
                      }`}
                    >
                      {race.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 min-w-0 text-muted-foreground">
                    <p
                      className="line-clamp-2 text-sm"
                      title={race.aiAngle ?? undefined}
                    >
                      {race.aiAngle ?? "—"}
                    </p>
                  </td>
                  <td className="py-2 pr-4 text-center">
                    {race.candidates.length}
                  </td>
                </tr>
                {expandedRace === race.id && race.candidates.length > 0 && (
                  <tr key={`${race.id}-expanded`}>
                    <td colSpan={6} className="pb-3 pt-1 pl-8">
                      <div className="rounded-md border bg-muted/30 p-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-muted-foreground">
                              <th className="pb-1 pr-3">Candidate</th>
                              <th className="pb-1 pr-3">Party</th>
                              <th className="pb-1 pr-3">Status</th>
                              <th className="pb-1 pr-3">AI Stance</th>
                              <th className="pb-1 pr-3">PAC</th>
                              <th className="pb-1 pr-3 text-right">PAC Spend</th>
                              <th className="pb-1 pr-3 text-right">Vote %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {race.candidates.map((c) => (
                              <tr key={c.id} className="border-t border-muted">
                                <td className="py-1 pr-3">
                                  {c.candidate.slug ? (
                                    <Link
                                      href={`/people/${c.candidate.slug}`}
                                      className="text-blue-600 dark:text-blue-400 hover:underline"
                                    >
                                      {c.candidateDisplayName}
                                    </Link>
                                  ) : (
                                    c.candidateDisplayName
                                  )}
                                  {c.isIncumbent && (
                                    <span className="ml-1 text-muted-foreground">(I)</span>
                                  )}
                                  {c.isWinner && (
                                    <span className="ml-1 text-green-600">✓</span>
                                  )}
                                </td>
                                <td className="py-1 pr-3 capitalize">{c.party ?? "—"}</td>
                                <td className="py-1 pr-3">{c.status}</td>
                                <td className="py-1 pr-3">
                                  {c.aiStance ? (
                                    <span
                                      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs ${
                                        AI_STANCE_COLORS[c.aiStance] ?? ""
                                      }`}
                                    >
                                      {AI_STANCE_LABELS[c.aiStance] ?? c.aiStance}
                                    </span>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td className="py-1 pr-3">
                                  {c.pac.slug ? (
                                    <Link
                                      href={`/organizations/${c.pac.slug}`}
                                      className="text-blue-600 dark:text-blue-400 hover:underline"
                                    >
                                      {c.pac.name ?? c.pacDisplayName}
                                    </Link>
                                  ) : (
                                    c.pacDisplayName ?? "—"
                                  )}
                                </td>
                                <td className="py-1 pr-3 text-right">
                                  {c.pacAmount != null
                                    ? formatCurrency(c.pacAmount)
                                    : "—"}
                                </td>
                                <td className="py-1 pr-3 text-right">
                                  {c.voteShare != null
                                    ? `${(c.voteShare * 100).toFixed(0)}%`
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          No races match the current filters.
        </div>
      )}
    </div>
  );
}
