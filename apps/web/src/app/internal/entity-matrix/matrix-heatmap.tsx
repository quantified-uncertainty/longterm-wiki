"use client";

import { useState, useMemo } from "react";
import type {
  MatrixSnapshot,
  EntityTypeRow,
  CellValue,
  DimensionDef,
  DimensionGroupMeta,
} from "./compute-matrix";

// ============================================================================
// TYPES
// ============================================================================

type SortMode = "score-desc" | "score-asc" | "alpha" | "tier";
type FilterTier = "all" | "canonical" | "sub-entity";

interface MatrixHeatmapProps {
  snapshot: MatrixSnapshot;
}

// ============================================================================
// COLOR UTILITIES
// ============================================================================

function scoreToStyle(score: number): React.CSSProperties {
  if (score < 0) return { backgroundColor: "#f3f4f6" }; // gray-100
  if (score >= 80) return { backgroundColor: "#bbf7d0" }; // green-200
  if (score >= 60) return { backgroundColor: "#dcfce7" }; // green-100
  if (score >= 40) return { backgroundColor: "#fef9c3" }; // yellow-100
  if (score > 0) return { backgroundColor: "#ffedd5" }; // orange-100
  return { backgroundColor: "#fee2e2" }; // red-100
}

function scoreToTextStyle(score: number): React.CSSProperties {
  if (score < 0) return { color: "#9ca3af" }; // gray-400
  if (score >= 80) return { color: "#15803d" }; // green-700
  if (score >= 60) return { color: "#16a34a" }; // green-600
  if (score >= 40) return { color: "#a16207" }; // yellow-700
  if (score > 0) return { color: "#c2410c" }; // orange-700
  return { color: "#b91c1c" }; // red-700
}

function aggregateToStyle(score: number): React.CSSProperties {
  if (score >= 80) return { color: "#16a34a", fontWeight: 600 };
  if (score >= 60) return { color: "#16a34a" };
  if (score >= 40) return { color: "#ca8a04" };
  return { color: "#dc2626" };
}

// ============================================================================
// CELL TOOLTIP
// ============================================================================

function CellTooltip({
  cell,
  dim,
}: {
  cell: CellValue;
  dim: DimensionDef;
}) {
  const rawStr =
    cell.raw === null
      ? "N/A"
      : typeof cell.raw === "boolean"
        ? cell.raw
          ? "Yes"
          : "No"
        : String(cell.raw);

  return (
    <div className="text-xs leading-tight">
      <div className="font-medium">{dim.label}</div>
      <div className="text-muted-foreground mt-0.5">{dim.description}</div>
      <div className="mt-1">
        <span className="font-medium">Value:</span> {rawStr}
      </div>
      {cell.score >= 0 && (
        <div>
          <span className="font-medium">Score:</span> {cell.score}%
        </div>
      )}
      {cell.details && (
        <div className="text-muted-foreground mt-0.5">{cell.details}</div>
      )}
    </div>
  );
}

// ============================================================================
// CELL DISPLAY
// ============================================================================

