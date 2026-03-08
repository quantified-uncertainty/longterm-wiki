/**
 * KBCompareTable — Cross-entity comparison table for KB data.
 *
 * Server component that renders a table comparing a single KB property across
 * multiple entities side-by-side. Supports both latest-value and full time-series
 * modes, determined automatically based on the property's temporal flag.
 *
 * For time-series properties (revenue, valuation, headcount), columns are years
 * derived from the union of all asOf dates across the entities shown.
 * For point-in-time properties (founded-date, headquarters), a single value
 * column is rendered with an optional "as of" date.
 *
 * Usage in MDX:
 *   <KBCompareTable property="revenue" />
 *   <KBCompareTable property="headcount" entities={["anthropic", "openai", "deepmind"]} />
 *   <KBCompareTable property="valuation" title="AI Lab Valuations" />
 *   <KBCompareTable property="revenue" mode="latest" />
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getKBAllFactsByProperty,
  getKBFactsByProperty,
  getKBEntities,
  getKBProperty,
  getKBEntity,
} from "@data/kb";
import type { Fact, Property } from "@longterm-wiki/kb";
import { formatKBDate, formatKBFactValue, titleCase } from "./format";
import { KBRefLink } from "./KBRefLink";

// ── Types ────────────────────────────────────────────────────────────────────

type CompareMode = "timeseries" | "latest" | "auto";

interface KBCompareTableProps {
  /** KB property ID to compare across entities (e.g., "revenue", "headcount") */
  property: string;
  /**
   * KB entity IDs to include. If omitted, shows all entities that have at
   * least one fact for the given property.
   */
  entities?: string[];
  /** Optional heading override (defaults to property name) */
  title?: string;
  /**
   * Display mode:
   * - "auto"       — time-series if the property is temporal AND has multiple dated facts, else latest
   * - "timeseries" — always show all dated values as columns by year
   * - "latest"     — always show only the most recent value per entity
   *
   * Defaults to "auto".
   */
  mode?: CompareMode;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a 4-digit year string from an asOf date like "2024-06" or "2024". */
function extractYear(asOf: string): string {
  return asOf.slice(0, 4);
}

/**
 * Given a fact, render its value as a React node.
 * Ref/refs values get KBRefLink; everything else gets the text formatter.
 */
