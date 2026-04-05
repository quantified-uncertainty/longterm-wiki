/**
 * Shared fact display components for entity profile pages (organizations, people).
 * Extracts duplicated logic from org and person detail pages.
 */
import Link from "next/link";
import {
  getKBProperty,
  getKBEntity,
  getKBEntitySlug,
  isFactExpired,
} from "@/data/factbase";
import { getEntityHref } from "@/data/entity-nav";
import {
  formatKBFactValue,
  titleCase,
} from "@/components/wiki/factbase/format";
import type { Fact, Property } from "@longterm-wiki/factbase";

// ── Constants ────────────────────────────────────────────────────────

export const FACT_CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "financial", label: "Financial", order: 0 },
  { id: "product", label: "Products & Usage", order: 1 },
  { id: "organization", label: "Organization", order: 2 },
  { id: "safety", label: "Safety & Research", order: 3 },
  { id: "people", label: "People", order: 4 },
  { id: "other", label: "Other", order: 99 },
];

// ── Helpers ──────────────────────────────────────────────────────────

/** Group facts by property, taking only the latest non-expired per property. */
export function getLatestFactsByProperty(facts: Fact[]): Map<string, Fact> {
  const latest = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    if (isFactExpired(fact)) continue;
    if (!latest.has(fact.propertyId)) {
      latest.set(fact.propertyId, fact);
    }
  }
  return latest;
}

/** Group property IDs by category, returning sorted categories. */
export function groupByCategory(
  propertyIds: string[],
): Array<{ category: string; label: string; props: string[] }> {
  const groups = new Map<string, string[]>();
  for (const propId of propertyIds) {
    const prop = getKBProperty(propId);
    const category = prop?.category ?? "other";
    const list = groups.get(category) ?? [];
    list.push(propId);
    groups.set(category, list);
  }

  const catMap = new Map(FACT_CATEGORIES.map((c) => [c.id, c]));
  return [...groups.entries()]
    .map(([catId, props]) => ({
      category: catId,
      label: catMap.get(catId)?.label ?? titleCase(catId),
      order: catMap.get(catId)?.order ?? 99,
      props,
    }))
    .sort((a, b) => a.order - b.order);
}

// ── Components ───────────────────────────────────────────────────────

/** Resolve a FactBase ref to its canonical directory URL. */
function resolveRefHref(refId: string): string {
  const refSlug = getKBEntitySlug(refId);
  if (refSlug) return getEntityHref(refSlug);
  return `/factbase/entity/${refId}`;
}

/** Render a fact value, resolving ref/refs to entity name links. */
export function FactValueDisplay({ fact, property }: { fact: Fact; property?: Property }) {
  const v = fact.value;
  if (v.type === "ref") {
    const refEntity = getKBEntity(v.value);
    if (refEntity) {
      return (
        <Link href={resolveRefHref(v.value)} className="text-primary hover:underline">
          {refEntity.name}
        </Link>
      );
    }
    return <span>{v.value}</span>;
  }
  if (v.type === "refs") {
    return (
      <span>
        {v.value.map((refId, i) => {
          const refEntity = getKBEntity(refId);
          if (refEntity) {
            return (
              <span key={refId}>
                {i > 0 && ", "}
                <Link href={resolveRefHref(refId)} className="text-primary hover:underline">
                  {refEntity.name}
                </Link>
              </span>
            );
          }
          return (
            <span key={refId}>
              {i > 0 && ", "}
              {refId}
            </span>
          );
        })}
      </span>
    );
  }
  // formatKBFactValue always returns a string, but guard against edge cases
  // where an object might leak through (which renders as "[object Object]").
  const formatted = formatKBFactValue(fact, property?.unit, property?.display);
  const safeFormatted = typeof formatted === "string" ? formatted : JSON.stringify(formatted);
  return <span>{safeFormatted}</span>;
}

/** A single fact row with dot-leader connecting label to value. */
function FactRow({
  propId,
  fact,
}: {
  propId: string;
  fact: Fact;
}) {
  const property = getKBProperty(propId);
  return (
    <div className="flex items-baseline gap-1 py-[3px] group/row">
      <span className="text-muted-foreground text-[12px] shrink-0 whitespace-nowrap">
        {property?.name ?? titleCase(propId)}
      </span>
      <span
        className="flex-1 border-b border-dotted border-border/40 min-w-[16px] translate-y-[-3px]"
        aria-hidden="true"
      />
      <span className="font-medium text-[12px] tabular-nums text-right shrink-0 max-w-[60%] truncate">
        <FactValueDisplay fact={fact} property={property} />
      </span>
    </div>
  );
}

/** Single category card with its own border/background. */
function CategoryCard({
  label,
  props,
  latestByProp,
}: {
  label: string;
  props: string[];
  latestByProp: Map<string, Fact>;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-gradient-to-br from-card to-muted/20 px-4 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 mb-1.5 pb-1 border-b border-border/30">
        {label}
      </div>
      {props.map((propId) => {
        const fact = latestByProp.get(propId);
        if (!fact) return null;
        return <FactRow key={propId} propId={propId} fact={fact} />;
      })}
    </div>
  );
}

/**
 * Distribute categories across N columns, balancing by item count.
 * Greedy algorithm: assign each category to the shortest column.
 */
function distributeColumns<T extends { props: string[] }>(
  groups: T[],
  numCols: number,
): T[][] {
  const columns: T[][] = Array.from({ length: numCols }, () => []);
  const heights: number[] = new Array(numCols).fill(0);

  for (const group of groups) {
    let minIdx = 0;
    for (let i = 1; i < numCols; i++) {
      if (heights[i] < heights[minIdx]) minIdx = i;
    }
    columns[minIdx].push(group);
    // +1.5 accounts for category header + spacing
    heights[minIdx] += group.props.length + 1.5;
  }

  return columns;
}

/** Full categorized facts display panel used on entity profile pages. */
export function FactsPanel({
  facts,
  entityId,
}: {
  facts: Fact[];
  entityId: string;
}) {
  const latestByProp = getLatestFactsByProperty(facts);
  const categoryGroups = groupByCategory([...latestByProp.keys()]);

  if (latestByProp.size === 0) return null;

  // Use 2 columns when there are enough categories/facts to benefit
  const useMultiCol = categoryGroups.length >= 3 && latestByProp.size >= 8;
  const columns = useMultiCol
    ? distributeColumns(categoryGroups, 2)
    : [categoryGroups];

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-base font-bold tracking-tight">Facts</h2>
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {latestByProp.size}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" aria-hidden="true" />
      </div>
      <div
        className={
          useMultiCol
            ? "grid grid-cols-1 md:grid-cols-2 gap-2.5 items-start"
            : "space-y-2.5"
        }
      >
        {columns.map((colGroups, colIdx) => (
          <div key={colIdx} className="flex flex-col gap-2.5">
            {colGroups.map(({ category, label, props }) => (
              <CategoryCard
                key={category}
                label={label}
                props={props}
                latestByProp={latestByProp}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 text-center">
        <Link
          href={`/factbase/entity/${entityId}`}
          className="text-[11px] text-muted-foreground/60 hover:text-primary transition-colors"
        >
          View all facts in FactBase &rarr;
        </Link>
      </div>
    </section>
  );
}
