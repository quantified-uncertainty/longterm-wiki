"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

interface FactMetricDef {
  id: string;
  label: string;
  unit: string;
  category: string;
  description?: string;
}

interface FactEntry {
  key: string;
  entity: string;
  factId: string;
  value?: string;
  numeric?: number;
  low?: number;
  high?: number;
  asOf?: string;
  source?: string;
  note?: string;
  computed?: boolean;
  compute?: string;
  metric?: string;
}

type ViewMode = "entity" | "metric" | "timeseries";

export function FactDashboard({
  facts,
  entityHrefs,
  factMetrics,
}: {
  facts: FactEntry[];
  entityHrefs: Record<string, string>;
  factMetrics: Record<string, FactMetricDef>;
}) {
  const [filter, setFilter] = useState("");
  const [showComputed, setShowComputed] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("entity");

  const filtered = useMemo(() => facts.filter((f) => {
    if (!showComputed && f.computed) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      f.entity.toLowerCase().includes(q) ||
      f.factId.toLowerCase().includes(q) ||
      (f.value || "").toLowerCase().includes(q) ||
      (f.metric || "").toLowerCase().includes(q)
    );
  }), [facts, filter, showComputed]);

  // Stats
  const metricCount = useMemo(() => {
    const metrics = new Set(filtered.filter(f => f.metric).map(f => f.metric));
    return metrics.size;
  }, [filtered]);

  const entityCount = useMemo(() => {
    return new Set(filtered.map(f => f.entity)).size;
  }, [filtered]);

  return (
    <div>
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Filter by entity, fact ID, or metric..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-border rounded-md bg-background"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
          <input
            type="checkbox"
            checked={showComputed}
            onChange={(e) => setShowComputed(e.target.checked)}
            className="rounded"
          />
          Show computed
        </label>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <div className="flex rounded-md border border-border overflow-hidden">
          {(["entity", "metric", "timeseries"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {mode === "entity" ? "By Entity" : mode === "metric" ? "By Metric" : "Timeseries"}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground">
          {filtered.length} facts | {entityCount} entities | {metricCount} metrics
        </span>
      </div>

      {viewMode === "entity" && (
        <EntityView facts={filtered} entityHrefs={entityHrefs} factMetrics={factMetrics} />
      )}
      {viewMode === "metric" && (
        <MetricView facts={filtered} entityHrefs={entityHrefs} factMetrics={factMetrics} />
      )}
      {viewMode === "timeseries" && (
        <TimeseriesView facts={filtered} entityHrefs={entityHrefs} factMetrics={factMetrics} />
      )}
    </div>
  );
}

// === Entity View (original, enhanced with metric badges) ===

function EntityView({
  facts,
  entityHrefs,
  factMetrics,
}: {
  facts: FactEntry[];
  entityHrefs: Record<string, string>;
  factMetrics: Record<string, FactMetricDef>;
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, FactEntry[]>();
    for (const fact of facts) {
      const group = map.get(fact.entity) || [];
      group.push(fact);
      map.set(fact.entity, group);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [facts]);

  return (
    <div className="space-y-6">
      {grouped.map(([entity, entityFacts]) => (
        <div key={entity}>
          <h3 className="text-base font-semibold mb-2 text-foreground">
            <Link href={entityHrefs[entity] || `/wiki/${entity}`} className="hover:underline">
              {entity}
            </Link>
          </h3>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-1 pr-4 font-medium">Fact ID</th>
                <th className="pb-1 pr-4 font-medium">Metric</th>
                <th className="pb-1 pr-4 font-medium">Value</th>
                <th className="pb-1 pr-4 font-medium">As Of</th>
                <th className="pb-1 pr-4 font-medium">Source</th>
                <th className="pb-1 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {entityFacts.map((fact) => (
                <tr key={fact.key} className="border-t border-border">
                  <td className="py-1.5 pr-4 font-mono text-xs">{fact.factId}</td>
                  <td className="py-1.5 pr-4">
                    <MetricBadge metricId={fact.metric} factMetrics={factMetrics} />
                  </td>
                  <td className="py-1.5 pr-4">
                    <ValueDisplay fact={fact} />
                  </td>
                  <td className="py-1.5 pr-4 text-muted-foreground">{fact.asOf || "—"}</td>
                  <td className="py-1.5 pr-4 text-muted-foreground text-xs max-w-[200px] truncate">
                    {fact.source || "—"}
                  </td>
                  <td className="py-1.5">
                    {fact.computed ? (
                      <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded dark:bg-blue-900 dark:text-blue-300">
                        computed
                      </span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded dark:bg-green-900 dark:text-green-300">
                        manual
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// === Metric View (grouped by metric) ===

function MetricView({
  facts,
  entityHrefs,
  factMetrics,
}: {
  facts: FactEntry[];
  entityHrefs: Record<string, string>;
  factMetrics: Record<string, FactMetricDef>;
}) {
  const { metricGroups, untagged } = useMemo(() => {
    const byMetric = new Map<string, FactEntry[]>();
    const noMetric: FactEntry[] = [];
    for (const fact of facts) {
      if (fact.metric) {
        const group = byMetric.get(fact.metric) || [];
        group.push(fact);
        byMetric.set(fact.metric, group);
      } else {
        noMetric.push(fact);
      }
    }
    // Sort within each metric by entity then asOf
    for (const group of byMetric.values()) {
      group.sort((a, b) => a.entity.localeCompare(b.entity) || (a.asOf || "").localeCompare(b.asOf || ""));
    }
    // Sort metrics by category then label
    const sorted = [...byMetric.entries()].sort((a, b) => {
      const catA = factMetrics[a[0]]?.category || "zzz";
      const catB = factMetrics[b[0]]?.category || "zzz";
      if (catA !== catB) return catA.localeCompare(catB);
      return a[0].localeCompare(b[0]);
    });
    return { metricGroups: sorted, untagged: noMetric };
  }, [facts, factMetrics]);

  // Group by category
  const byCategory = useMemo(() => {
    const cats = new Map<string, [string, FactEntry[]][]>();
    for (const [metricId, entries] of metricGroups) {
      const cat = factMetrics[metricId]?.category || "uncategorized";
      const group = cats.get(cat) || [];
      group.push([metricId, entries]);
      cats.set(cat, group);
    }
    return [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [metricGroups, factMetrics]);

  return (
    <div className="space-y-8">
      {byCategory.map(([category, metrics]) => (
        <div key={category}>
          <h2 className="text-lg font-bold mb-4 capitalize text-foreground border-b border-border pb-1">
            {category}
          </h2>
          <div className="space-y-6">
            {metrics.map(([metricId, entries]) => {
              const def = factMetrics[metricId];
              const entities = [...new Set(entries.map(e => e.entity))];
              return (
                <div key={metricId} className="pl-2 border-l-2 border-primary/20">
                  <div className="flex items-baseline gap-2 mb-1">
                    <h3 className="text-base font-semibold text-foreground">
                      {def?.label || metricId}
                    </h3>
                    <span className="text-xs text-muted-foreground font-mono">{metricId}</span>
                    {def?.unit && (
                      <span className="text-xs px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
                        {def.unit}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {entries.length} observations across {entities.length} {entities.length === 1 ? "entity" : "entities"}
                    </span>
                  </div>
                  {def?.description && (
                    <p className="text-xs text-muted-foreground mb-2">{def.description}</p>
                  )}
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="pb-1 pr-4 font-medium">Entity</th>
                        <th className="pb-1 pr-4 font-medium">Fact ID</th>
                        <th className="pb-1 pr-4 font-medium">Value</th>
                        <th className="pb-1 pr-4 font-medium">As Of</th>
                        <th className="pb-1 font-medium">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((fact) => (
                        <tr key={fact.key} className="border-t border-border">
                          <td className="py-1.5 pr-4">
                            <Link href={entityHrefs[fact.entity] || `/wiki/${fact.entity}`} className="hover:underline text-primary">
                              {fact.entity}
                            </Link>
                          </td>
                          <td className="py-1.5 pr-4 font-mono text-xs">{fact.factId}</td>
                          <td className="py-1.5 pr-4">
                            <ValueDisplay fact={fact} />
                          </td>
                          <td className="py-1.5 pr-4 text-muted-foreground">{fact.asOf || "—"}</td>
                          <td className="py-1.5 text-muted-foreground text-xs max-w-[300px] truncate">
                            {fact.note || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {untagged.length > 0 && (
        <div>
          <h2 className="text-lg font-bold mb-4 text-muted-foreground border-b border-border pb-1">
            Untagged (no metric)
          </h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-1 pr-4 font-medium">Entity</th>
                <th className="pb-1 pr-4 font-medium">Fact ID</th>
                <th className="pb-1 pr-4 font-medium">Value</th>
                <th className="pb-1 pr-4 font-medium">As Of</th>
                <th className="pb-1 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {untagged.map((fact) => (
                <tr key={fact.key} className="border-t border-border">
                  <td className="py-1.5 pr-4">
                    <Link href={entityHrefs[fact.entity] || `/wiki/${fact.entity}`} className="hover:underline text-primary">
                      {fact.entity}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-4 font-mono text-xs">{fact.factId}</td>
                  <td className="py-1.5 pr-4">{fact.value || "—"}</td>
                  <td className="py-1.5 pr-4 text-muted-foreground">{fact.asOf || "—"}</td>
                  <td className="py-1.5 text-muted-foreground text-xs">{fact.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// === Timeseries View (visual timeline per metric+entity) ===

function TimeseriesView({
  facts,
  entityHrefs,
  factMetrics,
}: {
  facts: FactEntry[];
  entityHrefs: Record<string, string>;
  factMetrics: Record<string, FactMetricDef>;
}) {
  // Build timeseries: group by metric+entity, sort by date
  const series = useMemo(() => {
    const map = new Map<string, FactEntry[]>();
    for (const fact of facts) {
      if (!fact.metric || !fact.asOf) continue;
      const seriesKey = `${fact.metric}:${fact.entity}`;
      const group = map.get(seriesKey) || [];
      group.push(fact);
      map.set(seriesKey, group);
    }
    // Sort chronologically within each series
    for (const group of map.values()) {
      group.sort((a, b) => (a.asOf || "").localeCompare(b.asOf || ""));
    }
    // Only show series with 2+ points (that's what makes a timeseries interesting)
    const multiPoint = [...map.entries()]
      .filter(([, entries]) => entries.length >= 2)
      .sort((a, b) => {
        // Sort by metric then entity
        const [metricA] = a[0].split(":");
        const [metricB] = b[0].split(":");
        if (metricA !== metricB) return metricA.localeCompare(metricB);
        return a[0].localeCompare(b[0]);
      });
    return multiPoint;
  }, [facts]);

  if (series.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No metrics with multiple time observations found. Facts need both a <code>metric</code> and <code>asOf</code> field,
        and at least 2 observations of the same metric for the same entity.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {series.map(([seriesKey, entries]) => {
        const [metricId, entityId] = seriesKey.split(":");
        const def = factMetrics[metricId];
        const hasNumeric = entries.some(e => e.numeric != null || e.low != null);

        return (
          <div key={seriesKey} className="border border-border rounded-lg p-4">
            <div className="flex items-baseline gap-2 mb-3">
              <h3 className="text-base font-semibold text-foreground">
                {def?.label || metricId}
              </h3>
              <span className="text-sm text-muted-foreground">—</span>
              <Link href={entityHrefs[entityId] || `/wiki/${entityId}`} className="text-sm text-primary hover:underline">
                {entityId}
              </Link>
              {def?.unit && (
                <span className="text-xs px-1.5 py-0.5 bg-muted rounded text-muted-foreground ml-auto">
                  {def.unit}
                </span>
              )}
            </div>

            {/* Mini bar chart for numeric timeseries */}
            {hasNumeric && (
              <MiniBarChart entries={entries} unit={def?.unit} />
            )}

            {/* Data table */}
            <table className="w-full text-sm border-collapse mt-2">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-1 pr-4 font-medium">Date</th>
                  <th className="pb-1 pr-4 font-medium">Value</th>
                  {entries.some(e => e.low != null) && (
                    <th className="pb-1 pr-4 font-medium">Range</th>
                  )}
                  <th className="pb-1 pr-4 font-medium">Fact ID</th>
                  <th className="pb-1 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((fact) => (
                  <tr key={fact.key} className="border-t border-border">
                    <td className="py-1.5 pr-4 font-mono text-xs">{fact.asOf}</td>
                    <td className="py-1.5 pr-4">
                      <ValueDisplay fact={fact} />
                    </td>
                    {entries.some(e => e.low != null) && (
                      <td className="py-1.5 pr-4 text-muted-foreground text-xs">
                        {fact.low != null && fact.high != null
                          ? `${formatCompact(fact.low)} – ${formatCompact(fact.high)}`
                          : "—"}
                      </td>
                    )}
                    <td className="py-1.5 pr-4 font-mono text-xs text-muted-foreground">{fact.factId}</td>
                    <td className="py-1.5 text-muted-foreground text-xs max-w-[300px] truncate">
                      {fact.note || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// === Shared components ===

function MetricBadge({
  metricId,
  factMetrics,
}: {
  metricId?: string;
  factMetrics: Record<string, FactMetricDef>;
}) {
  if (!metricId) return <span className="text-muted-foreground text-xs">—</span>;
  const def = factMetrics[metricId];
  return (
    <span
      className="text-xs px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded dark:bg-violet-900 dark:text-violet-300"
      title={def?.description || metricId}
    >
      {def?.label || metricId}
    </span>
  );
}

function ValueDisplay({ fact }: { fact: FactEntry }) {
  const hasRange = fact.low != null && fact.high != null;
  return (
    <span>
      {fact.value || (fact.numeric !== undefined ? String(fact.numeric) : "—")}
      {hasRange && !fact.value && (
        <span className="text-muted-foreground text-xs ml-1">
          ({formatCompact(fact.low!)} – {formatCompact(fact.high!)})
        </span>
      )}
    </span>
  );
}

/** Minimal horizontal bar chart for numeric timeseries */
function MiniBarChart({ entries, unit }: { entries: FactEntry[]; unit?: string }) {
  // Get numeric values, using midpoint of range if no exact numeric
  const points = entries.map(e => ({
    asOf: e.asOf || "",
    value: e.numeric ?? (e.low != null && e.high != null ? (e.low + e.high) / 2 : null),
    isRange: e.low != null && e.high != null,
    low: e.low,
    high: e.high,
  })).filter(p => p.value != null);

  if (points.length < 2) return null;

  const maxVal = Math.max(...points.map(p => p.isRange && p.high ? p.high : p.value!));
  if (maxVal === 0) return null;

  return (
    <div className="space-y-1 mb-3">
      {points.map((point, i) => {
        const pct = (point.value! / maxVal) * 100;
        const lowPct = point.isRange && point.low != null ? (point.low / maxVal) * 100 : pct;
        const highPct = point.isRange && point.high != null ? (point.high / maxVal) * 100 : pct;
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-[70px] text-right font-mono shrink-0">
              {point.asOf}
            </span>
            <div className="flex-1 h-5 bg-muted rounded-sm relative overflow-hidden">
              {point.isRange ? (
                <>
                  {/* Range bar */}
                  <div
                    className="absolute top-0 h-full bg-primary/20 rounded-sm"
                    style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }}
                  />
                  {/* Midpoint */}
                  <div
                    className="absolute top-0 h-full bg-primary/60 rounded-sm"
                    style={{ width: `${pct}%`, maxWidth: "2px", left: `${pct}%` }}
                  />
                </>
              ) : (
                <div
                  className="h-full bg-primary/40 rounded-sm transition-all"
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>
            <span className="text-xs text-muted-foreground w-[90px] shrink-0">
              {formatCompactWithUnit(point.value!, unit)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatCompact(n: number): string {
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (Math.abs(n) < 1 && n !== 0) return `${(n * 100).toFixed(0)}%`;
  return String(n);
}

function formatCompactWithUnit(n: number, unit?: string): string {
  if (unit === "USD") {
    if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n}`;
  }
  if (unit === "percent") return `${n}%`;
  return formatCompact(n);
}
