"use client";

// TransitionModelTableClient - Interactive table for the AI Transition Model
// Receives pre-extracted data from the server component wrapper.
// Ported from apps/longterm/src/components/TransitionModelTable.tsx

import { useMemo, useState } from "react";
import type { ColumnDef, Row } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";

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
// CONSTANTS
// ============================================================================

// Map parent IDs to display categories
const parentCategories: Record<string, "ai" | "society"> = {
  "misalignment-potential": "ai",
  "ai-capabilities": "ai",
  "ai-uses": "ai",
  "ai-ownership": "ai",
  "civ-competence": "society",
  "transition-turbulence": "society",
  "misuse-potential": "society",
};

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

// Truncate description for preview
function truncateText(text: string, maxLength: number = 150): string {
  if (!text) return "";
  const cleaned = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + "...";
}

// Parameter link - clickable with hover effect
function ParamLink({
  children,
  href,
  tier,
  isHighPriority,
}: {
  children: React.ReactNode;
  href?: string;
  tier: "cause" | "intermediate" | "effect";
  isHighPriority?: boolean;
}) {
  const colors: Record<string, string> = {
    cause: "#1e40af",
    intermediate: "#6d28d9",
    effect: "#92400e",
  };

  const content = (
    <span
      className="flex items-center gap-1.5 text-[13px] font-semibold"
      style={{ color: colors[tier] }}
    >
      {isHighPriority && (
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: "#ef4444" }}
          title="High X-risk impact (>70)"
        />
      )}
      {children}
    </span>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block no-underline hover:underline"
      >
        {content}
      </a>
    );
  }
  return content;
}

