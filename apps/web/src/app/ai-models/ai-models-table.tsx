"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";
import { SortHeader } from "@/components/directory/SortHeader";
import { PaginationControls } from "@/components/directory/PaginationControls";
import { DEVELOPER_COLORS, SAFETY_LEVEL_COLORS, formatContext } from "./ai-model-constants";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { computeAiModelCoverage } from "@/components/coverage/coverage-score";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";

export interface AiModelRow {
  id: string;
  title: string;
  wikiId: string | null;
  modelFamily: string | null;
  modelTier: string | null;
  generation: string | null;
  developer: string | null;
  developerName: string | null;
  releaseDate: string | null;
  inputPrice: number | null;
  outputPrice: number | null;
  contextWindow: number | null;
  safetyLevel: string | null;
  sweBenchScore: number | null;
  mmluScore: number | null;
  gpqaScore: number | null;
  topBenchmark: { name: string; score: number; unit?: string } | null;
  capabilities: string[];
  isFamily: boolean;
  openWeight: boolean | null;
  parameterCount: string | null;
  verdictString: string | null;
}

type SortKey =
  | "name"
  | "developer"
  | "releaseDate"
  | "inputPrice"
  | "outputPrice"
  | "contextWindow"
  | "safetyLevel"
  | "sweBench"
  | "mmlu"
  | "gpqa";

const PAGE_SIZE = 50;

