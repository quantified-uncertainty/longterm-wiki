"use client";

// TransitionModelTableClient - Interactive table for the AI Transition Model
// Receives pre-extracted data from the server component wrapper.

import { useMemo, useState } from "react";
import type { ColumnDef, Row } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { createColumns, parentCategories } from "./TransitionModelColumns";
import { CombinedParentBadge, ExpandableRow } from "./TransitionModelHelpers";

// ============================================================================
// TYPES
// ============================================================================

export interface SubItemRow {
  subItem: string;
  description: string;
  href?: string;
  parent: string;
  parentId: string;
  subgroup?: string;
  ratings?: {
    changeability: number;
    xriskImpact: number;
    trajectoryImpact: number;
    uncertainty: number;
  };
}

interface TransitionModelTableClientProps {
  causeRows: SubItemRow[];
  intermediateRows: SubItemRow[];
  effectRows: SubItemRow[];
}

type ViewMode = "flat" | "grouped";

// ============================================================================
// TABLE SECTION
// ============================================================================

function TableSection({
  title,
  data,
  columns,
  tierType,
  searchPlaceholder,
  expandedRows,
  viewMode,
}: {
  title: string;
  data: SubItemRow[];
  columns: ColumnDef<SubItemRow>[];
  tierType: "cause" | "intermediate" | "effect";
  searchPlaceholder: string;
  expandedRows: Set<string>;
  viewMode: ViewMode;
}) {
  if (data.length === 0) return null;

  const headerStyles: Record<
    string,
    { background: string; color: string }
  > = {
    cause: {
      background: "linear-gradient(135deg, #dbeafe 0%, #e0f2fe 100%)",
      color: "#1e40af",
    },
    intermediate: {
      background: "linear-gradient(135deg, #ede9fe 0%, #f3e8ff 100%)",
      color: "#7c3aed",
    },
    effect: {
      background: "linear-gradient(135deg, #fef3c7 0%, #fef9c3 100%)",
      color: "#a16207",
    },
  };

  // Group data by parent if in grouped mode
  const groupedData = useMemo(() => {
    if (viewMode === "flat") return null;
    const groups: Record<string, SubItemRow[]> = {};
    for (const row of data) {
      if (!groups[row.parent]) groups[row.parent] = [];
      groups[row.parent].push(row);
    }
    return groups;
  }, [data, viewMode]);

  // Count high-priority items
  const highPriorityCount = data.filter(
    (r) => (r.ratings?.xriskImpact ?? 0) > 70
  ).length;

  return (
    <div className="mb-8">
      {/* Section header */}
      <div
        className="px-4 py-3 font-semibold text-[13px] uppercase tracking-wide rounded-lg mb-4 flex items-center justify-between"
        style={headerStyles[tierType]}
      >
        <span>{title}</span>
        {highPriorityCount > 0 && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1 bg-red-500/15 text-red-600">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            {highPriorityCount} high priority
          </span>
        )}
      </div>

      {/* Table content */}
      {viewMode === "grouped" && groupedData ? (
        Object.entries(groupedData).map(([parent, rows]) => (
          <div key={parent} className="mb-6">
            <div className="text-xs font-semibold text-slate-500 py-2 border-b border-slate-200 mb-2">
              {parent} ({rows.length})
            </div>
            <DataTable
              columns={columns}
              data={rows}
              searchPlaceholder={searchPlaceholder}
              renderExpandedRow={(row: Row<SubItemRow>) =>
                expandedRows.has(row.original.subItem) ? (
                  <ExpandableRow row={row.original} />
                ) : null
              }
              getRowClassName={(row: Row<SubItemRow>) =>
                (row.original.ratings?.xriskImpact ?? 0) > 70
                  ? "high-priority-row"
                  : ""
              }
            />
          </div>
        ))
      ) : (
        <DataTable
          columns={columns}
          data={data}
          searchPlaceholder={searchPlaceholder}
          renderExpandedRow={(row: Row<SubItemRow>) =>
            expandedRows.has(row.original.subItem) ? (
              <ExpandableRow row={row.original} />
            ) : null
          }
          getRowClassName={(row: Row<SubItemRow>) =>
            (row.original.ratings?.xriskImpact ?? 0) > 70
              ? "high-priority-row"
              : ""
          }
        />
      )}
    </div>
  );
}

