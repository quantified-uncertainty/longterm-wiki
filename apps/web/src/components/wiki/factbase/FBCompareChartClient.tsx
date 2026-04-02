/**
 * FBCompareChartClient — Client-side SVG chart for multi-entity comparison.
 *
 * Design: editorial data-journalism aesthetic. Multi-colored lines with
 * interactive legend (click to toggle series), segmented view controls
 * (Log/Chart/Table), and a polished inline data table.
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
type ViewMode = "chart" | "table";

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

// ── Segmented Control ───────────────────────────────────────────────

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md bg-muted/60 p-0.5 text-[10px]">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2 py-[3px] rounded-[5px] transition-all duration-150 font-medium ${
            value === opt.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground/60"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────

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
  const [hiddenSeries, setHiddenSeries] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const formatter = getFormatter(format);

  // Filter visible series
  const visibleSeries = series.filter((_, i) => !hiddenSeries.has(i));

  // Toggle a series on/off by clicking the legend
  const toggleSeries = (idx: number) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else if (series.length - next.size > 1) next.add(idx); // keep at least 1 visible
      return next;
    });
  };

  // Flatten all VISIBLE points for scale computation
  const allPoints = visibleSeries.flatMap((s) => s.points);
  if (allPoints.length === 0) return null;

  const allDates = allPoints.map((p) => parseDate(p.date));
  const allValues = allPoints.map((p) => p.value).filter((v) => v > 0);

  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);

  const minPositiveVal = allValues.length > 0 ? Math.min(...allValues) : 1;
  const maxRawVal = allValues.length > 0 ? Math.max(...allValues) : 1;
  const showLogToggle = maxRawVal / minPositiveVal > 10;

  const minVal = logScale ? Math.max(minPositiveVal * 0.5, 1) : 0;
  const maxVal = logScale ? maxRawVal * 1.5 : maxRawVal * 1.15;

  const dateRange = maxDate - minDate || 1;

  const padding = { top: 12, right: 16, bottom: 28, left: 58 };
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
    const logMin = Math.floor(Math.log10(minVal));
    const logMax = Math.ceil(Math.log10(maxVal));
    for (let exp = logMin; exp <= logMax; exp++) {
      const val = Math.pow(10, exp);
      if (val >= minVal * 0.9 && val <= maxVal * 1.1) yTicks.push(val);
    }
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

  const years = [...new Set(allPoints.map((p) => p.date.split("-")[0]))].sort();

  // Tooltip refs
  const hoveredSeriesData = hovered ? series[hovered.seriesIdx] : null;
  const hoveredPoint = hovered
    ? series[hovered.seriesIdx]?.points[hovered.pointIdx]
    : null;

  const ariaLabel = (() => {
    const parts: string[] = ["Comparison chart."];
    for (const s of visibleSeries) {
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
      {/* Legend + controls */}
      <div className="flex flex-wrap items-center gap-y-2 mb-3">
        {/* Interactive legend */}
        <div className="flex flex-wrap gap-x-1 gap-y-1 flex-1 min-w-0">
          {series.map((s, i) => {
            const isHidden = hiddenSeries.has(i);
            return (
              <button
                key={i}
                onClick={() => toggleSeries(i)}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] transition-all duration-150 ${
                  isHidden
                    ? "opacity-40 hover:opacity-60"
                    : "opacity-100 hover:bg-muted/40"
                }`}
                title={isHidden ? `Show ${s.entityName}` : `Hide ${s.entityName}`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0 transition-opacity"
                  style={{ backgroundColor: s.color }}
                />
                <span className={`${isHidden ? "line-through" : ""} text-foreground/80`}>
                  {s.entityName}
                </span>
              </button>
            );
          })}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {showLogToggle && viewMode === "chart" && (
            <SegmentedControl
              options={[
                { value: "linear" as const, label: "Linear" },
                { value: "log" as const, label: "Log" },
              ]}
              value={logScale ? "log" : "linear"}
              onChange={(v) => setLogScale(v === "log")}
            />
          )}
          <SegmentedControl
            options={[
              { value: "chart" as ViewMode, label: "Chart" },
              { value: "table" as ViewMode, label: "Table" },
            ]}
            value={viewMode}
            onChange={setViewMode}
          />
        </div>
      </div>

      {/* ── Table view ── */}
      {viewMode === "table" && (
        <div className="overflow-x-auto rounded-lg border border-border/40">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/30">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground text-[11px] tracking-wide uppercase">
                  Entity
                </th>
                {years.map((year) => (
                  <th
                    key={year}
                    className="text-right py-2 px-3 font-medium text-muted-foreground text-[11px] tracking-wide"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {year}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((s, si) => {
                const isHidden = hiddenSeries.has(si);
                return (
                  <tr
                    key={si}
                    className={`border-t border-border/30 transition-opacity ${
                      si % 2 === 0 ? "bg-transparent" : "bg-muted/10"
                    } ${isHidden ? "opacity-30" : ""}`}
                  >
                    <td className="py-2 px-3 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: s.color }}
                        />
                        <span className="text-foreground/80">{s.entityName}</span>
                      </span>
                    </td>
                    {years.map((year) => {
                      const point = s.points.find((p) => p.date.startsWith(year));
                      return (
                        <td
                          key={year}
                          className="text-right py-2 px-3 text-foreground/80"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {point ? (
                            <span className="font-medium">{formatter(point.value)}</span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Chart view ── */}
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

            {/* Grid */}
            {yTicks.map((tick, i) => (
              <g key={i}>
                <line
                  x1={padding.left}
                  y1={yScale(tick)}
                  x2={chartWidth - padding.right}
                  y2={yScale(tick)}
                  stroke="currentColor"
                  strokeOpacity={i === 0 ? 0.12 : 0.05}
                  strokeWidth={i === 0 ? 1 : 0.5}
                />
                <text
                  x={padding.left - 8}
                  y={yScale(tick) + 3.5}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  fontSize={9}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatter(tick)}
                </text>
              </g>
            ))}

            {/* X-axis */}
            {years.map((year) => {
              const x = xScale(`${year}-06`);
              return (
                <text
                  key={year}
                  x={Math.max(padding.left, Math.min(x, chartWidth - padding.right))}
                  y={height - 4}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  fontSize={9}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {year}
                </text>
              );
            })}

            {/* Series */}
            {series.map((s, si) => {
              if (hiddenSeries.has(si)) return null;
              const { points, color } = s;
              if (points.length < 2) return null;

              const linePath = points
                .map(
                  (p, i) =>
                    `${i === 0 ? "M" : "L"} ${xScale(p.date)} ${yScale(p.value)}`,
                )
                .join(" ");

              const isAnyHovered = hovered !== null;
              const isThisHovered = hovered?.seriesIdx === si;

              return (
                <g key={si}>
                  <path
                    d={linePath}
                    fill="none"
                    stroke={color}
                    strokeWidth={isThisHovered ? 2.5 : 2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeOpacity={isAnyHovered && !isThisHovered ? 0.2 : 1}
                    className="transition-all duration-200"
                  />

                  {points.map((p, pi) => {
                    const cx = xScale(p.date);
                    const cy = yScale(p.value);
                    const isPointHovered = hovered?.seriesIdx === si && hovered?.pointIdx === pi;
                    const isLast = pi === points.length - 1;
                    const dimmed = isAnyHovered && !isThisHovered;

                    return (
                      <g key={pi}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={14}
                          fill="transparent"
                          onMouseEnter={() =>
                            setHovered({ seriesIdx: si, pointIdx: pi, svgX: cx, svgY: cy })
                          }
                          onMouseLeave={() => setHovered(null)}
                        />
                        {(isPointHovered || isLast) && !dimmed && (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={isPointHovered ? 7 : 5}
                            fill="none"
                            stroke={color}
                            strokeWidth={1.5}
                            strokeOpacity={isPointHovered ? 0.25 : 0.12}
                            className="transition-all duration-200"
                          />
                        )}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isPointHovered ? 4 : isLast && !dimmed ? 3 : 2}
                          fill={color}
                          stroke="var(--color-card)"
                          strokeWidth={1.5}
                          opacity={dimmed ? 0.2 : 1}
                          className="transition-all duration-200"
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>

          {/* Tooltip */}
          {hovered && hoveredSeriesData && hoveredPoint && containerRef.current && (
            <CompareTooltip
              containerRef={containerRef}
              svgX={hovered.svgX}
              svgY={hovered.svgY}
              chartWidth={chartWidth}
              chartHeight={height}
              entityName={hoveredSeriesData.entityName}
              color={hoveredSeriesData.color}
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
      <div className="bg-popover/95 backdrop-blur-sm border border-border/50 rounded-lg shadow-lg px-3 py-2 text-xs whitespace-nowrap">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="font-medium text-foreground">{entityName}</span>
        </div>
        <div
          className="text-foreground font-semibold text-sm"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </div>
        <div className="text-muted-foreground mt-0.5">{date}</div>
      </div>
    </div>
  );
}
