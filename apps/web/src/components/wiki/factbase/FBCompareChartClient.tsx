/**
 * FBCompareChartClient — Client-side SVG chart for multi-entity comparison.
 *
 * Pure SVG + Tailwind, no external charting library. Renders multiple colored
 * lines with a legend and hover tooltips. Modeled after the org-charts.tsx
 * TimeSeriesChart but optimized for comparison (no area fill, prominent legend).
 */
"use client";

import { useState, useRef } from "react";
import { formatCompactCurrency, formatCompactNumber } from "@/lib/format-compact";

// ── Types ───────────────────────────────────────────────────────────

export interface ChartSeries {
  entityName: string;
  color: string;
  points: Array<{ date: string; value: number }>;
}

type ChartFormat = "currency" | "number" | "percent";
type ValueFormatter = (n: number) => string;

// ── Helpers ─────────────────────────────────────────────────────────

function parseDate(d: string): number {
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
  return month ? `${month} ${parts[0]}` : parts[0];
}

const CURRENCY_FORMAT: ValueFormatter = (n) => formatCompactCurrency(n);
const NUMBER_FORMAT: ValueFormatter = (n) => formatCompactNumber(n);
const PERCENT_FORMAT: ValueFormatter = (n) => `${n.toFixed(1)}%`;

function getFormatter(format: ChartFormat): ValueFormatter {
  if (format === "currency") return CURRENCY_FORMAT;
  if (format === "percent") return PERCENT_FORMAT;
  return NUMBER_FORMAT;
}

// ── Component ───────────────────────────────────────────────────────

type ViewMode = "chart" | "table";

