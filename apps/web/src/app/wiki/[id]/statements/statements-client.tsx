"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { Search, Download } from "lucide-react";
import {
  formatStatementValue,
  formatPeriod,
  getStatusBadge,
} from "@lib/statement-display";
import { VerdictBadge } from "@components/wiki/VerdictBadge";
import { CitationDetail, AttributedCitationDetail } from "./citation-detail";
import type { ResolvedStatement } from "@lib/statement-types";

interface StatementsClientProps {
  structured: ResolvedStatement[];
  attributed: ResolvedStatement[];
  categories: [string, ResolvedStatement[]][];
  entitySlug: string;
}

type StatusFilter = "active" | "superseded" | "retracted";

// ---- Export helpers ----

function csvEscape(val: string | number | null | undefined): string {
  if (val == null) return "";
  const str = String(val);
  // Defend against CSV injection: prefix dangerous leading characters
  const needsQuoting =
    str.includes(",") || str.includes('"') || str.includes("\n") ||
    /^[=+\-@\t\r]/.test(str);
  if (needsQuoting) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function statementToFlatValue(s: ResolvedStatement): string {
  if (s.valueNumeric != null) {
    return String(s.valueNumeric) + (s.valueUnit ? ` ${s.valueUnit}` : "");
  }
  if (s.valueEntityTitle) return s.valueEntityTitle;
  if (s.valueText != null) return s.valueText;
  if (s.valueDate != null) return s.valueDate;
  if (s.valueEntityId != null) return s.valueEntityId;
  return "";
}

function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function StatementsClient({
  structured,
  attributed,
  categories,
  entitySlug,
}: StatementsClientProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilters, setStatusFilters] = useState<Set<StatusFilter>>(
    new Set(["active", "superseded"])
  );

  const exportAsJson = useCallback(() => {
    const allStatements = [...structured, ...attributed];
    const data = {
      entityId: entitySlug,
      structured: structured.map((s) => ({
        id: s.id,
        variety: s.variety,
        property: s.property?.label ?? s.propertyId,
        propertyCategory: s.property?.category ?? null,
        value: statementToFlatValue(s),
        statementText: s.statementText,
        validStart: s.validStart,
        validEnd: s.validEnd,
        status: s.status,
        citationsCount: s.citations.length,
        attributedTo: s.attributedTo,
        verdict: s.verdict,
        verdictScore: s.verdictScore,
        claimCategory: s.claimCategory,
      })),
      attributed: attributed.map((s) => ({
        id: s.id,
        variety: s.variety,
        property: s.property?.label ?? s.propertyId,
        propertyCategory: s.property?.category ?? null,
        value: statementToFlatValue(s),
        statementText: s.statementText,
        validStart: s.validStart,
        validEnd: s.validEnd,
        status: s.status,
        citationsCount: s.citations.length,
        attributedTo: s.attributedTo,
        attributedToTitle: s.attributedToTitle,
        verdict: s.verdict,
        verdictScore: s.verdictScore,
        claimCategory: s.claimCategory,
      })),
      total: allStatements.length,
      exportedAt: new Date().toISOString(),
    };
    triggerDownload(
      JSON.stringify(data, null, 2),
      `${entitySlug}-statements.json`,
      "application/json"
    );
  }, [structured, attributed, entitySlug]);

  const exportAsCsv = useCallback(() => {
    const allStatements = [...structured, ...attributed];
    const headers = [
      "id", "variety", "property", "propertyCategory", "value", "statementText",
      "validStart", "validEnd", "status", "citationsCount",
      "attributedTo", "verdict", "verdictScore", "claimCategory",
    ];
    const rows = allStatements.map((s) =>
      headers.map((h) => {
        switch (h) {
          case "id": return csvEscape(s.id);
          case "variety": return csvEscape(s.variety);
          case "property": return csvEscape(s.property?.label ?? s.propertyId);
          case "propertyCategory": return csvEscape(s.property?.category);
          case "value": return csvEscape(statementToFlatValue(s));
          case "statementText": return csvEscape(s.statementText);
          case "validStart": return csvEscape(s.validStart);
          case "validEnd": return csvEscape(s.validEnd);
          case "status": return csvEscape(s.status);
          case "citationsCount": return csvEscape(s.citations.length);
          case "attributedTo": return csvEscape(s.attributedTo);
          case "verdict": return csvEscape(s.verdict);
          case "verdictScore": return csvEscape(s.verdictScore);
          case "claimCategory": return csvEscape(s.claimCategory);
          default: return "";
        }
      }).join(",")
    );
    triggerDownload(
      [headers.join(","), ...rows].join("\n"),
      `${entitySlug}-statements.csv`,
      "text/csv"
    );
  }, [structured, attributed, entitySlug]);

  const allCategories = useMemo(
    () => categories.map(([name]) => name),
    [categories]
  );

  const toggleStatus = (status: StatusFilter) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  const matchesSearch = (s: ResolvedStatement) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (s.statementText?.toLowerCase().includes(q) ?? false) ||
      (s.property?.label?.toLowerCase().includes(q) ?? false) ||
      formatStatementValue(s, s.property).toLowerCase().includes(q) ||
      (s.valueEntityTitle?.toLowerCase().includes(q) ?? false) ||
      (s.attributedToTitle?.toLowerCase().includes(q) ?? false)
    );
  };

  const matchesFilters = (s: ResolvedStatement) => {
    if (!statusFilters.has(s.status as StatusFilter)) return false;
    return matchesSearch(s);
  };

  const filteredCategories = useMemo(() => {
    return categories
      .filter(
        ([name]) => categoryFilter === "all" || name === categoryFilter
      )
      .map(([name, stmts]) => {
        const filtered = stmts.filter(matchesFilters);
        return [name, filtered] as [string, ResolvedStatement[]];
      })
      .filter(([, stmts]) => stmts.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, categoryFilter, statusFilters, searchQuery]);

  const filteredAttributed = useMemo(
    () => attributed.filter(matchesFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attributed, statusFilters, searchQuery]
  );

  // Hide attributed when a specific structured category is selected
  const showAttributed =
    categoryFilter === "all" && filteredAttributed.length > 0;

  const totalVisible =
    filteredCategories.reduce((sum, [, stmts]) => sum + stmts.length, 0) +
    (showAttributed ? filteredAttributed.length : 0);
  const totalAll = structured.length + attributed.length;

  const allFiltersOff = statusFilters.size === 0;

  // Hide verdict column when >90% of active statements have no real verdict
  const showVerdict = useMemo(() => {
    const activeStmts = structured.filter((s) => s.status === "active");
    if (activeStmts.length === 0) return false;
    const withVerdict = activeStmts.filter(
      (s) => s.verdict != null && s.verdict !== "not_verifiable"
    ).length;
    return withVerdict / activeStmts.length > 0.1;
  }, [structured]);

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4 p-3 rounded-lg border border-border/60 bg-muted/20">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search statements..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded border border-border bg-background"
          />
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="text-sm rounded border border-border bg-background px-2 py-1.5"
        >
          <option value="all">All categories</option>
          {allCategories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>

        <div className="flex gap-2 text-xs">
          {(["active", "superseded", "retracted"] as StatusFilter[]).map(
            (status) => (
              <label
                key={status}
                className="flex items-center gap-1 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={statusFilters.has(status)}
                  onChange={() => toggleStatus(status)}
                  className="rounded"
                />
                <span className="capitalize">{status}</span>
              </label>
            )
          )}
        </div>

        <span className="text-xs text-muted-foreground">
          {totalVisible} of {totalAll}
        </span>

        <div className="flex gap-1">
          <button
            onClick={exportAsJson}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-background hover:bg-muted/50 text-muted-foreground"
            title="Download as JSON"
          >
            <Download className="w-3 h-3" />
            JSON
          </button>
          <button
            onClick={exportAsCsv}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-background hover:bg-muted/50 text-muted-foreground"
            title="Download as CSV"
          >
            <Download className="w-3 h-3" />
            CSV
          </button>
        </div>
      </div>

      {/* All-filters-off warning */}
      {allFiltersOff && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 mb-4 text-center text-sm text-amber-700 dark:text-amber-300">
          All status filters are off. Check at least one status to see
          statements.
        </div>
      )}

      {/* Structured categories */}
      {filteredCategories.map(([category, stmts], idx) => (
        <CategorySection
          key={category}
          category={category}
          statements={stmts}
          defaultOpen={idx === 0}
          showVerdict={showVerdict}
        />
      ))}

      {/* Attributed section */}
      {showAttributed && (
        <AttributedSection
          key={`attributed-${filteredCategories.length === 0 ? "open" : "closed"}`}
          statements={filteredAttributed}
          defaultOpen={filteredCategories.length === 0}
        />
      )}

      {!allFiltersOff && totalVisible === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p>No statements match your filters.</p>
        </div>
      )}
    </div>
  );
}

