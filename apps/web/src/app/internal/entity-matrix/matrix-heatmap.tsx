"use client";

import { useState, useMemo, useRef, useEffect } from "react";
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
  if (score < 0) return { backgroundColor: "#f3f4f6" };
  if (score >= 80) return { backgroundColor: "#bbf7d0" };
  if (score >= 60) return { backgroundColor: "#dcfce7" };
  if (score >= 40) return { backgroundColor: "#fef9c3" };
  if (score > 0) return { backgroundColor: "#ffedd5" };
  return { backgroundColor: "#fee2e2" };
}

function scoreToTextStyle(score: number): React.CSSProperties {
  if (score < 0) return { color: "#9ca3af" };
  if (score >= 80) return { color: "#15803d" };
  if (score >= 60) return { color: "#16a34a" };
  if (score >= 40) return { color: "#a16207" };
  if (score > 0) return { color: "#c2410c" };
  return { color: "#b91c1c" };
}

function aggregateToStyle(score: number): React.CSSProperties {
  if (score >= 80) return { color: "#16a34a", fontWeight: 600 };
  if (score >= 60) return { color: "#16a34a" };
  if (score >= 40) return { color: "#ca8a04" };
  return { color: "#dc2626" };
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
  const str = String(cell.raw);
  if (str === "none") return "✗";
  if (str === "specialized") return "★";
  if (str === "generic") return "◆";
  if (str === "rich") return "★";
  if (str === "basic") return "◆";
  return str.charAt(0).toUpperCase();
}

function getEntityCounts(row: EntityTypeRow): { entities: number | null; pages: number | null } {
  // Prefer build_entity_count (from database.json) over yaml_entity_count
  const buildCell = row.cells["build_entity_count"];
  const yamlCell = row.cells["yaml_entity_count"];
  const mdxCell = row.cells["mdx_page_count"];
  const entities = typeof buildCell?.raw === "number" ? buildCell.raw
    : typeof yamlCell?.raw === "number" ? yamlCell.raw
    : null;
  return {
    entities,
    pages: typeof mdxCell?.raw === "number" ? mdxCell.raw : null,
  };
}

// ============================================================================
// FLOATING TOOLTIP
// ============================================================================

