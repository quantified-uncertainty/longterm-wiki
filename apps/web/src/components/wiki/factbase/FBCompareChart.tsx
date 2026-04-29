/**
 * FBCompareChart — Cross-entity comparison line chart for factbase data.
 *
 * Server component that fetches FactBase time-series data for a property across
 * multiple entities, then renders a client sub-component with multi-line SVG chart.
 * Visually similar to the org-page TimeSeriesChart but designed for comparison:
 * multiple colored lines, prominent legend, no area fill.
 *
 * Usage in MDX:
 *   <FBCompareChart property="revenue" />
 *   <FBCompareChart property="headcount" entities={["anthropic", "openai", "deepmind"]} />
 *   <FBCompareChart property="revenue" title="AI Lab Revenue Race" format="currency" />
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getKBAllFactsByProperty,
  getKBProperty,
  getKBEntity,
  getKBEntities,
} from "@data/factbase";
import { getPropertyLabel } from "@/components/factbase/entity-detail-shared";
import { FBCompareChartClient, type ChartSeries } from "./FBCompareChartClient";

// ── Color palette for multi-entity comparison ────────────────────────

const PALETTE = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#6366f1", // indigo
];

// ── Format auto-detection ────────────────────────────────────────────

type ChartFormat = "currency" | "number" | "percent";

function detectFormat(unit?: string): ChartFormat {
  if (!unit) return "number";
  const lower = unit.toLowerCase();
  if (lower === "usd" || lower === "eur" || lower === "gbp" || lower.includes("dollar")) {
    return "currency";
  }
  if (lower === "percent" || lower === "%" || lower.includes("percentage")) {
    return "percent";
  }
  return "number";
}

// ── Props ────────────────────────────────────────────────────────────

interface FBCompareChartProps {
  /** FactBase property ID to compare across entities (e.g., "revenue", "headcount") */
  property: string;
  /**
   * Entity slugs to include. If omitted, shows all entities that have
   * time-series data (2+ data points) for the given property.
   */
  entities?: string[];
  /** Optional heading override (defaults to property name) */
  title?: string;
  /** Value format — auto-detected from property unit if not specified */
  format?: ChartFormat;
}

// ── Main component (server) ──────────────────────────────────────────

export function FBCompareChart({
  property: propertyId,
  entities: entityFilter,
  title,
  format,
}: FBCompareChartProps) {
  const prop = getKBProperty(propertyId);
  const heading = title ?? getPropertyLabel(prop, propertyId);
  const resolvedFormat = format ?? detectFormat(prop?.unit);

  // Get all facts for this property, scoped to the requested entities
  const allFactsMap = getKBAllFactsByProperty(propertyId, entityFilter);

  // Resolve entity display names
  const allEntities = getKBEntities();
  function getEntityName(entityId: string): string {
    const kbEntity = getKBEntity(entityId);
    if (kbEntity) return kbEntity.name;
    const wikiEntity = allEntities.find((e) => e.id === entityId);
    return wikiEntity?.name ?? entityId;
  }

  // Build chart series: one per entity, only include entities with 2+ data points
  const seriesList: ChartSeries[] = [];
  const entityIds = entityFilter ?? Array.from(allFactsMap.keys());
  let colorIdx = 0;

  for (const entityId of entityIds) {
    const facts = allFactsMap.get(entityId) ?? [];
    // Extract numeric time-series points with asOf dates
    const points: Array<{ date: string; value: number }> = [];
    for (const fact of facts) {
      if (!fact.asOf) continue;
      if (fact.value.type !== "number") continue;
      points.push({ date: fact.asOf, value: fact.value.value });
    }

    // Sort chronologically
    points.sort((a, b) => a.date.localeCompare(b.date));

    // Only include if 2+ points (a single point cannot form a line)
    if (points.length < 2) continue;

    seriesList.push({
      entityName: getEntityName(entityId),
      color: PALETTE[colorIdx % PALETTE.length],
      points,
    });
    colorIdx++;
  }

  if (seriesList.length === 0) {
    return (
      <Card className="my-6">
        <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
          <CardTitle className="text-base">{heading}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No time-series data available for comparison. Entities need 2+ data
            points each.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Sort series by latest value descending so the legend order is meaningful
  seriesList.sort((a, b) => {
    const lastA = a.points[a.points.length - 1]?.value ?? 0;
    const lastB = b.points[b.points.length - 1]?.value ?? 0;
    return lastB - lastA;
  });

  return (
    <div className="my-6 rounded-xl bg-card/80 border border-border/40 shadow-[0_1px_3px_0_rgba(0,0,0,0.03)]">
      <div className="px-5 pt-4 pb-1">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground/90">
          {heading}
        </h3>
      </div>
      <div className="px-5 pb-5">
        <FBCompareChartClient series={seriesList} format={resolvedFormat} />
      </div>
    </div>
  );
}