function FactCellValue({
  fact,
  property,
}: {
  fact: Fact | undefined;
  property: Property | undefined;
}) {
  if (!fact) {
    return <span className="text-muted-foreground">{"\u2014"}</span>;
  }

  const v = fact.value;

  if (v.type === "ref") {
    return <KBRefLink id={v.value} />;
  }

  if (v.type === "refs") {
    return (
      <span className="inline-flex flex-wrap gap-1">
        {v.value.map((refId, i) => (
          <span key={`${refId}-${i}`}>
            <KBRefLink id={refId} />
            {i < v.value.length - 1 && (
              <span className="text-muted-foreground">,</span>
            )}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className="tabular-nums">
      {formatKBFactValue(fact, property?.unit, property?.display)}
    </span>
  );
}

// ── Time-series layout ────────────────────────────────────────────────────────

/**
 * Renders a table where rows = entities and columns = years.
 * For each (entity, year) cell we pick the fact with the latest asOf within
 * that year (handles multiple data points per year).
 */
function TimeSeriesTable({
  entityRows,
  years,
  property,
}: {
  entityRows: Array<{ entityId: string; name: string; facts: Fact[] }>;
  years: string[];
  property: Property | undefined;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="min-w-[120px]">
            Entity
          </TableHead>
          {years.map((year) => (
            <TableHead key={year} scope="col" className="text-right tabular-nums">
              {year}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {entityRows.map(({ entityId, name, facts }) => {
          // For each year column, pick the latest fact within that year
          const factsByYear = new Map<string, Fact>();
          for (const fact of facts) {
            if (!fact.asOf) continue;
            const year = extractYear(fact.asOf);
            const existing = factsByYear.get(year);
            if (!existing || fact.asOf > existing.asOf!) {
              factsByYear.set(year, fact);
            }
          }

          return (
            <TableRow key={entityId}>
              <TableCell className="font-medium">
                <KBRefLink id={entityId} label={name} />
              </TableCell>
              {years.map((year) => {
                const fact = factsByYear.get(year);
                return (
                  <TableCell key={year} className="text-right">
                    <FactCellValue fact={fact} property={property} />
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ── Latest-value layout ───────────────────────────────────────────────────────

/**
 * Renders a simple two-column table: entity | value (with optional asOf date).
 */
function LatestValueTable({
  entityRows,
  property,
}: {
  entityRows: Array<{ entityId: string; name: string; fact: Fact | null }>;
  property: Property | undefined;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Entity</TableHead>
          <TableHead scope="col" className="text-right">
            {property?.name ?? "Value"}
          </TableHead>
          <TableHead scope="col">As Of</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entityRows.map(({ entityId, name, fact }) => (
          <TableRow key={entityId}>
            <TableCell className="font-medium">
              <KBRefLink id={entityId} label={name} />
            </TableCell>
            <TableCell className="text-right font-medium">
              {fact ? (
                <FactCellValue fact={fact} property={property} />
              ) : (
                <span className="text-muted-foreground text-xs">No data</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">
              {fact ? formatKBDate(fact.asOf) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function KBCompareTable({
  property: propertyId,
  entities: entityFilter,
  title,
  mode = "auto",
}: KBCompareTableProps) {
  const prop = getKBProperty(propertyId);
  const heading = title ?? prop?.name ?? titleCase(propertyId);

  // Resolve which entities to include
  const allEntities = getKBEntities();

  // Determine which entity IDs are in scope
  const scopeIds: string[] | undefined = entityFilter;

  // Get all facts for this property, scoped to the requested entities
  const allFactsMap = getKBAllFactsByProperty(propertyId, scopeIds);

  // If no entity filter was given, derive the list from entities that have facts.
  // If a filter was given, keep ALL requested IDs — missing ones render as "No data"
  // so the comparison is not silently truncated.
  const entityIds = scopeIds ?? Array.from(allFactsMap.keys());

  if (entityIds.length === 0) {
    return (
      <Card className="my-6">
        <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
          <CardTitle className="text-base">{heading}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No data available.</p>
        </CardContent>
      </Card>
    );
  }

  // Resolve entity display names (prefer KB name, fall back to entityId)
  function getEntityName(entityId: string): string {
    const kbEntity = getKBEntity(entityId);
    if (kbEntity) return kbEntity.name;
    const wikiEntity = allEntities.find((e) => e.id === entityId);
    return wikiEntity?.name ?? entityId;
  }

  // Decide render mode
  const totalFactCount = Array.from(allFactsMap.values()).reduce(
    (sum, facts) => sum + facts.length,
    0,
  );
  const hasDatedFacts = Array.from(allFactsMap.values()).some((facts) =>
    facts.some((f) => f.asOf !== undefined),
  );
  const isTemporalProperty = prop?.temporal === true;

  const resolvedMode: "timeseries" | "latest" =
    mode === "timeseries"
      ? "timeseries"
      : mode === "latest"
        ? "latest"
        : isTemporalProperty && hasDatedFacts && totalFactCount > entityIds.length
          ? "timeseries"
          : "latest";

  const totalEntityCount = entityIds.length;

  // ── Time-series mode ────────────────────────────────────────────────────────
  if (resolvedMode === "timeseries") {
    // Collect all years present across all entities, sorted ascending
    const yearSet = new Set<string>();
    for (const facts of allFactsMap.values()) {
      for (const fact of facts) {
        if (fact.asOf) yearSet.add(extractYear(fact.asOf));
      }
    }
    const years = Array.from(yearSet).sort();

    // Sort entities by their most recent value descending (for numeric properties)
    const entityRows = entityIds
      .map((entityId) => ({
        entityId,
        name: getEntityName(entityId),
        facts: allFactsMap.get(entityId) ?? [],
      }))
      .sort((a, b) => {
        // Sort by entity name if no numeric sorting possible
        const latestA = a.facts[0];
        const latestB = b.facts[0];
        if (
          latestA?.value.type === "number" &&
          latestB?.value.type === "number"
        ) {
          return latestB.value.value - latestA.value.value;
        }
        return a.name.localeCompare(b.name);
      });

    return (
      <Card className="my-6">
        <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
          <CardTitle className="text-base">{heading}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {totalEntityCount}{" "}
            {totalEntityCount === 1 ? "entity" : "entities"}
            {" \u00b7 "}
            {years.length} {years.length === 1 ? "year" : "years"}
          </span>
        </CardHeader>
        <CardContent className="px-0 pt-0 overflow-x-auto">
          <TimeSeriesTable
            entityRows={entityRows}
            years={years}
            property={prop}
          />
        </CardContent>
      </Card>
    );
  }

  // ── Latest-value mode ───────────────────────────────────────────────────────
  // Derive latest fact per entity from allFactsMap (already sorted most-recent-first).
  // Entities with no data are kept as null so the table shows "No data" rather than
  // silently omitting them (which would make the comparison look more complete than it is).
  const entityRows = entityIds
    .map((entityId) => ({
      entityId,
      name: getEntityName(entityId),
      fact: allFactsMap.get(entityId)?.[0] ?? null,
    }))
    .sort((a, b) => {
      if (a.fact?.value.type === "number" && b.fact?.value.type === "number") {
        return b.fact.value.value - a.fact.value.value;
      }
      // Entities with data sort before entities without
      if (a.fact && !b.fact) return -1;
      if (!a.fact && b.fact) return 1;
      return a.name.localeCompare(b.name);
    });

  if (entityRows.length === 0) {
    return (
      <Card className="my-6">
        <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
          <CardTitle className="text-base">{heading}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No data available.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="my-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
        <CardTitle className="text-base">{heading}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {entityRows.length}{" "}
          {entityRows.length === 1 ? "entity" : "entities"}
        </span>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <LatestValueTable entityRows={entityRows} property={prop} />
      </CardContent>
    </Card>
  );
}
