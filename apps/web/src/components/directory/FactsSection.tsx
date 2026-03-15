/**
 * Shared fact display components for entity profile pages (organizations, people).
 * Extracts duplicated logic from org and person detail pages.
 */
import Link from "next/link";
import {
  getKBProperty,
  getKBEntity,
  getKBEntitySlug,
} from "@/data/factbase";
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

/** Group facts by property, taking only the latest per property. */
export function getLatestFactsByProperty(facts: Fact[]): Map<string, Fact> {
  const latest = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
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

/** Render a fact value, resolving ref/refs to entity name links. */
export function FactValueDisplay({ fact, property }: { fact: Fact; property?: Property }) {
  const v = fact.value;
  if (v.type === "ref") {
    const refEntity = getKBEntity(v.value);
    if (refEntity) {
      const refSlug = getKBEntitySlug(v.value);
      const href = refSlug && refEntity.type === "organization" ? `/organizations/${refSlug}`
        : refSlug && refEntity.type === "person" ? `/people/${refSlug}`
        : `/kb/entity/${v.value}`;
      return (
        <Link href={href} className="text-primary hover:underline">
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
            const refSlug = getKBEntitySlug(refId);
            const href = refSlug && refEntity.type === "organization" ? `/organizations/${refSlug}`
              : refSlug && refEntity.type === "person" ? `/people/${refSlug}`
              : `/kb/entity/${refId}`;
            return (
              <span key={refId}>
                {i > 0 && ", "}
                <Link href={href} className="text-primary hover:underline">
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
  return <span>{formatKBFactValue(fact, property?.unit, property?.display)}</span>;
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

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Facts
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {latestByProp.size}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
        {categoryGroups.map(({ category, label, props }) => (
          <div key={category} className="px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
              {label}
            </div>
            <div className="space-y-1.5">
              {props.map((propId) => {
                const fact = latestByProp.get(propId);
                if (!fact) return null;
                const property = getKBProperty(propId);
                return (
                  <div
                    key={propId}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <span className="text-muted-foreground text-xs truncate">
                      {property?.name ?? titleCase(propId)}
                    </span>
                    <span className="font-medium text-xs tabular-nums text-right shrink-0 max-w-[55%] truncate">
                      <FactValueDisplay fact={fact} property={property} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <Link
        href={`/kb/entity/${entityId}`}
        className="block mt-2 text-xs text-primary hover:underline text-center"
      >
        View all facts in KB explorer &rarr;
      </Link>
    </section>
  );
}