function FloatingTooltip({
  cell,
  dim,
  anchor,
}: {
  cell: CellValue;
  dim: DimensionDef;
  anchor: { x: number; y: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y - rect.height - 8;
    if (top < 4) top = anchor.y + 24;
    if (left + rect.width > vw - 8) left = vw - rect.width - 8;
    if (left < 4) left = 4;
    if (top + rect.height > vh - 4) top = vh - rect.height - 4;
    setPos({ left, top });
  }, [anchor.x, anchor.y]);

  const rawStr =
    cell.raw === null
      ? "N/A"
      : typeof cell.raw === "boolean"
        ? cell.raw ? "Yes" : "No"
        : String(cell.raw);

  const scorePct = cell.score >= 0 ? `${cell.score}%` : "N/A";

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 50,
        backgroundColor: "white",
        border: "1px solid #e5e7eb",
        borderRadius: "0.5rem",
        padding: "0.625rem 0.75rem",
        boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
        maxWidth: "280px",
        fontSize: "0.75rem",
        lineHeight: 1.4,
        pointerEvents: "none",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{dim.label}</div>
      <div style={{ color: "#6b7280", marginBottom: "0.375rem" }}>{dim.description}</div>
      <div style={{ display: "flex", gap: "0.75rem" }}>
        <div>
          <span style={{ color: "#6b7280" }}>Value: </span>
          <span style={{ fontWeight: 500 }}>{rawStr}</span>
        </div>
        <div>
          <span style={{ color: "#6b7280" }}>Score: </span>
          <span style={{ fontWeight: 500, ...scoreToTextStyle(cell.score) }}>{scorePct}</span>
        </div>
      </div>
      {cell.details && (
        <div style={{ color: "#6b7280", marginTop: "0.25rem", fontSize: "0.6875rem" }}>
          {cell.details}
        </div>
      )}
      <div style={{ color: "#9ca3af", marginTop: "0.25rem", fontSize: "0.625rem" }}>
        Group: {dim.group} &middot; Importance: {dim.importance}/10
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function MatrixHeatmap({ snapshot }: MatrixHeatmapProps) {
  const [sort, setSort] = useState<SortMode>("score-desc");
  const [filterTier, setFilterTier] = useState<FilterTier>("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    cell: CellValue;
    dim: DimensionDef;
    anchor: { x: number; y: number };
  } | null>(null);

  const dimMap = useMemo(
    () => new Map(snapshot.dimensions.map((d) => [d.id, d])),
    [snapshot.dimensions],
  );

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

  const groupedDims = useMemo(() => {
    return snapshot.dimensionGroups.map((group) => ({
      group,
      dims: snapshot.dimensions.filter((d) => d.group === group.id),
    }));
  }, [snapshot.dimensions, snapshot.dimensionGroups]);

  // Summary stats
  const totalYaml = useMemo(() => {
    let sum = 0;
    for (const row of snapshot.rows) {
      const c = row.cells["yaml_entity_count"];
      if (c && typeof c.raw === "number") sum += c.raw;
    }
    return sum;
  }, [snapshot.rows]);

  const totalMdx = useMemo(() => {
    let sum = 0;
    for (const row of snapshot.rows) {
      const c = row.cells["mdx_page_count"];
      if (c && typeof c.raw === "number") sum += c.raw;
    }
    return sum;
  }, [snapshot.rows]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
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
        <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>
          {totalYaml.toLocaleString()} entities &middot; {totalMdx.toLocaleString()} pages
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
      <div className="overflow-x-auto border rounded-lg" style={{ position: "relative" }}>
        <table className="w-full text-xs border-collapse">
          <thead>
            {/* Group header row */}
            <tr className="bg-muted/50">
              <th className="sticky left-0 z-20 bg-muted/50 px-3 py-2 text-left font-medium border-r" style={{ minWidth: "180px" }}>
                Entity Type
              </th>
              <th className="px-2 py-2 text-center font-medium border-r" style={{ minWidth: 40 }}>
                Score
              </th>
              <th className="px-2 py-2 text-center font-medium border-r" style={{ minWidth: 48 }} title="YAML entities / MDX pages">
                Count
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
              <th className="border-r px-1 py-1 text-center font-normal text-[9px] leading-tight" style={{ color: "#6b7280" }}>
                <div>Entities</div>
                <div>/Pages</div>
              </th>
              {groupedDims.map(({ dims }) =>
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
                onToggleExpand={() =>
                  setExpandedRow(
                    expandedRow === row.entityType ? null : row.entityType,
                  )
                }
                onShowTooltip={(cell, dim, anchor) => setTooltip({ cell, dim, anchor })}
                onHideTooltip={() => setTooltip(null)}
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
              <td className="px-2 py-2 text-center border-r border-t" style={{ fontSize: "0.625rem", color: "#6b7280" }}>
                {totalYaml} / {totalMdx}
              </td>
              {groupedDims.map(({ dims }) =>
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

      {/* Floating Tooltip */}
      {tooltip && (
        <FloatingTooltip cell={tooltip.cell} dim={tooltip.dim} anchor={tooltip.anchor} />
      )}

      {/* Expanded Row Detail */}
      {expandedRow && rows.find((r) => r.entityType === expandedRow) && (
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
  onToggleExpand,
  onShowTooltip,
  onHideTooltip,
}: {
  row: EntityTypeRow;
  groupedDims: { group: DimensionGroupMeta; dims: DimensionDef[] }[];
  dimMap: Map<string, DimensionDef>;
  expanded: boolean;
  onToggleExpand: () => void;
  onShowTooltip: (cell: CellValue, dim: DimensionDef, anchor: { x: number; y: number }) => void;
  onHideTooltip: () => void;
}) {
  const counts = getEntityCounts(row);

  return (
    <tr
      className={`hover:bg-muted/20 ${expanded ? "bg-muted/10" : ""}`}
    >
      <td
        className="sticky left-0 z-10 bg-background px-3 py-1.5 border-r cursor-pointer hover:underline"
        onClick={onToggleExpand}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
          <span className="font-medium">{row.label}</span>
          {row.tier === "sub-entity" && (
            <span style={{ fontSize: "0.5625rem", color: "#9ca3af", backgroundColor: "#f3f4f6", borderRadius: "0.25rem", padding: "0 0.25rem" }}>
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
      <td className="px-2 py-1.5 text-center border-r" style={{ fontSize: "0.625rem", color: "#6b7280", whiteSpace: "nowrap" }}>
        {counts.entities !== null || counts.pages !== null ? (
          <>
            <span style={{ color: counts.entities ? "#374151" : "#d1d5db" }}>
              {counts.entities ?? "—"}
            </span>
            <span style={{ color: "#d1d5db" }}> / </span>
            <span style={{ color: counts.pages ? "#374151" : "#d1d5db" }}>
              {counts.pages ?? "—"}
            </span>
          </>
        ) : (
          <span style={{ color: "#d1d5db" }}>—</span>
        )}
      </td>
      {groupedDims.map(({ dims }) =>
        dims.map((dim, i) => {
          const cell = row.cells[dim.id];
          if (!cell) return <td key={dim.id} className="border-r" />;

          return (
            <td
              key={dim.id}
              className={`px-1 py-1.5 text-center relative ${
                i === dims.length - 1 ? "border-r" : ""
              }`}
              style={scoreToStyle(cell.score)}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onShowTooltip(cell, dim, { x: rect.left + rect.width / 2, y: rect.top });
              }}
              onMouseLeave={onHideTooltip}
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
  const counts = getEntityCounts(row);

  return (
    <div className="border rounded-lg p-4 bg-muted/10">
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "0.75rem" }}>
        <h3 className="font-semibold text-sm" style={{ margin: 0 }}>
          {row.label}
          {row.tier === "sub-entity" && (
            <span className="text-muted-foreground font-normal ml-2 text-xs">
              (sub-entity)
            </span>
          )}
        </h3>
        <span style={aggregateToStyle(row.aggregateScore)}>
          {row.aggregateScore}%
        </span>
        {(counts.entities !== null || counts.pages !== null) && (
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            {counts.entities !== null && `${counts.entities} entities`}
            {counts.entities !== null && counts.pages !== null && " · "}
            {counts.pages !== null && `${counts.pages} pages`}
          </span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem" }}>
        {groupedDims.map(({ group, dims }) => {
          const groupScore = row.groupScores[group.id];
          if (groupScore === undefined) return null;

          return (
            <div key={group.id} style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.75rem" }}>
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
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.75rem", paddingLeft: "0.5rem" }}
                  >
                    <span className="text-muted-foreground truncate" style={{ marginRight: "0.5rem" }}>
                      {dim.label}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", flexShrink: 0 }}>
                      <span style={scoreToTextStyle(cell.score)}>
                        {formatCellValue(cell)}
                      </span>
                      {cell.details && (
                        <span style={{ fontSize: "0.5625rem", color: "#9ca3af", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