// ============================================================================
// MAIN CLIENT COMPONENT
// ============================================================================

export default function TransitionModelTableClient({
  causeRows,
  intermediateRows,
  effectRows,
}: TransitionModelTableClientProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("flat");

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const causeColumns = useMemo(
    () => createColumns(expandedRows, toggleRow, {
      tier: "cause",
      parentHeader: "Parent Factor",
      parentCell: (parent, parentId) => (
        <CombinedParentBadge parent={parent} category={parentCategories[parentId]} />
      ),
      actionHoverColor: "#1e40af",
    }),
    [expandedRows]
  );

  const intermediateColumns = useMemo(
    () => createColumns(expandedRows, toggleRow, {
      tier: "intermediate",
      parentHeader: "Parent Scenario",
      parentCell: (parent) => (
        <span
          className="inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
          style={{
            background: "#f3e8ff",
            color: "#7c3aed",
            border: "1px solid #ddd6fe",
          }}
        >
          {parent}
        </span>
      ),
      actionHoverColor: "#7c3aed",
    }),
    [expandedRows]
  );

  const effectColumns = useMemo(
    () => createColumns(expandedRows, toggleRow, {
      tier: "effect",
      parentHeader: "Parent Outcome",
      parentCell: (parent) => (
        <span
          className="inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
          style={{
            background: "#fef3c7",
            color: "#92400e",
            border: "1px solid #fcd34d",
          }}
        >
          {parent}
        </span>
      ),
      includeRatings: false,
      actionHoverColor: "#92400e",
    }),
    [expandedRows]
  );

  return (
    <div>
      {/* View mode toggle */}
      <div className="flex justify-end mb-4 gap-2">
        <span className="text-[13px] text-slate-500 mr-2">View:</span>
        <button
          onClick={() => setViewMode("flat")}
          className="px-3 py-1 text-xs font-medium rounded border border-slate-200 cursor-pointer transition-colors"
          style={{
            background: viewMode === "flat" ? "#1e40af" : "white",
            color: viewMode === "flat" ? "white" : "#64748b",
          }}
        >
          Flat
        </button>
        <button
          onClick={() => setViewMode("grouped")}
          className="px-3 py-1 text-xs font-medium rounded border border-slate-200 cursor-pointer transition-colors"
          style={{
            background: viewMode === "grouped" ? "#1e40af" : "white",
            color: viewMode === "grouped" ? "white" : "#64748b",
          }}
        >
          Grouped
        </button>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mb-4 text-xs text-slate-500 items-center">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          High X-risk impact (&gt;70)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-4 h-4 border border-slate-200 rounded-sm flex items-center justify-center text-[10px]">
            +
          </span>
          Click to expand description
        </span>
      </div>

      {/* High priority row styling */}
      <style>{`
        .high-priority-row {
          background-color: #fef2f2 !important;
        }
        .high-priority-row:hover {
          background-color: #fee2e2 !important;
        }
      `}</style>

      <TableSection
        title="Root Factors"
        data={causeRows}
        columns={causeColumns}
        tierType="cause"
        searchPlaceholder="Search root factors..."
        expandedRows={expandedRows}
        viewMode={viewMode}
      />
      <TableSection
        title="Ultimate Scenarios"
        data={intermediateRows}
        columns={intermediateColumns}
        tierType="intermediate"
        searchPlaceholder="Search scenarios..."
        expandedRows={expandedRows}
        viewMode={viewMode}
      />
      <TableSection
        title="Ultimate Outcomes"
        data={effectRows}
        columns={effectColumns}
        tierType="effect"
        searchPlaceholder="Search outcomes..."
        expandedRows={expandedRows}
        viewMode={viewMode}
      />
    </div>
  );
}
