/**
 * SVG chart components for organization profile pages.
 *
 * Design language: editorial data-journalism (FT / Bloomberg / Economist).
 * Pure SVG + Tailwind — no external charting library.
 * Each chart type has a distinctive accent color visible as a top-border stripe.
 *
 * Visual features:
 * - Gradient area fills via <linearGradient>
 * - Animated line draw on mount via CSS strokeDashoffset
 * - HTML-overlay tooltips with backdrop-blur
 * - Latest-value callout in the card header
 * - Fine dotted grid pattern
 */
"use client";

import { useState, useRef, useEffect, useId, type CSSProperties } from "react";
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
  const year = parts[0];
  return month ? `${month} ${year}` : parts[0];
}

type ValueFormatter = (n: number) => string;

const CURRENCY_FORMAT: ValueFormatter = (n) => formatCompactCurrency(n);
const NUMBER_FORMAT: ValueFormatter = (n) => formatCompactNumber(n);
const PERCENT_FORMAT: ValueFormatter = (n) => `${n.toFixed(0)}%`;

// ── Shared card wrapper ─────────────────────────────────────────────────

function ChartCard({
  title,
  accentColor,
  latestValue,
  latestLabel,
  children,
}: {
  title: string;
  accentColor: string;
  latestValue?: string;
  latestLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl overflow-hidden bg-card">

      {/* Header */}
      <div className="px-4 pt-3.5 pb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground/80">
          {title}
        </h3>
        {latestValue && (
          <div className="flex items-baseline gap-1.5 shrink-0">
            <span
              className="text-base font-bold tracking-[-0.02em]"
              style={{ color: accentColor, fontVariantNumeric: "tabular-nums" }}
            >
              {latestValue}
            </span>
            {latestLabel && (
              <span className="text-[10px] text-muted-foreground font-medium">
                {latestLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="px-4 pb-4">
        {children}
      </div>
    </div>
  );
}

// ── Animated path hook ──────────────────────────────────────────────────

function useAnimatedPath() {
  const pathRef = useRef<SVGPathElement>(null);
  const [dashOffset, setDashOffset] = useState<number | null>(null);

  useEffect(() => {
    const path = pathRef.current;
    if (!path) return;
    const length = path.getTotalLength();
    setDashOffset(length);
    // Trigger animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setDashOffset(0));
    });
  }, []);

  const style: CSSProperties =
    dashOffset != null
      ? {
          strokeDasharray: dashOffset === 0 ? undefined : pathRef.current?.getTotalLength(),
          strokeDashoffset: dashOffset,
          transition: dashOffset === 0 ? "stroke-dashoffset 1.2s cubic-bezier(0.22, 1, 0.36, 1)" : "none",
        }
      : {};

  return { pathRef, style };
}

// ── HTML tooltip overlay ────────────────────────────────────────────────

function ChartTooltip({
  x,
  y,
  containerRef,
  children,
}: {
  x: number;
  y: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const container = containerRef.current;
  if (!container) return null;

  const rect = container.getBoundingClientRect();
  // Convert SVG coordinates to pixel coordinates
  const svg = container.querySelector("svg");
  if (!svg) return null;

  const viewBox = svg.viewBox.baseVal;
  const pxX = (x / viewBox.width) * rect.width;
  const pxY = (y / viewBox.height) * rect.height;

  // Position tooltip above the point, clamped to container
  const tooltipLeft = Math.max(8, Math.min(pxX, rect.width - 160));
  const tooltipTop = Math.max(0, pxY - 8);

  return (
    <div
      className="absolute z-20 -translate-x-1/2 -translate-y-full pointer-events-none"
      style={{ left: tooltipLeft, top: tooltipTop }}
    >
      <div className="bg-popover/95 backdrop-blur-sm border border-border/60 rounded-lg shadow-lg px-3 py-2 text-xs whitespace-nowrap">
        {children}
      </div>
    </div>
  );
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const gradientId = useId();
  const { pathRef, style: animStyle } = useAnimatedPath();

  const formatter: ValueFormatter =
    format === "currency" ? CURRENCY_FORMAT
      : format === "percent" ? PERCENT_FORMAT
        : NUMBER_FORMAT;

  // Accent color per format type
  const accentColor =
    format === "currency"
      ? (title.toLowerCase().includes("valuation") ? "#dc2626" : "#059669")
      : format === "percent" ? "#7c3aed"
        : "#4f46e5";

  const allPoints = series.flatMap((s) => s.data);
  if (allPoints.length === 0) return null;

  const allDates = allPoints.map((p) => parseDate(p.date));
  const allValues = allPoints.flatMap((p) => [p.value, p.low ?? p.value, p.high ?? p.value]);

  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const minVal = 0;
  const maxVal = Math.max(...allValues) * 1.15;

  const dateRange = maxDate - minDate || 1;
  const valRange = maxVal - minVal || 1;

  const padding = { top: 16, right: 16, bottom: 28, left: 62 };
  const chartWidth = 600;
  const chartW = chartWidth - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const xScale = (d: string) =>
    padding.left + ((parseDate(d) - minDate) / dateRange) * chartW;
  const yScale = (v: number) =>
    padding.top + chartH - ((v - minVal) / valRange) * chartH;

  // Y-axis ticks
  const yTicks: number[] = [];
  const rawTickStep = valRange / 4;
  const tickStep = format === "number" ? Math.ceil(rawTickStep) : rawTickStep;
  for (let i = 0; i <= 4; i++) {
    const raw = minVal + tickStep * i;
    yTicks.push(format === "number" ? Math.round(raw) : raw);
  }

  const years = [...new Set(allPoints.map((p) => p.date.split("-")[0]))].sort();

  // Latest value for header callout
  const primarySeries = series[0];
  const sortedPrimary = [...primarySeries.data].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const latestPoint = sortedPrimary[sortedPrimary.length - 1];
  const latestValue = latestPoint ? formatter(latestPoint.value) : undefined;
  const latestLabel = latestPoint ? formatDate(latestPoint.date) : undefined;

  const ariaLabel = (() => {
    const parts: string[] = [`${title} chart.`];
    for (const s of series) {
      const sorted = [...s.data].sort((a, b) => parseDate(a.date) - parseDate(b.date));
      if (sorted.length < 2) continue;
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      parts.push(
        `${s.label}: ${formatter(first.value)} in ${first.date.slice(0, 4)} to ${formatter(last.value)} in ${last.date.slice(0, 4)}.`
      );
    }
    return parts.join(" ");
  })();

  const color = primarySeries.color ?? accentColor;

  return (
    <ChartCard
      title={title}
      accentColor={accentColor}
      latestValue={latestValue}
      latestLabel={latestLabel}
    >
      <div className="relative" ref={containerRef}>
        <svg
          viewBox={`0 0 ${chartWidth} ${height}`}
          className="w-full"
          style={{ maxHeight: `${height}px` }}
          role="img"
          aria-label={ariaLabel}
        >
          <title>{ariaLabel}</title>

          {/* Gradient definitions */}
          <defs>
            {series.map((s, si) => {
              const c = s.fillColor ?? s.color ?? accentColor;
              return (
                <linearGradient
                  key={si}
                  id={`${gradientId}-fill-${si}`}
                  x1="0" y1="0" x2="0" y2="1"
                >
                  <stop offset="0%" stopColor={c} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={c} stopOpacity={0.01} />
                </linearGradient>
              );
            })}
          </defs>

          {/* Grid lines — fine, subtle */}
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
                  strokeDasharray="2 3"
                  strokeOpacity={0.35}
                  strokeWidth={0.75}
                />
                <text
                  x={x}
                  y={padding.top - 3}
                  textAnchor="middle"
                  fontSize={7.5}
                  className="fill-muted-foreground"
                  fontWeight={500}
                  letterSpacing={0.2}
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

            const seriesColor = s.color ?? accentColor;

            const linePath = sorted
              .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.date)} ${yScale(p.value)}`)
              .join(" ");

            const areaPath = showArea
              ? `${linePath} L ${xScale(sorted[sorted.length - 1].date)} ${yScale(0)} L ${xScale(sorted[0].date)} ${yScale(0)} Z`
              : "";

            return (
              <g key={si}>
                {/* Gradient area fill */}
                {showArea && (
                  <path
                    d={areaPath}
                    fill={`url(#${gradientId}-fill-${si})`}
                  />
                )}

                {/* Main line — animated draw */}
                <path
                  ref={si === 0 ? pathRef : undefined}
                  d={linePath}
                  fill="none"
                  stroke={seriesColor}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={si === 0 ? animStyle : undefined}
                />

                {/* Dots + labels */}
                {sorted.map((p, pi) => {
                  const cx = xScale(p.date);
                  const cy = yScale(p.value);
                  const isHovered =
                    hoveredPoint?.seriesIdx === si && hoveredPoint?.pointIdx === pi;
                  const isLast = pi === sorted.length - 1;

                  return (
                    <g key={pi}>
                      {/* Range whisker */}
                      {p.low != null && p.high != null && (
                        <line
                          x1={cx}
                          y1={yScale(p.low)}
                          x2={cx}
                          y2={yScale(p.high)}
                          stroke={seriesColor}
                          strokeWidth={1.5}
                          strokeOpacity={0.3}
                        />
                      )}

                      {showDots && (
                        <>
                          {/* Hover target */}
                          <circle
                            cx={cx}
                            cy={cy}
                            r={14}
                            fill="transparent"
                            onMouseEnter={() =>
                              setHoveredPoint({ seriesIdx: si, pointIdx: pi, x: cx, y: cy })
                            }
                            onMouseLeave={() => setHoveredPoint(null)}
                          />
                          {/* Outer ring on hover / last point */}
                          {(isHovered || isLast) && (
                            <circle
                              cx={cx}
                              cy={cy}
                              r={isHovered ? 7 : 5.5}
                              fill="none"
                              stroke={seriesColor}
                              strokeWidth={1.5}
                              strokeOpacity={isHovered ? 0.3 : 0.15}
                              className="transition-all duration-200"
                            />
                          )}
                          {/* Inner dot */}
                          <circle
                            cx={cx}
                            cy={cy}
                            r={isHovered ? 4 : isLast ? 3.5 : 2.5}
                            fill={seriesColor}
                            stroke="var(--color-card)"
                            strokeWidth={2}
                            className="transition-all duration-200"
                          />
                        </>
                      )}

                      {/* Point labels */}
                      {showLabels && p.label && (
                        <text
                          x={cx}
                          y={cy - 12}
                          textAnchor="middle"
                          fontSize={7.5}
                          className="fill-muted-foreground"
                          fontWeight={500}
                          letterSpacing={0.2}
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
        </svg>

        {/* HTML tooltip */}
        {hoveredPoint && (() => {
          const s = series[hoveredPoint.seriesIdx];
          const sorted = [...s.data].sort(
            (a, b) => parseDate(a.date) - parseDate(b.date),
          );
          const p = sorted[hoveredPoint.pointIdx];
          if (!p) return null;

          return (
            <ChartTooltip
              x={hoveredPoint.x}
              y={hoveredPoint.y}
              containerRef={containerRef}
            >
              <div className="font-semibold text-popover-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatter(p.value)}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {formatDate(p.date)}
                {p.label && <span className="ml-1.5 opacity-70">({p.label})</span>}
              </div>
            </ChartTooltip>
          );
        })()}
      </div>

      {/* Legend for multi-series */}
      {series.length > 1 && (
        <div className="flex items-center gap-4 mt-2 justify-center">
          {series.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div
                className="w-3 h-[2px] rounded-full"
                style={{ backgroundColor: s.color ?? accentColor }}
              />
              <span className="text-[10px] text-muted-foreground">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}

// ── FundingTimelineChart ─────────────────────────────────────────────────

export interface FundingTimelinePoint {
  date: string;
  raised: number;
  cumulativeRaised: number;
  roundName: string;
  valuation: number | null;
}

export function FundingTimelineChart({
  data,
  title = "Funding Rounds",
  height = 220,
}: {
  data: FundingTimelinePoint[];
  title?: string;
  height?: number;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const gradientId = useId();
  const { pathRef, style: animStyle } = useAnimatedPath();

  if (data.length === 0) return null;

  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  const padding = { top: 20, right: 16, bottom: 28, left: 62 };
  const chartWidth = 600;
  const chartW = chartWidth - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const allDates = sorted.map((p) => parseDate(p.date));
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const dateRange = maxDate - minDate || 1;

  const maxRaised = Math.max(...sorted.map((p) => p.raised));
  const maxCumulative = sorted[sorted.length - 1].cumulativeRaised;
  const barMaxVal = maxRaised * 1.15;
  const lineMaxVal = maxCumulative * 1.15;

  const xScale = (d: string) =>
    padding.left + ((parseDate(d) - minDate) / dateRange) * chartW;
  const yBarScale = (v: number) =>
    padding.top + chartH - (v / barMaxVal) * chartH;
  const yLineScale = (v: number) =>
    padding.top + chartH - (v / lineMaxVal) * chartH;

  const barWidth = Math.min(44, (chartW / sorted.length) * 0.55);

  const barTicks: number[] = [];
  const barTickStep = barMaxVal / 4;
  for (let i = 0; i <= 4; i++) barTicks.push(barTickStep * i);

  const years = [...new Set(sorted.map((p) => p.date.split("-")[0]))].sort();

  const linePath = sorted
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.date)} ${yLineScale(p.cumulativeRaised)}`)
    .join(" ");

  const areaPath = `${linePath} L ${xScale(sorted[sorted.length - 1].date)} ${yLineScale(0)} L ${xScale(sorted[0].date)} ${yLineScale(0)} Z`;

  const latestCumulative = CURRENCY_FORMAT(maxCumulative);

  const ariaLabel = (() => {
    const summaries = sorted.map(
      (p) => `${p.roundName} (${formatDate(p.date)}): ${CURRENCY_FORMAT(p.raised)} raised`,
    );
    return `${title}. ${summaries.join("; ")}. Total: ${latestCumulative}.`;
  })();

  const accentColor = "#2563eb";
  const cumulativeColor = "#059669";

  return (
    <ChartCard
      title={title}
      accentColor={accentColor}
      latestValue={latestCumulative}
      latestLabel="total raised"
    >
      <div className="relative" ref={containerRef}>
        <svg
          viewBox={`0 0 ${chartWidth} ${height}`}
          className="w-full"
          style={{ maxHeight: `${height}px` }}
          role="img"
          aria-label={ariaLabel}
        >
          <title>{ariaLabel}</title>

          <defs>
            <linearGradient id={`${gradientId}-bar`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accentColor} stopOpacity={0.8} />
              <stop offset="100%" stopColor={accentColor} stopOpacity={0.5} />
            </linearGradient>
            <linearGradient id={`${gradientId}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={cumulativeColor} stopOpacity={0.12} />
              <stop offset="100%" stopColor={cumulativeColor} stopOpacity={0.01} />
            </linearGradient>
          </defs>

          {/* Grid */}
          {barTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={padding.left}
                y1={yBarScale(tick)}
                x2={chartWidth - padding.right}
                y2={yBarScale(tick)}
                stroke="currentColor"
                strokeOpacity={i === 0 ? 0.12 : 0.06}
                strokeWidth={i === 0 ? 1 : 0.5}
              />
              <text
                x={padding.left - 8}
                y={yBarScale(tick) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground"
                fontSize={9.5}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {CURRENCY_FORMAT(tick)}
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
                fontSize={9.5}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {year}
              </text>
            );
          })}

          {/* Cumulative area */}
          <path d={areaPath} fill={`url(#${gradientId}-area)`} />

          {/* Cumulative line — animated */}
          <path
            ref={pathRef}
            d={linePath}
            fill="none"
            stroke={cumulativeColor}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="5 3"
            style={animStyle}
          />

          {/* Bars + dots */}
          {sorted.map((p, i) => {
            const cx = xScale(p.date);
            const barTop = yBarScale(p.raised);
            const barH = yBarScale(0) - barTop;
            const isHovered = hoveredIdx === i;

            return (
              <g key={i}>
                <rect
                  x={cx - barWidth / 2}
                  y={barTop}
                  width={barWidth}
                  height={Math.max(0, barH)}
                  fill={`url(#${gradientId}-bar)`}
                  fillOpacity={isHovered ? 1 : 0.75}
                  rx={3}
                  className="transition-all duration-200"
                />

                {/* Round label */}
                <text
                  x={cx}
                  y={barTop - 5}
                  textAnchor="middle"
                  fontSize={7.5}
                  fontWeight={500}
                  className="fill-muted-foreground"
                  letterSpacing={0.2}
                >
                  {p.roundName}
                </text>

                {/* Cumulative dot */}
                <circle
                  cx={cx}
                  cy={yLineScale(p.cumulativeRaised)}
                  r={isHovered ? 4.5 : 3}
                  fill={cumulativeColor}
                  stroke="var(--color-card)"
                  strokeWidth={2}
                  className="transition-all duration-200"
                />

                {/* Hover target */}
                <rect
                  x={cx - barWidth / 2 - 8}
                  y={Math.min(barTop, yLineScale(p.cumulativeRaised)) - 12}
                  width={barWidth + 16}
                  height={yBarScale(0) - Math.min(barTop, yLineScale(p.cumulativeRaised)) + 24}
                  fill="transparent"
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                />
              </g>
            );
          })}
        </svg>

        {/* HTML tooltip */}
        {hoveredIdx != null && (() => {
          const p = sorted[hoveredIdx];
          if (!p) return null;

          return (
            <ChartTooltip
              x={xScale(p.date)}
              y={yBarScale(p.raised) - 12}
              containerRef={containerRef}
            >
              <div className="font-semibold text-popover-foreground">{p.roundName}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{formatDate(p.date)}</div>
              <div className="mt-1.5 space-y-0.5" style={{ fontVariantNumeric: "tabular-nums" }}>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Raised</span>
                  <span className="font-medium">{CURRENCY_FORMAT(p.raised)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-medium">{CURRENCY_FORMAT(p.cumulativeRaised)}</span>
                </div>
                {p.valuation && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Valuation</span>
                    <span className="font-medium">{CURRENCY_FORMAT(p.valuation)}</span>
                  </div>
                )}
              </div>
            </ChartTooltip>
          );
        })()}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 justify-center">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-[3px]" style={{ backgroundColor: accentColor, opacity: 0.75 }} />
          <span className="text-[10px] text-muted-foreground">Per round</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-[2px] rounded-full" style={{ backgroundColor: cumulativeColor }} />
          <span className="text-[10px] text-muted-foreground">Total</span>
        </div>
      </div>
    </ChartCard>
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

  const sorted = [...holders].sort((a, b) => b.stakePercent - a.stakePercent);
  const totalShown = sorted.reduce((s, h) => s + h.stakePercent, 0);
  const otherPercent = Math.max(0, 100 - totalShown);

  const equityAriaLabel = (() => {
    const summaries = sorted.map((h) => {
      const stake =
        h.stakeLow != null && h.stakeHigh != null
          ? `${parseFloat(h.stakeLow.toFixed(1))}–${parseFloat(h.stakeHigh.toFixed(1))}%`
          : `~${h.stakePercent.toFixed(1)}%`;
      const value = valuation != null
        ? ` (${formatCompactCurrency((h.stakePercent / 100) * valuation)})`
        : "";
      return `${h.name} ${stake}${value}`;
    });
    if (otherPercent > 2) summaries.push(`Other ~${otherPercent.toFixed(0)}%`);
    return `${title}: ${summaries.join(", ")}.`;
  })();

  const accentColor = "#d97706";

  return (
    <ChartCard
      title={title}
      accentColor={accentColor}
      latestValue={valuation ? formatCompactCurrency(valuation) : undefined}
      latestLabel={valuation ? "valuation" : undefined}
    >
      {/* Stacked bar */}
      <div
        className="relative h-7 rounded-md overflow-hidden flex mb-4 shadow-inner"
        role="img"
        aria-label={equityAriaLabel}
      >
        {sorted.map((h, i) => (
          <div
            key={i}
            className="relative transition-all duration-200 cursor-default"
            style={{
              width: `${h.stakePercent}%`,
              backgroundColor: h.color,
              opacity: hoveredIdx === null || hoveredIdx === i ? 1 : 0.35,
              filter: hoveredIdx === i ? "brightness(1.1)" : undefined,
            }}
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {h.stakePercent > 9 && (
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white/90 truncate px-1 drop-shadow-sm">
                {h.stakePercent.toFixed(0)}%
              </span>
            )}
          </div>
        ))}
        {otherPercent > 2 && (
          <div
            className="bg-gray-200/80 dark:bg-gray-700/80"
            style={{ width: `${otherPercent}%` }}
          >
            {otherPercent > 9 && (
              <span className="absolute inset-y-0 flex items-center text-[10px] text-muted-foreground px-1.5 font-medium">
                Other
              </span>
            )}
          </div>
        )}
      </div>

      {/* Legend rows */}
      <div className="space-y-0.5">
        {sorted.map((h, i) => {
          const equityValue = valuation ? (h.stakePercent / 100) * valuation : null;
          const isHovered = hoveredIdx === i;

          return (
            <div
              key={i}
              className={`flex items-center gap-2.5 py-1 px-2 rounded-md transition-colors duration-150 ${isHovered ? "bg-muted/60" : ""}`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: h.color }}
              />
              <span className="flex-1 truncate font-medium text-xs text-foreground/80">
                {h.name}
              </span>
              <span
                className="text-xs text-muted-foreground whitespace-nowrap"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {h.stakeLow != null && h.stakeHigh != null
                  ? `${parseFloat(h.stakeLow.toFixed(1))}–${parseFloat(h.stakeHigh.toFixed(1))}%`
                  : `~${h.stakePercent.toFixed(1)}%`}
              </span>
              {equityValue != null && (
                <span
                  className="text-xs font-semibold whitespace-nowrap text-foreground/70"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatCompactCurrency(equityValue)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {valuation && (
        <p className="text-[10px] text-muted-foreground mt-3 px-2">
          Based on {formatCompactCurrency(valuation)} valuation
        </p>
      )}
    </ChartCard>
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
  const gradientId = useId();

  if (stages.length === 0) return null;

  const barHeight = 22;
  const gap = 5;
  const labelWidth = 90;
  const chartWidth = 500;
  const barAreaWidth = chartWidth - labelWidth - 60;

  const categories = [
    { key: "foundersPercent" as const, label: "Founders", color: "#d97706" },
    { key: "employeesPercent" as const, label: "Employees", color: "#4f46e5" },
    { key: "investorsPercent" as const, label: "Investors", color: "#64748b" },
  ];

  const totalHeight = stages.length * (barHeight + gap) + 44;

  const dilutionAriaLabel = (() => {
    const summaries = stages.map((s) =>
      `${s.round}: founders ${s.foundersPercent.toFixed(0)}%, employees ${s.employeesPercent.toFixed(0)}%, investors ${s.investorsPercent.toFixed(0)}%${s.valuation ? ` (${formatCompactCurrency(s.valuation)})` : ""}`
    );
    return `${title}. ${summaries.join("; ")}.`;
  })();

  const accentColor = "#7c3aed";

  return (
    <ChartCard title={title} accentColor={accentColor}>
      <svg
        viewBox={`0 0 ${chartWidth} ${totalHeight}`}
        className="w-full"
        role="img"
        aria-label={dilutionAriaLabel}
      >
        <title>{dilutionAriaLabel}</title>

        <defs>
          {categories.map((cat) => (
            <linearGradient key={cat.key} id={`${gradientId}-${cat.key}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={cat.color} stopOpacity={0.85} />
              <stop offset="100%" stopColor={cat.color} stopOpacity={0.65} />
            </linearGradient>
          ))}
        </defs>

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
              <text
                x={labelWidth - 8}
                y={y + barHeight / 2 + 4}
                textAnchor="end"
                fontSize={10}
                fontWeight={isHovered ? 600 : 400}
                className="fill-foreground"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {stage.round}
              </text>

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
                    fill={`url(#${gradientId}-${cat.key})`}
                    fillOpacity={isHovered ? 1 : 0.75}
                    rx={cat.key === "foundersPercent" && si === 0 ? 3 : 0}
                    className="transition-all duration-200"
                  />
                );
              })}

              {stage.valuation && (
                <text
                  x={labelWidth + barAreaWidth + 6}
                  y={y + barHeight / 2 + 4}
                  fontSize={9}
                  className="fill-muted-foreground"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatCompactCurrency(stage.valuation)}
                </text>
              )}
            </g>
          );
        })}

        {/* Legend */}
        {categories.map((cat, i) => (
          <g key={i} transform={`translate(${labelWidth + i * 100}, ${totalHeight - 14})`}>
            <rect width={10} height={10} fill={cat.color} fillOpacity={0.75} rx={2} />
            <text x={14} y={9} fontSize={9.5} className="fill-muted-foreground" fontWeight={500}>
              {cat.label}
            </text>
          </g>
        ))}
      </svg>
    </ChartCard>
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
  currentEntity,
}: {
  data: MarketShareEntry[];
  title: string;
  subtitle?: string;
  currentEntity?: string;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (data.length === 0) return null;

  const sorted = [...data].sort((a, b) => b.share - a.share);

  // Show current entity's share in header, not the leader's
  const current = currentEntity
    ? sorted.find((e) => e.company === currentEntity)
    : sorted[0];
  const headerEntry = current ?? sorted[0];

  const marketShareAriaLabel = (() => {
    const summaries = sorted.map((e) => `${e.company} ${e.share}%`);
    return `${title}${subtitle ? ` (${subtitle})` : ""}. ${summaries.join(", ")}.`;
  })();

  const accentColor = headerEntry?.color ?? "#6366f1";

  return (
    <ChartCard
      title={title}
      accentColor={accentColor}
      latestValue={headerEntry ? `${headerEntry.share}%` : undefined}
      latestLabel={headerEntry ? headerEntry.company : undefined}
    >
      {subtitle && (
        <p className="text-[10px] text-muted-foreground -mt-1 mb-2.5">{subtitle}</p>
      )}

      <div className="space-y-1.5" role="img" aria-label={marketShareAriaLabel}>
        {sorted.map((entry, i) => {
          const isHovered = hoveredIdx === i;
          const isLeader = i === 0;

          return (
            <div
              key={i}
              className={`flex items-center gap-2.5 py-0.5 px-1.5 rounded-md transition-colors duration-150 ${isHovered ? "bg-muted/50" : ""}`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <span className="text-xs w-[90px] truncate font-medium text-foreground/80">
                {entry.company}
              </span>
              <div className="flex-1 h-[18px] bg-muted/50 rounded-[4px] relative overflow-hidden">
                <div
                  className="h-full rounded-[4px] transition-all duration-300"
                  style={{
                    width: `${entry.share}%`,
                    backgroundColor: entry.color,
                    opacity: isHovered ? 0.9 : isLeader ? 0.75 : 0.55,
                  }}
                />
              </div>
              <span
                className={`text-xs whitespace-nowrap w-[38px] text-right ${isLeader ? "font-bold" : "font-medium"}`}
                style={{
                  fontVariantNumeric: "tabular-nums",
                  color: isLeader ? accentColor : undefined,
                }}
              >
                {entry.share}%
              </span>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}