// Rating cell with color-coded bar
function RatingCell({
  value,
  colorType,
}: {
  value?: number;
  colorType: "green" | "red" | "blue" | "gray";
}) {
  if (value === undefined)
    return <span className="text-gray-400">&mdash;</span>;

  const colorConfigs = {
    green: { bar: "#22c55e", bg: "#dcfce7", text: "#166534" },
    red: { bar: "#ef4444", bg: "#fee2e2", text: "#991b1b" },
    blue: { bar: "#3b82f6", bg: "#dbeafe", text: "#1e40af" },
    gray: { bar: "#6b7280", bg: "#f3f4f6", text: "#374151" },
  };
  const c = colorConfigs[colorType];

  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div
        className="flex-1 h-1.5 rounded-full overflow-hidden"
        style={{ background: c.bg }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${value}%`, background: c.bar }}
        />
      </div>
      <span
        className="text-xs font-medium min-w-[24px]"
        style={{ color: c.text }}
      >
        {value}
      </span>
    </div>
  );
}

// Combined parent badge with category prefix
function CombinedParentBadge({
  parent,
  category,
}: {
  parent: string;
  category?: "ai" | "society";
}) {
  const config = {
    ai: {
      prefix: "AI",
      bg: "#eff6ff",
      color: "#1d4ed8",
      border: "#bfdbfe",
      prefixBg: "#dbeafe",
    },
    society: {
      prefix: "Society",
      bg: "#ecfdf5",
      color: "#047857",
      border: "#a7f3d0",
      prefixBg: "#d1fae5",
    },
  };
  const c = config[category || "ai"];
  return (
    <span
      className="inline-flex items-center rounded text-xs font-medium overflow-hidden"
      style={{ border: `1px solid ${c.border}` }}
    >
      <span
        className="px-1.5 py-0.5 text-[11px] font-semibold"
        style={{ background: c.prefixBg, color: c.color }}
      >
        {c.prefix}
      </span>
      <span
        className="px-2 py-0.5"
        style={{ background: c.bg, color: c.color }}
      >
        {parent}
      </span>
    </span>
  );
}

// Expandable row content
function ExpandableRow({ row }: { row: SubItemRow }) {
  if (!row.description) return null;

  return (
    <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 text-[13px] leading-relaxed text-slate-600">
      <div className="max-w-[800px]">
        {truncateText(row.description, 400)}
        {row.href && (
          <a
            href={row.href}
            className="ml-2 text-blue-500 no-underline font-medium hover:underline"
          >
            Read more &rarr;
          </a>
        )}
      </div>
    </div>
  );
}

// Expand button
function ExpandButton({
  isExpanded,
  onClick,
  hasDescription,
}: {
  isExpanded: boolean;
  onClick: () => void;
  hasDescription: boolean;
}) {
  if (!hasDescription) return <span className="inline-block w-6" />;

  return (
    <button
      onClick={onClick}
      className="w-6 h-6 rounded border border-slate-200 flex items-center justify-center text-sm text-slate-500 cursor-pointer transition-all duration-150"
      style={{
        background: isExpanded ? "#eff6ff" : "white",
      }}
      title={isExpanded ? "Collapse" : "Expand description"}
    >
      {isExpanded ? "\u2212" : "+"}
    </button>
  );
}

// View action link
function ViewActionLink({
  href,
  hoverColor,
}: {
  href?: string;
  hoverColor: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      className="text-slate-500 no-underline text-xs px-2 py-1 rounded border border-slate-200 bg-white inline-block hover:bg-slate-100 transition-colors"
      onMouseOver={(e) => {
        e.currentTarget.style.color = hoverColor;
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.color = "";
      }}
    >
      View &rarr;
    </a>
  );
}

// ============================================================================
// COLUMN DEFINITIONS
// ============================================================================

function createCauseColumns(
  expandedRows: Set<string>,
  toggleRow: (id: string) => void
): ColumnDef<SubItemRow>[] {
  return [
    {
      id: "expand",
      header: () => <span className="w-6" />,
      cell: ({ row }) => (
        <ExpandButton
          isExpanded={expandedRows.has(row.original.subItem)}
          onClick={() => toggleRow(row.original.subItem)}
          hasDescription={!!row.original.description}
        />
      ),
      size: 40,
    },
    {
      accessorKey: "subItem",
      header: ({ column }) => (
        <SortableHeader column={column}>Parameter</SortableHeader>
      ),
      cell: ({ row }) => (
        <ParamLink
          href={row.original.href}
          tier="cause"
          isHighPriority={(row.original.ratings?.xriskImpact ?? 0) > 70}
        >
          {row.getValue("subItem")}
        </ParamLink>
      ),
    },
    {
      accessorKey: "parent",
      header: ({ column }) => (
        <SortableHeader column={column}>Parent Factor</SortableHeader>
      ),
      cell: ({ row }) => {
        const cat = parentCategories[row.original.parentId];
        return (
          <CombinedParentBadge
            parent={row.getValue("parent")}
            category={cat}
          />
        );
      },
    },
    {
      id: "changeability",
      accessorFn: (row) => row.ratings?.changeability,
      header: ({ column }) => (
        <SortableHeader column={column}>Changeability</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.changeability}
          colorType="green"
        />
      ),
    },
    {
      id: "uncertainty",
      accessorFn: (row) => row.ratings?.uncertainty,
      header: ({ column }) => (
        <SortableHeader column={column}>Uncertainty</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.uncertainty}
          colorType="gray"
        />
      ),
    },
    {
      id: "xriskImpact",
      accessorFn: (row) => row.ratings?.xriskImpact,
      header: ({ column }) => (
        <SortableHeader column={column}>X-Risk</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.xriskImpact}
          colorType="red"
        />
      ),
    },
    {
      id: "trajectoryImpact",
      accessorFn: (row) => row.ratings?.trajectoryImpact,
      header: ({ column }) => (
        <SortableHeader column={column}>Trajectory</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.trajectoryImpact}
          colorType="blue"
        />
      ),
    },
    {
      id: "actions",
      header: () => null,
      cell: ({ row }) => (
        <ViewActionLink href={row.original.href} hoverColor="#1e40af" />
      ),
      size: 70,
    },
  ];
}

function createIntermediateColumns(
  expandedRows: Set<string>,
  toggleRow: (id: string) => void
): ColumnDef<SubItemRow>[] {
  return [
    {
      id: "expand",
      header: () => <span className="w-6" />,
      cell: ({ row }) => (
        <ExpandButton
          isExpanded={expandedRows.has(row.original.subItem)}
          onClick={() => toggleRow(row.original.subItem)}
          hasDescription={!!row.original.description}
        />
      ),
      size: 40,
    },
    {
      accessorKey: "subItem",
      header: ({ column }) => (
        <SortableHeader column={column}>Parameter</SortableHeader>
      ),
      cell: ({ row }) => (
        <ParamLink
          href={row.original.href}
          tier="intermediate"
          isHighPriority={(row.original.ratings?.xriskImpact ?? 0) > 70}
        >
          {row.getValue("subItem")}
        </ParamLink>
      ),
    },
    {
      accessorKey: "parent",
      header: ({ column }) => (
        <SortableHeader column={column}>Parent Scenario</SortableHeader>
      ),
      cell: ({ row }) => (
        <span
          className="inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
          style={{
            background: "#f3e8ff",
            color: "#7c3aed",
            border: "1px solid #ddd6fe",
          }}
        >
          {row.getValue("parent")}
        </span>
      ),
    },
    {
      id: "changeability",
      accessorFn: (row) => row.ratings?.changeability,
      header: ({ column }) => (
        <SortableHeader column={column}>Changeability</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.changeability}
          colorType="green"
        />
      ),
    },
    {
      id: "uncertainty",
      accessorFn: (row) => row.ratings?.uncertainty,
      header: ({ column }) => (
        <SortableHeader column={column}>Uncertainty</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.uncertainty}
          colorType="gray"
        />
      ),
    },
    {
      id: "xriskImpact",
      accessorFn: (row) => row.ratings?.xriskImpact,
      header: ({ column }) => (
        <SortableHeader column={column}>X-Risk</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.xriskImpact}
          colorType="red"
        />
      ),
    },
    {
      id: "trajectoryImpact",
      accessorFn: (row) => row.ratings?.trajectoryImpact,
      header: ({ column }) => (
        <SortableHeader column={column}>Trajectory</SortableHeader>
      ),
      cell: ({ row }) => (
        <RatingCell
          value={row.original.ratings?.trajectoryImpact}
          colorType="blue"
        />
      ),
    },
    {
      id: "actions",
      header: () => null,
      cell: ({ row }) => (
        <ViewActionLink href={row.original.href} hoverColor="#7c3aed" />
      ),
      size: 70,
    },
  ];
}

function createEffectColumns(
  expandedRows: Set<string>,
  toggleRow: (id: string) => void
): ColumnDef<SubItemRow>[] {
  return [
    {
      id: "expand",
      header: () => <span className="w-6" />,
      cell: ({ row }) => (
        <ExpandButton
          isExpanded={expandedRows.has(row.original.subItem)}
          onClick={() => toggleRow(row.original.subItem)}
          hasDescription={!!row.original.description}
        />
      ),
      size: 40,
    },
    {
      accessorKey: "subItem",
      header: ({ column }) => (
        <SortableHeader column={column}>Parameter</SortableHeader>
      ),
      cell: ({ row }) => (
        <ParamLink href={row.original.href} tier="effect">
          {row.getValue("subItem")}
        </ParamLink>
      ),
    },
    {
      accessorKey: "parent",
      header: ({ column }) => (
        <SortableHeader column={column}>Parent Outcome</SortableHeader>
      ),
      cell: ({ row }) => (
        <span
          className="inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
          style={{
            background: "#fef3c7",
            color: "#92400e",
            border: "1px solid #fcd34d",
          }}
        >
          {row.getValue("parent")}
        </span>
      ),
    },
    {
      id: "actions",
      header: () => null,
      cell: ({ row }) => (
        <ViewActionLink href={row.original.href} hoverColor="#92400e" />
      ),
      size: 70,
    },
  ];
}

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
    () => createCauseColumns(expandedRows, toggleRow),
    [expandedRows]
  );
  const intermediateColumns = useMemo(
    () => createIntermediateColumns(expandedRows, toggleRow),
    [expandedRows]
  );
  const effectColumns = useMemo(
    () => createEffectColumns(expandedRows, toggleRow),
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