function formatCellValue(cell: CellValue): string {
  if (cell.raw === null) return "—";
  if (typeof cell.raw === "boolean") return cell.raw ? "✓" : "✗";
  if (typeof cell.raw === "number") {
    if (cell.raw === 0) return "0";
    return String(cell.raw);
  }
  // Enum values
  const str = String(cell.raw);
  if (str === "none") return "✗";
  if (str === "specialized") return "★";
  if (str === "generic") return "◆";
  if (str === "rich") return "★";
  if (str === "basic") return "◆";
  return str.charAt(0).toUpperCase();
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function MatrixHeatmap({ snapshot }: MatrixHeatmapProps) {
  const [sort, setSort] = useState<SortMode>("score-desc");
  const [filterTier, setFilterTier] = useState<FilterTier>("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{
    row: string;
    dim: string;
  } | null>(null);

  const dimMap = useMemo(
    () => new Map(snapshot.dimensions.map((d) => [d.id, d])),
    [snapshot.dimensions],
  );

  // Filter and sort rows
  const rows = useMemo(() => {
    let filtered = snapshot.rows;
    if (filterTier !== "all") {
      filtered = filtered.filter((r) => r.tier === filterTier);
    }
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "score-desc":
          return b.aggregateScore - a.aggregateScore;
        case "score-asc":
          return a.aggregateScore - b.aggregateScore;
        case "alpha":
          return a.label.localeCompare(b.label);
        case "tier":
          return a.tier.localeCompare(b.tier) || b.aggregateScore - a.aggregateScore;
        default:
          return 0;
      }
    });
  }, [snapshot.rows, sort, filterTier]);

  // Group dimensions by group
  const groupedDims = useMemo(() => {
    return snapshot.dimensionGroups.map((group) => ({
      group,
      dims: snapshot.dimensions.filter((d) => d.group === group.id),
    }));
  }, [snapshot.dimensions, snapshot.dimensionGroups]);

  const totalDims = snapshot.dimensions.length;

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", fontSize: "0.875rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
          <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>Sort:</span>
          <select
            style={{ border: "1px solid #e5e7eb", borderRadius: "0.25rem", padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
          >
            <option value="score-desc">Score (high first)</option>
            <option value="score-asc">Score (low first)</option>
            <option value="alpha">Alphabetical</option>
            <option value="tier">By tier</option>
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
          <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>Filter:</span>
          <select
            style={{ border: "1px solid #e5e7eb", borderRadius: "0.25rem", padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
            value={filterTier}
            onChange={(e) => setFilterTier(e.target.value as FilterTier)}
          >
            <option value="all">All ({snapshot.rows.length})</option>
            <option value="canonical">
              Canonical ({snapshot.rows.filter((r) => r.tier === "canonical").length})
            </option>
            <option value="sub-entity">
              Sub-entity ({snapshot.rows.filter((r) => r.tier === "sub-entity").length})
            </option>
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginLeft: "auto", fontSize: "0.75rem", color: "#6b7280" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <span style={{ display: "inline-block", width: "0.75rem", height: "0.75rem", borderRadius: "0.25rem", backgroundColor: "#bbf7d0" }} />
            80+
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <span style={{ display: "inline-block", width: "0.75rem", height: "0.75rem", borderRadius: "0.25rem", backgroundColor: "#fef9c3" }} />
            40-79
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <span style={{ display: "inline-block", width: "0.75rem", height: "0.75rem", borderRadius: "0.25rem", backgroundColor: "#fee2e2" }} />
            0-39
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <span style={{ display: "inline-block", width: "0.75rem", height: "0.75rem", borderRadius: "0.25rem", backgroundColor: "#f3f4f6" }} />
            N/A
          </span>
        </div>
      </div>

      {/* Matrix Table */}
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-xs border-collapse">
          <thead>
            {/* Group header row */}
            <tr className="bg-muted/50">
              <th className="sticky left-0 z-20 bg-muted/50 px-3 py-2 text-left font-medium border-r min-w-[160px]">
                Entity Type
              </th>
              <th className="px-2 py-2 text-center font-medium border-r min-w-[48px]">
                Score
              </th>
              {groupedDims.map(({ group, dims }) => (
                <th
                  key={group.id}
                  colSpan={dims.length}
                  className="px-2 py-1.5 text-center font-medium border-r text-[10px] uppercase tracking-wider"
                >
                  {group.shortLabel}
                </th>
              ))}
            </tr>
            {/* Dimension header row */}
            <tr className="bg-muted/30">
              <th className="sticky left-0 z-20 bg-muted/30 border-r" />
              <th className="border-r" />
              {groupedDims.map(({ group, dims }) =>
                dims.map((dim, i) => (
                  <th
                    key={dim.id}
                    className={`px-1 py-1.5 text-center font-normal text-[9px] leading-tight ${
                      i === dims.length - 1 ? "border-r" : ""
                    }`}
                    title={dim.description}
                  >
                    <div className="max-w-[60px] truncate mx-auto">
                      {dim.label}
                    </div>
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <MatrixRow
                key={row.entityType}
                row={row}
                groupedDims={groupedDims}
                dimMap={dimMap}
                expanded={expandedRow === row.entityType}
                hoveredCell={hoveredCell}
                onToggleExpand={() =>
                  setExpandedRow(
                    expandedRow === row.entityType ? null : row.entityType,
                  )
                }
                onHoverCell={setHoveredCell}
              />
            ))}
          </tbody>
          {/* Footer: dimension averages */}
          <tfoot>
            <tr className="bg-muted/50 font-medium">
              <td className="sticky left-0 z-20 bg-muted/50 px-3 py-2 border-r border-t">
                Average
              </td>
              <td className="px-2 py-2 text-center border-r border-t">
                <span style={aggregateToStyle(snapshot.overallScore)}>
                  {snapshot.overallScore}
                </span>
              </td>
              {groupedDims.map(({ group, dims }) =>
                dims.map((dim, i) => {
                  const avg = snapshot.dimensionAverages[dim.id] ?? 0;
                  return (
                    <td
                      key={dim.id}
                      className={`px-1 py-2 text-center border-t ${
                        i === dims.length - 1 ? "border-r" : ""
                      }`}
                      style={scoreToStyle(avg)}
                    >
                      <span style={scoreToTextStyle(avg)}>{avg}</span>
                    </td>
                  );
                }),
              )}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Expanded Row Detail */}
      {expandedRow && (
        <ExpandedDetail
          row={rows.find((r) => r.entityType === expandedRow)!}
          groupedDims={groupedDims}
          dimMap={dimMap}
        />
      )}
    </div>
  );
}

// ============================================================================
// ROW COMPONENT
// ============================================================================

function MatrixRow({
  row,
  groupedDims,
  dimMap,
  expanded,
  hoveredCell,
  onToggleExpand,
  onHoverCell,
}: {
  row: EntityTypeRow;
  groupedDims: { group: DimensionGroupMeta; dims: DimensionDef[] }[];
  dimMap: Map<string, DimensionDef>;
  expanded: boolean;
  hoveredCell: { row: string; dim: string } | null;
  onToggleExpand: () => void;
  onHoverCell: (cell: { row: string; dim: string } | null) => void;
}) {
  return (
    <tr
      className={`hover:bg-muted/20 ${expanded ? "bg-muted/10" : ""}`}
    >
      <td
        className="sticky left-0 z-10 bg-background px-3 py-1.5 border-r cursor-pointer hover:underline"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{row.label}</span>
          {row.tier === "sub-entity" && (
            <span className="text-[9px] text-muted-foreground bg-muted rounded px-1">
              sub
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5 text-center border-r">
        <span style={aggregateToStyle(row.aggregateScore)}>
          {row.aggregateScore}
        </span>
      </td>
      {groupedDims.map(({ group, dims }) =>
        dims.map((dim, i) => {
          const cell = row.cells[dim.id];
          if (!cell) return <td key={dim.id} className="border-r" />;

          const isHovered =
            hoveredCell?.row === row.entityType &&
            hoveredCell?.dim === dim.id;

          return (
            <td
              key={dim.id}
              className={`px-1 py-1.5 text-center relative ${
                i === dims.length - 1 ? "border-r" : ""
              } ${isHovered ? "ring-2 ring-blue-400 z-10" : ""}`}
              style={scoreToStyle(cell.score)}
              title={`${dim.label}: ${cell.details ?? formatCellValue(cell)}`}
              onMouseEnter={() =>
                onHoverCell({ row: row.entityType, dim: dim.id })
              }
              onMouseLeave={() => onHoverCell(null)}
            >
              <span className="text-[10px]" style={scoreToTextStyle(cell.score)}>
                {formatCellValue(cell)}
              </span>
            </td>
          );
        }),
      )}
    </tr>
  );
}

// ============================================================================
// EXPANDED DETAIL PANEL
// ============================================================================

function ExpandedDetail({
  row,
  groupedDims,
  dimMap,
}: {
  row: EntityTypeRow;
  groupedDims: { group: DimensionGroupMeta; dims: DimensionDef[] }[];
  dimMap: Map<string, DimensionDef>;
}) {
  return (
    <div className="border rounded-lg p-4 bg-muted/10">
      <h3 className="font-semibold text-sm mb-3">
        {row.label}
        {row.tier === "sub-entity" && (
          <span className="text-muted-foreground font-normal ml-2 text-xs">
            (sub-entity)
          </span>
        )}
        <span className="ml-3" style={aggregateToStyle(row.aggregateScore)}>
          {row.aggregateScore}%
        </span>
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {groupedDims.map(({ group, dims }) => {
          const groupScore = row.groupScores[group.id];
          if (groupScore === undefined) return null;

          return (
            <div key={group.id} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{group.label}</span>
                <span style={aggregateToStyle(groupScore)}>
                  {groupScore}%
                </span>
              </div>
              {dims.map((dim) => {
                const cell = row.cells[dim.id];
                if (!cell) return null;

                return (
                  <div
                    key={dim.id}
                    className="flex items-center justify-between text-xs pl-2"
                  >
                    <span className="text-muted-foreground truncate mr-2">
                      {dim.label}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span style={scoreToTextStyle(cell.score)}>
                        {formatCellValue(cell)}
                      </span>
                      {cell.details && (
                        <span className="text-[9px] text-muted-foreground max-w-[120px] truncate">
                          {cell.details}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