export function FBCompareChartClient({
  series,
  format = "number",
  height = 240,
}: {
  series: ChartSeries[];
  format?: ChartFormat;
  height?: number;
}) {
  const [hovered, setHovered] = useState<{
    seriesIdx: number;
    pointIdx: number;
    svgX: number;
    svgY: number;
  } | null>(null);
  const [logScale, setLogScale] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("chart");
  const containerRef = useRef<HTMLDivElement>(null);
  const formatter = getFormatter(format);

  // Flatten all points across all series for scale computation
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) return null;

  const allDates = allPoints.map((p) => parseDate(p.date));
  const allValues = allPoints.map((p) => p.value).filter((v) => v > 0);

  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);

  // Check if log scale would be useful (>10x range between min and max values)
  const minPositiveVal = Math.min(...allValues);
  const maxRawVal = Math.max(...allValues);
  const showLogToggle = maxRawVal / minPositiveVal > 10;

  const minVal = logScale ? Math.max(minPositiveVal * 0.5, 1) : 0;
  const maxVal = logScale ? maxRawVal * 1.5 : maxRawVal * 1.15;

  const dateRange = maxDate - minDate || 1;

  const padding = { top: 16, right: 16, bottom: 28, left: 62 };
  const chartWidth = 600;
  const chartW = chartWidth - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const xScale = (d: string) =>
    padding.left + ((parseDate(d) - minDate) / dateRange) * chartW;
  const yScale = (v: number) => {
    if (logScale && v > 0) {
      const logMin = Math.log10(minVal);
      const logMax = Math.log10(maxVal);
      const logRange = logMax - logMin || 1;
      return padding.top + chartH - ((Math.log10(v) - logMin) / logRange) * chartH;
    }
    const valRange = maxVal - minVal || 1;
    return padding.top + chartH - ((v - minVal) / valRange) * chartH;
  };

  // Y-axis ticks
  const yTicks: number[] = [];
  if (logScale) {
    // Log-scale ticks: powers of 10 within the range
    const logMin = Math.floor(Math.log10(minVal));
    const logMax = Math.ceil(Math.log10(maxVal));
    for (let exp = logMin; exp <= logMax; exp++) {
      const val = Math.pow(10, exp);
      if (val >= minVal * 0.9 && val <= maxVal * 1.1) yTicks.push(val);
    }
    // If too few ticks, add half-decade marks
    if (yTicks.length < 3) {
      for (let exp = logMin; exp <= logMax; exp++) {
        const half = Math.pow(10, exp) * 3;
        if (half >= minVal * 0.9 && half <= maxVal * 1.1 && !yTicks.includes(half)) {
          yTicks.push(half);
        }
      }
      yTicks.sort((a, b) => a - b);
    }
  } else {
    const valRange = maxVal - minVal || 1;
    const rawTickStep = valRange / 4;
    const tickStep = format === "number" ? Math.ceil(rawTickStep) : rawTickStep;
    for (let i = 0; i <= 4; i++) {
      const raw = minVal + tickStep * i;
      yTicks.push(format === "number" ? Math.round(raw) : raw);
    }
  }

  // X-axis year labels
  const years = [
    ...new Set(allPoints.map((p) => p.date.split("-")[0])),
  ].sort();

  // Tooltip content
  const hoveredSeries = hovered ? series[hovered.seriesIdx] : null;
  const hoveredPoint = hovered
    ? series[hovered.seriesIdx]?.points[hovered.pointIdx]
    : null;

  // Accessibility label
  const ariaLabel = (() => {
    const parts: string[] = ["Comparison chart."];
    for (const s of series) {
      if (s.points.length < 2) continue;
      const first = s.points[0];
      const last = s.points[s.points.length - 1];
      parts.push(
        `${s.entityName}: ${formatter(first.value)} in ${first.date.slice(0, 4)} to ${formatter(last.value)} in ${last.date.slice(0, 4)}.`,
      );
    }
    return parts.join(" ");
  })();

  return (
    <div>
      {/* Legend + controls row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
        {series.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-foreground/80">{s.entityName}</span>
          </div>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* View toggle controls */}
        <div className="flex items-center gap-1 text-[10px]">
          {showLogToggle && viewMode === "chart" && (
            <button
              onClick={() => setLogScale(!logScale)}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                logScale
                  ? "bg-foreground/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              Log
            </button>
          )}
          <button
            onClick={() => setViewMode("chart")}
            className={`px-1.5 py-0.5 rounded transition-colors ${
              viewMode === "chart"
                ? "bg-foreground/10 text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground/70"
            }`}
          >
            Chart
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`px-1.5 py-0.5 rounded transition-colors ${
              viewMode === "table"
                ? "bg-foreground/10 text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground/70"
            }`}
          >
            Table
          </button>
        </div>
      </div>

      {/* Data table view */}
      {viewMode === "table" && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50">
                <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Entity</th>
                {years.map((year) => (
                  <th key={year} className="text-right py-1.5 px-2 font-medium text-muted-foreground tabular-nums">{year}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((s, si) => (
                <tr key={si} className="border-b border-border/30">
                  <td className="py-1.5 pr-3 font-medium">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                      {s.entityName}
                    </span>
                  </td>
                  {years.map((year) => {
                    const point = s.points.find((p) => p.date.startsWith(year));
                    return (
                      <td key={year} className="text-right py-1.5 px-2 tabular-nums">
                        {point ? formatter(point.value) : <span className="text-muted-foreground">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Chart view */}
      {viewMode === "chart" && (
      <div className="relative" ref={containerRef}>
        <svg
          viewBox={`0 0 ${chartWidth} ${height}`}
          className="w-full"
          style={{ maxHeight: `${height}px` }}
          role="img"
          aria-label={ariaLabel}
        >
          <title>{ariaLabel}</title>

          {/* Grid lines */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={padding.left}
                y1={yScale(tick)}
                x2={chartWidth - padding.right}
                y2={yScale(tick)}
                stroke="currentColor"
                strokeOpacity={i === 0 ? 0.12 : 0.06}
                strokeWidth={i === 0 ? 1 : 0.5}
              />
              <text
                x={padding.left - 8}
                y={yScale(tick) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground"
                fontSize={9.5}
                style={{ fontVariantNumeric: "tabular-nums" }}
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
                y={height - 4}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={9.5}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {year}
              </text>
            );
          })}

          {/* Series lines + dots */}
          {series.map((s, si) => {
            const { points, color } = s;
            if (points.length < 2) return null;

            const linePath = points
              .map(
                (p, i) =>
                  `${i === 0 ? "M" : "L"} ${xScale(p.date)} ${yScale(p.value)}`,
              )
              .join(" ");

            return (
              <g key={si}>
                {/* Line */}
                <path
                  d={linePath}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={
                    hovered && hovered.seriesIdx !== si ? 0.25 : 1
                  }
                  className="transition-opacity duration-150"
                />

                {/* Dots */}
                {points.map((p, pi) => {
                  const cx = xScale(p.date);
                  const cy = yScale(p.value);
                  const isHovered =
                    hovered?.seriesIdx === si && hovered?.pointIdx === pi;
                  const isLast = pi === points.length - 1;
                  const dimmed = hovered !== null && hovered.seriesIdx !== si;

                  return (
                    <g key={pi}>
                      {/* Invisible hit target */}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={14}
                        fill="transparent"
                        onMouseEnter={() =>
                          setHovered({
                            seriesIdx: si,
                            pointIdx: pi,
                            svgX: cx,
                            svgY: cy,
                          })
                        }
                        onMouseLeave={() => setHovered(null)}
                      />
                      {/* Outer ring on hover/last */}
                      {(isHovered || isLast) && !dimmed && (
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isHovered ? 7 : 5}
                          fill="none"
                          stroke={color}
                          strokeWidth={1.5}
                          strokeOpacity={isHovered ? 0.3 : 0.15}
                          className="transition-all duration-200"
                        />
                      )}
                      {/* Inner dot */}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={isHovered ? 4 : isLast && !dimmed ? 3 : 2}
                        fill={color}
                        stroke="var(--color-card)"
                        strokeWidth={1.5}
                        opacity={dimmed ? 0.3 : 1}
                        className="transition-all duration-200"
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {/* Tooltip overlay */}
        {hovered && hoveredSeries && hoveredPoint && containerRef.current && (
          <CompareTooltip
            containerRef={containerRef}
            svgX={hovered.svgX}
            svgY={hovered.svgY}
            chartWidth={chartWidth}
            chartHeight={height}
            entityName={hoveredSeries.entityName}
            color={hoveredSeries.color}
            value={formatter(hoveredPoint.value)}
            date={formatDate(hoveredPoint.date)}
          />
        )}
      </div>
      )}
    </div>
  );
}

// ── Tooltip ─────────────────────────────────────────────────────────

function CompareTooltip({
  containerRef,
  svgX,
  svgY,
  chartWidth,
  chartHeight,
  entityName,
  color,
  value,
  date,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  svgX: number;
  svgY: number;
  chartWidth: number;
  chartHeight: number;
  entityName: string;
  color: string;
  value: string;
  date: string;
}) {
  const container = containerRef.current;
  if (!container) return null;

  const rect = container.getBoundingClientRect();
  const pxX = (svgX / chartWidth) * rect.width;
  const pxY = (svgY / chartHeight) * rect.height;

  const tooltipLeft = Math.max(8, Math.min(pxX, rect.width - 140));
  const tooltipTop = Math.max(0, pxY - 8);

  return (
    <div
      className="absolute z-20 -translate-x-1/2 -translate-y-full pointer-events-none"
      style={{ left: tooltipLeft, top: tooltipTop }}
    >
      <div className="bg-popover/95 backdrop-blur-sm border border-border/60 rounded-lg shadow-lg px-3 py-2 text-xs whitespace-nowrap">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="font-medium text-foreground">{entityName}</span>
        </div>
        <div className="text-foreground/90 font-semibold tabular-nums">
          {value}
        </div>
        <div className="text-muted-foreground">{date}</div>
      </div>
    </div>
  );
}
