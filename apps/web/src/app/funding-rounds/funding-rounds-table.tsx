"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { computeFundingRoundCoverage } from "@/components/coverage/coverage-score";
import { PaginationControls } from "@/components/directory/PaginationControls";
import type { RecordVerdict } from "@/data/tablebase";
import { formatCompactCurrency } from "@/lib/format-compact";
import { compareFundingRoundRows, type SortDir, type FundingRoundSortKey } from "./funding-rounds-sort";
import { INSTRUMENT_COLORS } from "./funding-rounds-constants";

const INSTRUMENT_LABELS: Record<string, string> = {
  "convertible-note": "Convertible Note",
  safe: "SAFE",
  equity: "Equity",
  debt: "Debt",
  grant: "Grant",
};

function instrumentLabel(s: string): string {
  return INSTRUMENT_LABELS[s] ?? s.replace(/(?:^|\s|-)\w/g, (m) => m.toUpperCase());
}

export interface FundingRoundRow {
  key: string;
  name: string;
  companyName: string;
  companyHref: string | null;
  date: string | null;
  raised: number | null;
  valuation: number | null;
  instrument: string | null;
  leadInvestorName: string;
  leadInvestorHref: string | null;
  verdict: RecordVerdict | null;
}

const PAGE_SIZE = 50;

export function FundingRoundsTable({ rows }: { rows: FundingRoundRow[] }) {
  const [search, setSearch] = useState("");
  const [instrumentFilter, setInstrumentFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<FundingRoundSortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  // Instrument filter options
  const instruments = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.instrument) set.add(r.instrument);
    }
    return [...set].sort();
  }, [rows]);

  const instrumentCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const key = r.instrument ?? "unknown";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const handleSort = (key: FundingRoundSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(
        key === "name" || key === "company" || key === "instrument" || key === "leadInvestor"
          ? "asc"
          : "desc",
      );
    }
    setPage(0);
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (instrumentFilter !== "all") {
      result = result.filter((r) => r.instrument === instrumentFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.companyName.toLowerCase().includes(q) ||
          (r.leadInvestorName && r.leadInvestorName.toLowerCase().includes(q)),
      );
    }

    result = [...result].sort((a, b) => compareFundingRoundRows(a, b, sortKey, sortDir));

    return result;
  }, [rows, search, instrumentFilter, sortKey, sortDir]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <input
          type="text"
          placeholder="Search rounds, companies, investors..."
          aria-label="Search funding rounds"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />

        {/* Instrument filter */}
        {instruments.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground mr-1 self-center">
              Instrument:
            </span>
            <button
              type="button"
              onClick={() => {
                setInstrumentFilter("all");
                setPage(0);
              }}
              aria-pressed={instrumentFilter === "all"}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                instrumentFilter === "all"
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              All
              <span className="ml-1 text-[10px] opacity-60">
                {instrumentCounts.all}
              </span>
            </button>
            {instruments.map((inst) => (
              <button
                type="button"
                key={inst}
                onClick={() => {
                  setInstrumentFilter(instrumentFilter === inst ? "all" : inst);
                  setPage(0);
                }}
                aria-pressed={instrumentFilter === inst}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  instrumentFilter === inst
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {instrumentLabel(inst)}
                <span className="ml-1 text-[10px] opacity-60">
                  {instrumentCounts[inst] ?? 0}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results count + pagination */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {rows.length} rounds
        </div>
        <PaginationControls
          page={page}
          pageCount={totalPages}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={(p) => setPage(p)}
        />
      </div>

      {/* Table */}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30 sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Round" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Company" sortKey="company" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Raised" sortKey="raised" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Valuation" sortKey="valuation" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Instrument" sortKey="instrument" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Lead Investor" sortKey="leadInvestor" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Date" sortKey="date" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <th className="py-2.5 px-3 font-medium text-center hidden sm:table-cell">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {pageRows.map((row) => (
              <tr
                key={row.key}
                className="hover:bg-muted/20 transition-colors"
              >
                <td className="py-2 px-3">
                  <span className="flex items-center gap-1.5">
                    <Link
                      href={`/funding-rounds/${row.key}`}
                      className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                    >
                      {row.name}
                    </Link>
                  </span>
                </td>
                <td className="py-2 px-3 text-xs">
                  {row.companyHref ? (
                    <Link
                      href={row.companyHref}
                      className="text-primary hover:underline"
                    >
                      {row.companyName}
                    </Link>
                  ) : (
                    <span className="text-foreground">{row.companyName}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {row.raised != null && row.raised > 0 ? (
                    <span className="font-semibold">
                      {formatCompactCurrency(row.raised)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                  {row.valuation != null && row.valuation > 0
                    ? formatCompactCurrency(row.valuation)
                    : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                </td>
                <td className="py-2 px-3 text-xs">
                  {row.instrument ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        INSTRUMENT_COLORS[row.instrument] ??
                        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {instrumentLabel(row.instrument)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-xs">
                  {row.leadInvestorHref ? (
                    <Link
                      href={row.leadInvestorHref}
                      className="text-primary hover:underline"
                    >
                      {row.leadInvestorName}
                    </Link>
                  ) : row.leadInvestorName ? (
                    <span className="text-muted-foreground">
                      {row.leadInvestorName}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs whitespace-nowrap">
                  {row.date ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                </td>
                <td className="py-2.5 px-2 text-right hidden sm:table-cell">
                  <RecordStatusDots
                    coverageScore={computeFundingRoundCoverage(row)}
                    verdict={row.verdict?.verdict}
                    sourceCheckHref={row.verdict?.verdict ? `/source-checks/funding-round/${encodeURIComponent(row.key)}` : undefined}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No funding rounds match your search.
        </div>
      )}

      {/* Bottom pagination */}
      <div className="mt-3">
        <PaginationControls
          page={page}
          pageCount={totalPages}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={(p) => setPage(p)}
        />
      </div>
    </div>
  );
}