// ---- Attributed Section ----

function AttributedSection({
  statements,
  defaultOpen,
}: {
  statements: ResolvedStatement[];
  defaultOpen: boolean;
}) {
  return (
    <details
      className="mb-4 rounded-lg border border-border/60"
      open={defaultOpen}
    >
      <summary className="px-4 py-3 bg-muted/30 cursor-pointer hover:bg-muted/50 text-sm font-semibold capitalize select-none rounded-t-lg">
        Attributed Claims ({statements.length})
      </summary>
      <div className="p-3 space-y-2">
        {statements.map((s) => (
          <AttributedCard key={s.id} statement={s} />
        ))}
      </div>
    </details>
  );
}

// ---- Category Section ----

function CategorySection({
  category,
  statements,
  defaultOpen,
  showVerdict,
}: {
  category: string;
  statements: ResolvedStatement[];
  defaultOpen: boolean;
  showVerdict: boolean;
}) {
  const active = statements.filter((s) => s.status === "active");
  const nonActive = statements.filter((s) => s.status !== "active");

  return (
    <details
      className="mb-4 rounded-lg border border-border/60"
      open={defaultOpen}
    >
      <summary className="px-4 py-3 bg-muted/30 cursor-pointer hover:bg-muted/50 text-sm font-semibold capitalize select-none rounded-t-lg">
        {category} ({statements.length})
      </summary>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/20">
              <th className="text-left px-3 py-2 text-xs font-medium">
                Property
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                Value
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                Period
              </th>
              <th className="text-right px-3 py-2 text-xs font-medium">
                Citations
              </th>
              {showVerdict && (
                <th className="text-left px-3 py-2 text-xs font-medium">
                  Verdict
                </th>
              )}
              <th className="text-left px-3 py-2 text-xs font-medium">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {active.map((s) => (
              <StructuredRow key={s.id} statement={s} showVerdict={showVerdict} />
            ))}
            {nonActive.map((s) => (
              <StructuredRow key={s.id} statement={s} showVerdict={showVerdict} />
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---- Structured Row ----

// formatPeriod imported from @lib/statement-display

function StructuredRow({ statement: s, showVerdict }: { statement: ResolvedStatement; showVerdict: boolean }) {
  const value = formatStatementValue(s, s.property);
  const isTextOnly = !s.propertyId && !!s.statementText;
  const displayValue =
    s.valueEntityTitle ??
    (value !== "—" ? value : (s.statementText ?? "—"));
  const statusBadge = getStatusBadge(s.status);
  const isInactive = s.status !== "active";

  return (
    <tr
      className={`border-b border-border/30 last:border-0 ${isInactive ? "opacity-60" : ""}`}
    >
      <td className="px-3 py-2 text-xs font-medium text-muted-foreground">
        {s.property?.label ?? s.propertyId ?? "—"}
      </td>
      <td
        className={`px-3 py-2 text-xs ${isTextOnly ? "italic text-muted-foreground" : "font-semibold tabular-nums"}`}
      >
        {s.valueEntityId ? (
          <Link
            href={`/wiki/${s.valueEntityId}`}
            className="text-blue-600 hover:underline"
          >
            {displayValue}
          </Link>
        ) : (
          displayValue
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatPeriod(s.validStart, s.validEnd)}
      </td>
      <td className="px-3 py-2 text-xs text-right relative">
        <CitationDetail citations={s.citations} />
      </td>
      {showVerdict && (
        <td className="px-3 py-2 text-xs">
          <VerdictBadge verdict={s.verdict} score={s.verdictScore} size="sm" />
        </td>
      )}
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${statusBadge.className}`}
        >
          {statusBadge.label}
        </span>
        {isInactive && s.archiveReason && (
          <span className="block text-[10px] text-muted-foreground mt-0.5">
            {s.archiveReason}
          </span>
        )}
      </td>
    </tr>
  );
}

// ---- Attributed Card ----

function AttributedCard({ statement: s }: { statement: ResolvedStatement }) {
  const statusBadge = getStatusBadge(s.status);
  const isInactive = s.status !== "active";

  return (
    <div
      className={`rounded-lg border border-border/60 p-3 ${isInactive ? "opacity-60" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {s.statementText && (
            <p className="text-sm italic text-muted-foreground line-clamp-3">
              &ldquo;{s.statementText}&rdquo;
            </p>
          )}
          <div className="flex flex-wrap gap-2 mt-2 text-xs text-muted-foreground">
            {s.attributedTo && (
              <span>
                Attributed to{" "}
                <Link
                  href={`/wiki/${s.attributedTo}`}
                  className="text-blue-600 hover:underline"
                >
                  {s.attributedToTitle ?? s.attributedTo}
                </Link>
              </span>
            )}
            {s.validStart && <span>{s.validStart}</span>}
            {s.claimCategory && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 text-[11px] font-medium">
                {s.claimCategory}
              </span>
            )}
          </div>
          {isInactive && s.archiveReason && (
            <p className="text-[10px] text-muted-foreground mt-1">
              {s.archiveReason}
            </p>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${statusBadge.className}`}
          >
            {statusBadge.label}
          </span>
          <VerdictBadge verdict={s.verdict} score={s.verdictScore} size="sm" />
          <AttributedCitationDetail citations={s.citations} />
        </div>
      </div>
    </div>
  );
}
