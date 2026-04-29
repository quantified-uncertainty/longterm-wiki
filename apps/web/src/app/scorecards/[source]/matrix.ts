import { DIMENSION_OVERALL } from "@/app/scorecards/scorecards-constants";

export interface MatrixGrade {
  entityId: string;
  entityDisplayName: string;
  entitySlug: string | null;
  dimensionSlug: string;
  dimensionLabel: string;
  scoreNumeric: number | null;
  scoreLetter: string | null;
  scoreRaw: string;
}

export interface OrgDimensionRow {
  entityId: string;
  displayName: string;
  slug: string | null;
  cells: Record<string, MatrixGrade>;
}

export interface MatrixDimension {
  slug: string;
  label: string;
}

export interface MatrixResult {
  orgRows: OrgDimensionRow[];
  dimensionOrder: MatrixDimension[];
  hasOverall: boolean;
}

/**
 * Pure function: builds an org × dimension matrix from a flat grade list.
 *
 * - Orgs: alphabetical by displayName.
 * - Dimensions: `overall` first when present, then alphabetical by label.
 *
 * Last-write-wins on duplicate (entityId, dimensionSlug) pairs — the caller
 * is expected to filter to a single snapshot before calling, so duplicates
 * are an upstream invariant violation rather than a normal case.
 */
export function buildOrgDimensionMatrix(grades: MatrixGrade[]): MatrixResult {
  const orgMap = new Map<string, OrgDimensionRow>();
  const dimensionOrder: MatrixDimension[] = [];
  const seenDimensions = new Set<string>();

  for (const g of grades) {
    if (!seenDimensions.has(g.dimensionSlug)) {
      seenDimensions.add(g.dimensionSlug);
      dimensionOrder.push({ slug: g.dimensionSlug, label: g.dimensionLabel });
    }
    const existing = orgMap.get(g.entityId);
    if (existing) {
      existing.cells[g.dimensionSlug] = g;
    } else {
      orgMap.set(g.entityId, {
        entityId: g.entityId,
        displayName: g.entityDisplayName,
        slug: g.entitySlug,
        cells: { [g.dimensionSlug]: g },
      });
    }
  }

  dimensionOrder.sort((a, b) => {
    if (a.slug === DIMENSION_OVERALL && b.slug !== DIMENSION_OVERALL) return -1;
    if (b.slug === DIMENSION_OVERALL && a.slug !== DIMENSION_OVERALL) return 1;
    return a.label.localeCompare(b.label);
  });

  const orgRows = [...orgMap.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return {
    orgRows,
    dimensionOrder,
    hasOverall: dimensionOrder.some((d) => d.slug === DIMENSION_OVERALL),
  };
}
