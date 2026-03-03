"use client";

import { useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  formatStatementValue,
  getVarietyBadge,
  getStatusBadge,
} from "@lib/statement-display";
import type { StatementRow, PropertyRow } from "../components/statements-data";

// ---- Filter bar ----

interface FilterState {
  search: string;
  variety: string;
  status: string;
  category: string;
  propertyId: string;
  entity: string;
  hasCitations: string;
  hasVerdict: string;
}

function useFilters(): [FilterState, (key: keyof FilterState, val: string) => void] {
  const searchParams = useSearchParams();
  const router = useRouter();

  const filters: FilterState = {
    search: searchParams.get("search") ?? "",
    variety: searchParams.get("variety") ?? "",
    status: searchParams.get("status") ?? "",
    category: searchParams.get("category") ?? "",
    propertyId: searchParams.get("propertyId") ?? "",
    entity: searchParams.get("entity") ?? "",
    hasCitations: searchParams.get("hasCitations") ?? "",
    hasVerdict: searchParams.get("hasVerdict") ?? "",
  };

  const setFilter = (key: keyof FilterState, val: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (val) {
      params.set(key, val);
    } else {
      params.delete(key);
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return [filters, setFilter];
}

// ---- Sort ----

type SortKey = "newest" | "entity" | "property" | "verdict_score";

function sortStatements(
  statements: StatementRow[],
  sortKey: SortKey
): StatementRow[] {
  const sorted = [...statements];
  switch (sortKey) {
    case "newest":
      return sorted.sort((a, b) => b.id - a.id);
    case "entity":
      return sorted.sort((a, b) =>
        a.subjectEntityId.localeCompare(b.subjectEntityId)
      );
    case "property":
      return sorted.sort((a, b) =>
        (a.propertyId ?? "zzz").localeCompare(b.propertyId ?? "zzz")
      );
    case "verdict_score":
      return sorted.sort(
        (a, b) => (b.verdictScore ?? -1) - (a.verdictScore ?? -1)
      );
    default:
      return sorted;
  }
}

// ---- Main component ----

interface StatementsExplorerProps {
  statements: StatementRow[];
  properties: PropertyRow[];
  entityNames: Record<string, string>;
  entities: string[];
  categories: string[];
  propertyOptions: { id: string; label: string }[];
}

export function StatementsExplorer({
  statements,
  properties,
  entityNames,
  entities,
  categories,
  propertyOptions,
}: StatementsExplorerProps) {
  const [filters, setFilter] = useFilters();
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Build property map for value formatting
  const propertyMap = useMemo(
    () => new Map(properties.map((p) => [p.id, p])),
    [properties]
  );

  // Filter
  const filtered = useMemo(() => {
    let result = statements;

    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (s) =>
          s.statementText?.toLowerCase().includes(q) ||
          s.subjectEntityId.toLowerCase().includes(q) ||
          (entityNames[s.subjectEntityId] ?? "").toLowerCase().includes(q) ||
          s.propertyId?.toLowerCase().includes(q) ||
          s.valueText?.toLowerCase().includes(q)
      );
    }
    if (filters.variety) {
      result = result.filter((s) => s.variety === filters.variety);
    }
    if (filters.status) {
      result = result.filter((s) => s.status === filters.status);
    }
    if (filters.category) {
      const propIds = new Set(
        properties
          .filter((p) => p.category === filters.category)
          .map((p) => p.id)
      );
      result = result.filter(
        (s) => s.propertyId && propIds.has(s.propertyId)
      );
    }
    if (filters.propertyId) {
      result = result.filter((s) => s.propertyId === filters.propertyId);
    }
    if (filters.entity) {
      result = result.filter((s) => s.subjectEntityId === filters.entity);
    }
    if (filters.hasCitations === "true") {
      result = result.filter((s) => s.citationCount > 0);
    }
    if (filters.hasVerdict === "true") {
      result = result.filter((s) => s.verdict != null);
    }

    return result;
  }, [statements, filters, properties, entityNames]);

  // Sort
  const sorted = useMemo(() => sortStatements(filtered, sortKey), [filtered, sortKey]);

  // Paginate
  const totalPages = Math.ceil(sorted.length / pageSize);
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="text"
          placeholder="Search statements..."
          value={filters.search}
          onChange={(e) => {
            setFilter("search", e.target.value);
            setPage(0);
          }}
          className="h-8 px-3 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground min-w-[200px]"
        />

        <select
          value={filters.variety}
          onChange={(e) => { setFilter("variety", e.target.value); setPage(0); }}
          className="h-8 px-2 text-sm bg-background border border-border rounded-md"
        >
          <option value="">All varieties</option>
          <option value="structured">Structured</option>
          <option value="attributed">Attributed</option>
        </select>

        <select
          value={filters.status}
          onChange={(e) => { setFilter("status", e.target.value); setPage(0); }}
          className="h-8 px-2 text-sm bg-background border border-border rounded-md"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="superseded">Superseded</option>
          <option value="retracted">Retracted</option>
        </select>

        <select
          value={filters.category}
          onChange={(e) => { setFilter("category", e.target.value); setPage(0); }}
          className="h-8 px-2 text-sm bg-background border border-border rounded-md"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>

        <select
          value={filters.propertyId}
          onChange={(e) => { setFilter("propertyId", e.target.value); setPage(0); }}
          className="h-8 px-2 text-sm bg-background border border-border rounded-md"
        >
          <option value="">All properties</option>
          {propertyOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <select
          value={filters.entity}
          onChange={(e) => { setFilter("entity", e.target.value); setPage(0); }}
          className="h-8 px-2 text-sm bg-background border border-border rounded-md"
        >
          <option value="">All entities</option>
          {entities.map((e) => (
            <option key={e} value={e}>
              {entityNames[e] ?? e}
            </option>
          ))}
        </select>

        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="h-8 px-2 text-sm bg-background border border-border rounded-md"
        >
          <option value="newest">Newest first</option>
          <option value="entity">By entity</option>
          <option value="property">By property</option>
          <option value="verdict_score">By verdict score</option>
        </select>
      </div>

      {/* Boolean filters */}
      <div className="flex flex-wrap gap-3 mb-4 text-sm">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.hasCitations === "true"}
            onChange={(e) =>
              setFilter("hasCitations", e.target.checked ? "true" : "")
            }
            className="rounded border-border"
          />
          <span className="text-muted-foreground">Has citations</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.hasVerdict === "true"}
            onChange={(e) =>
              setFilter("hasVerdict", e.target.checked ? "true" : "")
            }
            className="rounded border-border"
          />
          <span className="text-muted-foreground">Has verdict</span>
        </label>
      </div>

      {/* Results count */}
      <div className="text-sm text-muted-foreground mb-3">
        Showing {paged.length} of {sorted.length} statements
        {sorted.length !== statements.length &&
          ` (filtered from ${statements.length})`}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              <th className="text-left px-3 py-2 text-xs font-medium w-6"></th>
              <th className="text-left px-3 py-2 text-xs font-medium">Entity</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Property / Text</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Value</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Period</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Variety</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Status</th>
              <th className="text-right px-3 py-2 text-xs font-medium">Cit.</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((s) => {
              const prop = s.propertyId ? propertyMap.get(s.propertyId) : null;
              const isExpanded = expandedId === s.id;
              return (
                <StatementTableRow
                  key={s.id}
                  statement={s}
                  property={prop ?? null}
                  entityName={entityNames[s.subjectEntityId] ?? s.subjectEntityId}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedId(isExpanded ? null : s.id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4 text-sm">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="px-3 py-1 rounded border border-border disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1 rounded border border-border disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Table row ----

function StatementTableRow({
  statement: s,
  property: prop,
  entityName,
  isExpanded,
  onToggle,
}: {
  statement: StatementRow;
  property: PropertyRow | null;
  entityName: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const varietyBadge = getVarietyBadge(s.variety);
  const statusBadge = getStatusBadge(s.status);
  const value = formatStatementValue(
    s,
    prop ? { unitFormatId: prop.unitFormatId, valueType: prop.valueType } : null
  );
  const isSuperseded = s.status !== "active";

  return (
    <>
      <tr
        className={`border-b border-border/30 last:border-0 cursor-pointer hover:bg-muted/30 ${isSuperseded ? "opacity-60" : ""}`}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {isExpanded ? "▾" : "▸"}
        </td>
        <td className="px-3 py-2 text-xs">
          <Link
            href={`/statements/entity/${s.subjectEntityId}`}
            className="text-blue-600 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {entityName}
          </Link>
        </td>
        <td className="px-3 py-2 text-xs max-w-[300px]">
          {s.variety === "structured" ? (
            <span className="font-medium">{prop?.label ?? s.propertyId ?? "—"}</span>
          ) : (
            <span className="italic text-muted-foreground line-clamp-1">
              {s.statementText ? `"${s.statementText}"` : "—"}
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-xs font-semibold tabular-nums">
          {s.variety === "structured" ? (
            s.valueEntityId ? (
              <Link
                href={`/wiki/${s.valueEntityId}`}
                className="text-blue-600 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {value}
              </Link>
            ) : (
              value
            )
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {s.validStart ?? "—"}
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${varietyBadge.className}`}
          >
            {varietyBadge.label}
          </span>
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${statusBadge.className}`}
          >
            {statusBadge.label}
          </span>
        </td>
        <td className="px-3 py-2 text-xs text-right tabular-nums text-muted-foreground">
          {s.citationCount > 0 ? s.citationCount : "—"}
        </td>
      </tr>

      {/* Expanded details */}
      {isExpanded && (
        <tr className="bg-muted/20">
          <td colSpan={8} className="px-6 py-4">
            <ExpandedDetails statement={s} property={prop} entityName={entityName} />
          </td>
        </tr>
      )}
    </>
  );
}

// ---- Expanded row details ----

function ExpandedDetails({
  statement: s,
  property: prop,
  entityName,
}: {
  statement: StatementRow;
  property: PropertyRow | null;
  entityName: string;
}) {
  const value = formatStatementValue(
    s,
    prop ? { unitFormatId: prop.unitFormatId, valueType: prop.valueType } : null
  );

  return (
    <div className="space-y-3 text-sm">
      {/* Header with link */}
      <div className="flex items-center gap-2">
        <Link
          href={`/statements/statement/${s.id}`}
          className="text-blue-600 hover:underline text-xs"
        >
          View full detail →
        </Link>
        <span className="text-xs text-muted-foreground">ID: {s.id}</span>
      </div>

      {/* Main content */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
        <div>
          <span className="text-muted-foreground">Entity: </span>
          <Link
            href={`/statements/entity/${s.subjectEntityId}`}
            className="text-blue-600 hover:underline"
          >
            {entityName}
          </Link>
        </div>
        {prop && (
          <div>
            <span className="text-muted-foreground">Property: </span>
            <span className="font-medium">{prop.label}</span>
            <span className="text-muted-foreground/60 ml-1 capitalize">
              ({prop.category})
            </span>
          </div>
        )}
        {s.variety === "structured" && (
          <div>
            <span className="text-muted-foreground">Value: </span>
            <span className="font-semibold">{value}</span>
          </div>
        )}
        {s.qualifierKey && (
          <div>
            <span className="text-muted-foreground">Qualifier: </span>
            <span>{s.qualifierKey}</span>
          </div>
        )}
        {s.validStart && (
          <div>
            <span className="text-muted-foreground">Valid from: </span>
            <span>{s.validStart}</span>
          </div>
        )}
        {s.validEnd && (
          <div>
            <span className="text-muted-foreground">Valid until: </span>
            <span>{s.validEnd}</span>
          </div>
        )}
        {s.attributedTo && (
          <div>
            <span className="text-muted-foreground">Attributed to: </span>
            <Link
              href={`/wiki/${s.attributedTo}`}
              className="text-blue-600 hover:underline"
            >
              {s.attributedTo}
            </Link>
          </div>
        )}
        {s.verdict && (
          <div>
            <span className="text-muted-foreground">Verdict: </span>
            <span className="font-medium">{s.verdict}</span>
            {s.verdictScore != null && (
              <span className="text-muted-foreground ml-1">
                ({Math.round(s.verdictScore * 100)}%)
              </span>
            )}
          </div>
        )}
        {s.sourceFactKey && (
          <div>
            <span className="text-muted-foreground">Source: </span>
            <span className="font-mono text-[11px]">{s.sourceFactKey}</span>
          </div>
        )}
        {s.note && (
          <div className="col-span-full">
            <span className="text-muted-foreground">Note: </span>
            <span className="italic">{s.note}</span>
          </div>
        )}
      </div>

      {/* Statement text for attributed */}
      {s.statementText && (
        <div className="border-l-2 border-amber-300 pl-3 py-1 italic text-muted-foreground">
          &ldquo;{s.statementText}&rdquo;
        </div>
      )}

      {/* Verdict quotes */}
      {s.verdictQuotes && (
        <div className="border-l-2 border-green-300 pl-3 py-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Verdict evidence: </span>
          {s.verdictQuotes}
        </div>
      )}
    </div>
  );
}
