/**
 * Lightweight SVG chart components for organization profile pages.
 * No external charting library — pure SVG + Tailwind, following the
 * MiniBarChart pattern from FactDashboard.
 *
 * Designed to be reusable across all org pages via getKBFacts() data.
 */
"use client";

import { useState } from "react";
import { formatCompactCurrency, formatCompactNumber } from "@/lib/format-compact";

// ── Types ───────────────────────────────────────────────────────────────

export interface TimeSeriesPoint {
  date: string; // ISO date or YYYY-MM
  value: number;
  low?: number;
  high?: number;
  label?: string; // e.g., "Series D"
}

export interface EquityHolder {
  name: string;
  stakePercent: number; // midpoint (0-100)
  stakeLow?: number;
  stakeHigh?: number;
  color: string;
  href?: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parseDate(d: string): number {
  // Support YYYY-MM and YYYY-MM-DD
  const parts = d.split("-");
  const year = parseInt(parts[0], 10);
  const month = parts[1] ? parseInt(parts[1], 10) - 1 : 0;
  const day = parts[2] ? parseInt(parts[2], 10) : 1;
  return new Date(year, month, day).getTime();
}

function formatDate(d: string): string {
  const parts = d.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = parts[1] ? months[parseInt(parts[1], 10) - 1] : "";
  const year = parts[0]?.slice(2); // '26' from '2026'
  return month ? `${month} '${year}` : parts[0];
}

type ValueFormatter = (n: number) => string;

const CURRENCY_FORMAT: ValueFormatter = (n) => formatCompactCurrency(n);
const NUMBER_FORMAT: ValueFormatter = (n) => formatCompactNumber(n);
const PERCENT_FORMAT: ValueFormatter = (n) => `${n.toFixed(0)}%`;

// ── TimeSeriesChart ─────────────────────────────────────────────────────

interface TimeSeriesConfig {
  data: TimeSeriesPoint[];
  color?: string;
  fillColor?: string;
  label: string;
}

export function TimeSeriesChart({
  series,
  title,
  format = "currency",
  height = 200,
  showArea = true,
  showDots = true,
  showLabels = true,
  annotations,
}: {
  series: TimeSeriesConfig[];
  title: string;
  format?: "currency" | "number" | "percent";
  height?: number;
  showArea?: boolean;
  showDots?: boolean;
  showLabels?: boolean;
  annotations?: Array<{ date: string; label: string; color?: string }>;
}) {
  const [hoveredPoint, setHoveredPoint] = useState<{
    seriesIdx: number;
    pointIdx: number;
    x: number;
    y: number;
  } | null>(null);

  const formatter: ValueFormatter =
    format === "currency" ? CURRENCY_FORMAT
      : format === "percent" ? PERCENT_FORMAT
        : NUMBER_FORMAT;

  // Collect all data points across all series
  const allPoints = series.flatMap((s) => s.data);
  if (allPoints.length === 0) return null;

  const allDates = allPoints.map((p) => parseDate(p.date));
  const allValues = allPoints.flatMap((p) => [p.value, p.low ?? p.value, p.high ?? p.value]);

  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const minVal = 0; // Start at 0 for area charts
  const maxVal = Math.max(...allValues) * 1.15; // 15% headroom

  const dateRange = maxDate - minDate || 1;
  const valRange = maxVal - minVal || 1;

  // Chart dimensions
  const padding = { top: 20, right: 16, bottom: 32, left: 70 };
  const chartWidth = 600;
  const chartW = chartWidth - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const xScale = (d: string) =>
    padding.left + ((parseDate(d) - minDate) / dateRange) * chartW;
  const yScale = (v: number) =>
    padding.top + chartH - ((v - minVal) / valRange) * chartH;

  // Y-axis ticks (4-5 ticks)
  const yTicks: number[] = [];
  const tickStep = valRange / 4;
  for (let i = 0; i <= 4; i++) {
    yTicks.push(minVal + tickStep * i);
  }

  // X-axis labels: use unique years
  const years = [...new Set(allPoints.map((p) => p.date.split("-")[0]))].sort();

  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      <svg
        viewBox={`0 0 ${chartWidth} ${height}`}
        className="w-full"
        style={{ maxHeight: `${height}px` }}
      >
        {/* Grid lines */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={yScale(tick)}
              x2={chartWidth - padding.right}
              y2={yScale(tick)}
              stroke="currentColor"
              strokeOpacity={0.08}
              strokeDasharray={i === 0 ? undefined : "4 4"}
            />
            <text
              x={padding.left - 8}
              y={yScale(tick) + 4}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={10}
            >
              {formatter(tick)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {years.map((year) => {
          const x = xScale(`${year}-06`);
          return (
            <text
              key={year}
              x={Math.max(padding.left, Math.min(x, chartWidth - padding.right))}
              y={height - 6}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize={10}
            >
              {year}
            </text>
          );
        })}

        {/* Annotation lines */}
        {annotations?.map((ann, i) => {
          const x = xScale(ann.date);
          return (
            <g key={`ann-${i}`}>
              <line
                x1={x}
                y1={padding.top}
                x2={x}
                y2={padding.top + chartH}
                stroke={ann.color ?? "#94a3b8"}
                strokeDasharray="3 3"
                strokeOpacity={0.5}
              />
              <text
                x={x}
                y={padding.top - 4}
                textAnchor="middle"
                fontSize={8}
                className="fill-muted-foreground"
              >
                {ann.label}
              </text>
            </g>
          );
        })}

        {/* Series */}
        {series.map((s, si) => {
          const sorted = [...s.data].sort(
            (a, b) => parseDate(a.date) - parseDate(b.date),
          );
          if (sorted.length < 2) return null;

          const color = s.color ?? "var(--color-primary)";
          const fill = s.fillColor ?? color;

          // Build line path
          const linePath = sorted
            .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.date)} ${yScale(p.value)}`)
            .join(" ");

          // Build area path
          const areaPath = showArea
            ? `${linePath} L ${xScale(sorted[sorted.length - 1].date)} ${yScale(0)} L ${xScale(sorted[0].date)} ${yScale(0)} Z`
            : "";

          return (
            <g key={si}>
              {/* Area fill */}
              {showArea && (
                <path d={areaPath} fill={fill} fillOpacity={0.1} />
              )}

              {/* Line */}
              <path
                d={linePath}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Dots + labels */}
              {sorted.map((p, pi) => {
                const cx = xScale(p.date);
                const cy = yScale(p.value);
                const isHovered =
                  hoveredPoint?.seriesIdx === si && hoveredPoint?.pointIdx === pi;

                return (
                  <g key={pi}>
                    {/* Range whisker */}
                    {p.low != null && p.high != null && (
                      <line
                        x1={cx}
                        y1={yScale(p.low)}
                        x2={cx}
                        y2={yScale(p.high)}
                        stroke={color}
                        strokeWidth={1.5}
                        strokeOpacity={0.4}
                      />
                    )}

                    {showDots && (
                      <>
                        {/* Hover target (larger, invisible) */}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={12}
                          fill="transparent"
                          onMouseEnter={() =>
                            setHoveredPoint({ seriesIdx: si, pointIdx: pi, x: cx, y: cy })
                          }
                          onMouseLeave={() => setHoveredPoint(null)}
                        />
                        {/* Visible dot */}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isHovered ? 5 : 3.5}
                          fill={color}
                          stroke="var(--color-card)"
                          strokeWidth={2}
                          className="transition-all duration-150"
                        />
                      </>
                    )}

                    {/* Persistent labels for key points */}
                    {showLabels && p.label && (
                      <text
                        x={cx}
                        y={cy - 10}
                        textAnchor="middle"
                        fontSize={8}
                        className="fill-muted-foreground"
                        fontWeight={500}
                      >
                        {p.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Hover tooltip */}
        {hoveredPoint && (() => {
          const s = series[hoveredPoint.seriesIdx];
          const sorted = [...s.data].sort(
            (a, b) => parseDate(a.date) - parseDate(b.date),
          );
          const p = sorted[hoveredPoint.pointIdx];
          if (!p) return null;

          const label = `${formatDate(p.date)}: ${formatter(p.value)}${p.label ? ` (${p.label})` : ""}`;
          const textWidth = label.length * 5.5 + 16;
          const tx = Math.min(
            hoveredPoint.x - textWidth / 2,
            chartWidth - padding.right - textWidth,
          );

          return (
            <g>
              <rect
                x={Math.max(padding.left, tx)}
                y={hoveredPoint.y - 32}
                width={textWidth}
                height={20}
                rx={4}
                fill="var(--color-popover)"
                stroke="var(--color-border)"
                strokeWidth={0.5}
              />
              <text
                x={Math.max(padding.left + textWidth / 2, hoveredPoint.x)}
                y={hoveredPoint.y - 18}
                textAnchor="middle"
                fontSize={10}
                fontWeight={600}
                className="fill-popover-foreground"
              >
                {label}
              </text>
            </g>
          );
        })()}
      </svg>

      {/* Legend for multi-series */}
      {series.length > 1 && (
        <div className="flex items-center gap-4 mt-2 justify-center">
          {series.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div
                className="w-3 h-0.5 rounded-full"
                style={{ backgroundColor: s.color ?? "var(--color-primary)" }}
              />
              <span className="text-[10px] text-muted-foreground">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── EquityBreakdownChart ────────────────────────────────────────────────

export function EquityBreakdownChart({
  holders,
  valuation,
  title = "Equity Breakdown",
}: {
  holders: EquityHolder[];
  valuation?: number;
  title?: string;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (holders.length === 0) return null;

  // Sort by stake descending
  const sorted = [...holders].sort((a, b) => b.stakePercent - a.stakePercent);
  const totalShown = sorted.reduce((s, h) => s + h.stakePercent, 0);
  const otherPercent = Math.max(0, 100 - totalShown);

  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>

      {/* Stacked horizontal bar */}
      <div className="relative h-8 rounded-lg overflow-hidden flex mb-4">
        {sorted.map((h, i) => (
          <div
            key={i}
            className="relative transition-opacity duration-150 cursor-default"
            style={{
              width: `${h.stakePercent}%`,
              backgroundColor: h.color,
              opacity: hoveredIdx === null || hoveredIdx === i ? 1 : 0.4,
            }}
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {h.stakePercent > 8 && (
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-white/90 truncate px-1">
                {h.stakePercent.toFixed(0)}%
              </span>
            )}
          </div>
        ))}
        {otherPercent > 2 && (
          <div
            className="bg-gray-200 dark:bg-gray-700"
            style={{ width: `${otherPercent}%` }}
          >
            {otherPercent > 8 && (
              <span className="absolute inset-y-0 flex items-center text-[10px] text-muted-foreground px-1">
                Other
              </span>
            )}
          </div>
        )}
      </div>

      {/* Legend table */}
      <div className="space-y-1.5">
        {sorted.map((h, i) => {
          const equityValue = valuation
            ? (h.stakePercent / 100) * valuation
            : null;
          const isHovered = hoveredIdx === i;

          return (
            <div
              key={i}
              className={`flex items-center gap-2 text-sm py-0.5 px-1 rounded transition-colors ${isHovered ? "bg-muted/50" : ""}`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div
                className="w-3 h-3 rounded-sm shrink-0"
                style={{ backgroundColor: h.color }}
              />
              <span className="flex-1 truncate font-medium text-xs">
                {h.name}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {h.stakeLow != null && h.stakeHigh != null
                  ? `${h.stakeLow}–${h.stakeHigh}%`
                  : `~${h.stakePercent.toFixed(1)}%`}
              </span>
              {equityValue != null && (
                <span className="text-xs font-semibold tabular-nums whitespace-nowrap">
                  {formatCompactCurrency(equityValue)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {valuation && (
        <p className="text-[10px] text-muted-foreground mt-3">
          Based on {formatCompactCurrency(valuation)} valuation
        </p>
      )}
    </div>
  );
}

// ── DilutionWaterfallChart ──────────────────────────────────────────────

export interface DilutionStage {
  round: string;
  date: string;
  foundersPercent: number;
  employeesPercent: number;
  investorsPercent: number;
  valuation?: number;
}

export function DilutionWaterfallChart({
  stages,
  title = "Ownership Over Time",
}: {
  stages: DilutionStage[];
  title?: string;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (stages.length === 0) return null;

  const barHeight = 24;
  const gap = 4;
  const labelWidth = 90;
  const chartWidth = 500;
  const barAreaWidth = chartWidth - labelWidth - 60;

  const categories = [
    { key: "foundersPercent" as const, label: "Founders", color: "#f59e0b" },
    { key: "employeesPercent" as const, label: "Employees", color: "#6366f1" },
    { key: "investorsPercent" as const, label: "Investors", color: "#64748b" },
  ];

  const totalHeight = stages.length * (barHeight + gap) + 50;

  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>

      <svg
        viewBox={`0 0 ${chartWidth} ${totalHeight}`}
        className="w-full"
      >
        {stages.map((stage, si) => {
          const y = si * (barHeight + gap);
          let xOffset = labelWidth;
          const isHovered = hoveredIdx === si;

          return (
            <g
              key={si}
              onMouseEnter={() => setHoveredIdx(si)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="cursor-default"
            >
              {/* Round label */}
              <text
                x={labelWidth - 6}
                y={y + barHeight / 2 + 4}
                textAnchor="end"
                fontSize={10}
                fontWeight={isHovered ? 600 : 400}
                className="fill-foreground"
              >
                {stage.round}
              </text>

              {/* Stacked bars */}
              {categories.map((cat) => {
                const pct = stage[cat.key];
                const width = (pct / 100) * barAreaWidth;
                const x = xOffset;
                xOffset += width;

                return (
                  <rect
                    key={cat.key}
                    x={x}
                    y={y}
                    width={width}
                    height={barHeight}
                    fill={cat.color}
                    fillOpacity={isHovered ? 1 : 0.7}
                    rx={si === 0 && cat.key === "foundersPercent" ? 3 : 0}
                  />
                );
              })}

              {/* Valuation annotation */}
              {stage.valuation && (
                <text
                  x={labelWidth + barAreaWidth + 6}
                  y={y + barHeight / 2 + 4}
                  fontSize={9}
                  className="fill-muted-foreground"
                >
                  {formatCompactCurrency(stage.valuation)}
                </text>
              )}
            </g>
          );
        })}

        {/* Legend */}
        {categories.map((cat, i) => (
          <g key={i} transform={`translate(${labelWidth + i * 100}, ${totalHeight - 16})`}>
            <rect width={10} height={10} fill={cat.color} fillOpacity={0.7} rx={2} />
            <text x={14} y={9} fontSize={10} className="fill-muted-foreground">
              {cat.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── MarketShareChart ────────────────────────────────────────────────────

export interface MarketShareEntry {
  company: string;
  share: number; // 0-100
  color: string;
}

export function MarketShareChart({
  data,
  title,
  subtitle,
}: {
  data: MarketShareEntry[];
  title: string;
  subtitle?: string;
}) {
  if (data.length === 0) return null;

  const sorted = [...data].sort((a, b) => b.share - a.share);

  return (
    <div className="border border-border rounded-xl p-4 bg-card">
      <h3 className="text-sm font-semibold">{title}</h3>
      {subtitle && (
        <p className="text-[10px] text-muted-foreground mb-3">{subtitle}</p>
      )}
      <div className="space-y-2 mt-3">
        {sorted.map((entry, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="text-xs w-[100px] truncate font-medium">
              {entry.company}
            </span>
            <div className="flex-1 h-5 bg-muted rounded-sm relative overflow-hidden">
              <div
                className="h-full rounded-sm transition-all"
                style={{
                  width: `${entry.share}%`,
                  backgroundColor: entry.color,
                  opacity: 0.7,
                }}
              />
            </div>
            <span className="text-xs font-semibold tabular-nums w-[40px] text-right">
              {entry.share}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