export function AiModelsTable({ rows }: { rows: AiModelRow[] }) {
  const [search, setSearch] = useState("");
  const [developerFilter, setDeveloperFilter] = useState<string>("all");
  const [showFamilies, setShowFamilies] = useState(false);
  const [showOpenWeightOnly, setShowOpenWeightOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("releaseDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const developers = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.developer && r.developerName) {
        map.set(r.developer, r.developerName);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const developerCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    for (const r of rows) {
      if (!showFamilies && r.isFamily) continue;
      counts.all += 1;
      if (r.developer) {
        counts[r.developer] = (counts[r.developer] ?? 0) + 1;
      }
    }
    return counts;
  }, [rows, showFamilies]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "developer" ? "asc" : "desc");
    }
    setPage(0);
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (!showFamilies) {
      result = result.filter((r) => !r.isFamily);
    }

    if (developerFilter !== "all") {
      result = result.filter((r) => r.developer === developerFilter);
    }

    if (showOpenWeightOnly) {
      result = result.filter((r) => r.openWeight === true);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => {
        const searchable = `${r.title} ${r.developerName ?? ""} ${r.modelFamily ?? ""} ${r.safetyLevel ?? ""} ${r.capabilities.join(" ")}`.toLowerCase();
        return searchable.includes(q);
      });
    }

    const getValue = (row: AiModelRow): string | number | null => {
      switch (sortKey) {
        case "name":
          return row.title.toLowerCase();
        case "developer":
          return (row.developerName ?? "").toLowerCase();
        case "releaseDate":
          return row.releaseDate;
        case "inputPrice":
          return row.inputPrice;
        case "outputPrice":
          return row.outputPrice;
        case "contextWindow":
          return row.contextWindow;
        case "safetyLevel":
          return row.safetyLevel;
        case "sweBench":
          return row.sweBenchScore;
        case "mmlu":
          return row.mmluScore;
        case "gpqa":
          return row.gpqaScore;
      }
    };
    result = [...result].sort((a, b) =>
      compareByValue(a, b, getValue, sortDir),
    );

    return result;
  }, [rows, search, developerFilter, showFamilies, showOpenWeightOnly, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5" role="search">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search models..."
            aria-label="Search models"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                setDeveloperFilter("all");
                setPage(0);
              }}
              aria-pressed={developerFilter === "all"}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                developerFilter === "all"
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              All{" "}
              <span className="text-[10px] opacity-60">{developerCounts.all}</span>
            </button>
            {developers.map(([devId, devName]) => (
              <button
                key={devId}
                onClick={() => {
                  setDeveloperFilter(developerFilter === devId ? "all" : devId);
                  setPage(0);
                }}
                aria-pressed={developerFilter === devId}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  developerFilter === devId
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {devName}{" "}
                <span className="text-[10px] opacity-60">
                  {developerCounts[devId] ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showFamilies}
              onChange={(e) => {
                setShowFamilies(e.target.checked);
                setPage(0);
              }}
              className="rounded"
            />
            Show families
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showOpenWeightOnly}
              onChange={(e) => {
                setShowOpenWeightOnly(e.target.checked);
                setPage(0);
              }}
              className="rounded"
            />
            Open weight only
          </label>
        </div>
      </div>

      {/* Results count + top pagination */}
      <div className="flex flex-col gap-2 mb-3">
        <div className="text-xs text-muted-foreground">
          {(() => {
            const familyCount = rows.filter((r) => r.isFamily).length;
            const modelCount = rows.length - familyCount;
            const filteredFamilies = filtered.filter((r) => r.isFamily).length;
            const filteredModels = filtered.length - filteredFamilies;

            if (showFamilies) {
              // Showing both models and families
              const parts: string[] = [];
              if (filteredModels > 0) parts.push(`${filteredModels} model${filteredModels !== 1 ? "s" : ""}`);
              if (filteredFamilies > 0) parts.push(`${filteredFamilies} famil${filteredFamilies !== 1 ? "ies" : "y"}`);
              const total = modelCount + familyCount;
              return `Showing ${parts.join(" + ")} (${filtered.length} of ${total} entries)`;
            } else {
              // Families hidden — denominator is only models
              if (filtered.length === modelCount) {
                return `Showing ${filtered.length} model${filtered.length !== 1 ? "s" : ""}`;
              }
              return `Showing ${filtered.length} of ${modelCount} models`;
            }
          })()}
        </div>
        <PaginationControls
          page={safePage}
          pageCount={pageCount}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">AI models directory with pricing, benchmarks, and safety data</caption>
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Model" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Developer" sortKey="developer" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Released" sortKey="releaseDate" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Input $/MTok" sortKey="inputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Output $/MTok" sortKey="outputPrice" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Context" sortKey="contextWindow" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Safety" sortKey="safetyLevel" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="MMLU" sortKey="mmlu" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="GPQA Diamond" sortKey="gpqa" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="SWE-bench" sortKey="sweBench" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <th scope="col" className="py-2.5 px-3 font-medium text-center">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {pageRows.map((row) => (
              <tr
                key={row.id}
                className={`hover:bg-muted/20 transition-colors ${row.isFamily ? "bg-muted/30 border-l-2 border-l-primary/30" : ""}`}
              >
                {/* Name */}
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/ai-models/${row.id}`}
                      className={`hover:text-primary transition-colors ${row.isFamily ? "font-semibold text-foreground" : "font-medium text-foreground"}`}
                    >
                      {row.title}
                    </Link>
                    {row.isFamily && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-primary/10 text-primary border border-primary/20">
                        Family
                      </span>
                    )}
                    {row.openWeight && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                        Open
                      </span>
                    )}
                  </div>
                </td>

                {/* Developer */}
                <td className="py-2.5 px-3">
                  {row.developer && row.developerName ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        DEVELOPER_COLORS[row.developer] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {row.developerName}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Release Date */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.releaseDate ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>

                {/* Input Price */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.inputPrice != null ? (
                    `$${row.inputPrice}`
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Output Price */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.outputPrice != null ? (
                    `$${row.outputPrice}`
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Context Window */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.contextWindow != null ? (
                    formatContext(row.contextWindow)
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Safety Level */}
                <td className="py-2.5 px-3">
                  {row.safetyLevel ? (
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      SAFETY_LEVEL_COLORS[row.safetyLevel] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                    }`}>
                      {row.safetyLevel}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* MMLU */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.mmluScore != null ? (
                    <Link href="/benchmarks/mmlu" className="font-semibold hover:text-primary transition-colors">{row.mmluScore}%</Link>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* GPQA Diamond */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.gpqaScore != null ? (
                    <Link href="/benchmarks/gpqa-diamond" className="font-semibold hover:text-primary transition-colors">{row.gpqaScore}%</Link>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* SWE-bench */}
                <td className="py-2.5 px-3 text-right tabular-nums">
                  {row.sweBenchScore != null ? (
                    <Link href="/benchmarks/swe-bench-verified" className="font-semibold hover:text-primary transition-colors">{row.sweBenchScore}%</Link>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>
                {/* Coverage */}
                <td className="py-2.5 px-3 text-center">
                  <RecordStatusDots
                    coverageScore={computeAiModelCoverage({
                      developer: row.developer,
                      releaseDate: row.releaseDate,
                      inputPrice: row.inputPrice,
                      outputPrice: row.outputPrice,
                      contextWindow: row.contextWindow,
                      parameterCount: row.parameterCount,
                      safetyLevel: row.safetyLevel,
                      benchmarkCount: [row.mmluScore, row.gpqaScore, row.sweBenchScore].filter((s) => s != null).length,
                      wikiId: row.wikiId,
                    })}
                    verdict={row.verdictString}
                    sourcingHref={row.verdictString ? getSourcingHref("ai-model", row.id) : undefined}
                  />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="text-center py-12 text-muted-foreground">
                  No models match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom pagination */}
      <div className="mt-3">
        <PaginationControls
          page={safePage}
          pageCount={pageCount}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}

