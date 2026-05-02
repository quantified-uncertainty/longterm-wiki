// @vitest-environment jsdom
/**
 * Regression test for QUA-1052: GenericCollectionTable must not render the
 * full row set when the collection is huge. Rendering thousands of rows
 * inside a path-mode tab tree (org/[slug] page) made the SSR HTML for
 * mega-funders (coefficient-giving with 2,626 grants, cea with 1,649)
 * blow past 5MB and intermittently crashed React hydration with #418.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { FactBaseRecordEntry } from "@/data/factbase";

// `entity-collection-table` reaches into several modules that themselves
// load the built database.json / factbase-data.json at module load. The
// mocks below cover exactly the imports the component uses today — if a
// future edit pulls in another symbol from one of these modules, vitest
// will surface the gap as a "X is not a function" failure (long after the
// code change but still before merging, via the test suite). Keep the
// surface minimal and explicit.
vi.mock("@/data/factbase", () => ({
  getKBRecordSchema: () => undefined,
}));
vi.mock("@/data/tablebase", () => ({
  getRecordVerdict: () => undefined,
}));
vi.mock("@/app/sourcing/sourcing-shared", () => ({
  getSourcingHref: () => undefined,
}));
vi.mock("@/components/sourcing/SourcingDot", () => ({
  SourcingDot: () => <span data-testid="dot" />,
}));
vi.mock("@/components/sourcing/sourcing-status", () => ({
  recordVerdictToStatus: () => "not_run",
}));
vi.mock("@/components/wiki/factbase/FBCellValue", () => ({
  FBCellValue: ({ value }: { value: unknown }) => <>{String(value ?? "")}</>,
}));
vi.mock("@/components/wiki/factbase/format", () => ({
  titleCase: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
}));

import {
  GenericCollectionTable,
  MAX_SSR_ROWS,
} from "@/components/factbase/entity-collection-table";

function makeItems(n: number): FactBaseRecordEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `key-${i}`,
    schema: "test-schema",
    ownerEntityId: "owner",
    fields: { name: `Row ${i}` },
  }));
}

function countDataRows(container: HTMLElement): number {
  // Match every <tr> in <tbody>; the header tr lives in <thead>.
  return container.querySelectorAll("tbody tr").length;
}

describe("GenericCollectionTable — SSR row cap (QUA-1052)", () => {
  it("renders all rows when count is well below the cap", () => {
    const { container } = render(
      <GenericCollectionTable collectionName="grants" items={makeItems(50)} />,
    );
    expect(countDataRows(container)).toBe(50);
    // Truncation notice should not appear.
    expect(container.textContent).not.toContain("Showing first");
  });

  it("renders all rows when count is exactly at the cap (boundary)", () => {
    const { container } = render(
      <GenericCollectionTable
        collectionName="grants"
        items={makeItems(MAX_SSR_ROWS)}
      />,
    );
    expect(countDataRows(container)).toBe(MAX_SSR_ROWS);
    expect(container.textContent).not.toContain("Showing first");
  });

  it("caps rendered rows when count is one above the cap (off-by-one boundary)", () => {
    // Catches a >= vs > regression on the truncation predicate. With
    // items.length = MAX_SSR_ROWS + 1, the >= variant would render all
    // rows, while > correctly truncates to MAX_SSR_ROWS.
    const oneAbove = MAX_SSR_ROWS + 1;
    const { container } = render(
      <GenericCollectionTable
        collectionName="grants"
        items={makeItems(oneAbove)}
      />,
    );
    expect(countDataRows(container)).toBe(MAX_SSR_ROWS);
    expect(container.textContent).toContain(
      `Showing first ${MAX_SSR_ROWS} of ${oneAbove} rows.`,
    );
  });

  it("caps rendered rows and shows truncation notice on a mega-funder-sized collection", () => {
    const total = 2626; // coefficient-giving's actual grant count
    const { container } = render(
      <GenericCollectionTable
        collectionName="grants"
        items={makeItems(total)}
      />,
    );
    // Only the first MAX_SSR_ROWS rows make it into SSR — this is what guards
    // hydration on coefficient-giving's 2,626-grant collection.
    expect(countDataRows(container)).toBe(MAX_SSR_ROWS);
    expect(
      screen.getByText(
        new RegExp(`Showing first ${MAX_SSR_ROWS} of 2,626 rows`),
      ),
    ).toBeTruthy();
  });

  it("renders a Link to the dedicated directory when one exists", () => {
    // For collections with a top-level directory page (grants, publications,
    // investments, funding-rounds, funding-programs, divisions), the
    // truncation notice surfaces a navigation affordance so users can
    // browse the remaining rows.
    render(
      <GenericCollectionTable
        collectionName="grants"
        items={makeItems(MAX_SSR_ROWS + 100)}
      />,
    );
    const link = screen.getByRole("link", {
      name: /Browse all grants in the Grants directory/,
    });
    expect(link.getAttribute("href")).toBe("/grants");
  });

  it("omits the directory link for collections without a dedicated directory", () => {
    // `safety-milestones` has no top-level directory, so the truncation
    // notice should still render but without a navigation link — better
    // than a stale or 404-ing href.
    render(
      <GenericCollectionTable
        collectionName="safety-milestones"
        items={makeItems(MAX_SSR_ROWS + 50)}
      />,
    );
    expect(
      screen.queryByRole("link", { name: /Browse all/ }),
    ).toBeNull();
    expect(
      screen.getByText(/Showing first 200 of 250 rows/),
    ).toBeTruthy();
  });

  it("keeps the true total in the section header — not the rendered subset", () => {
    // The SectionHeader is anchored at `#col-{collectionName}`. We scope the
    // count assertion to that node so a regression that moves the count out
    // of the header (or replaces it with the rendered subset) actually fails
    // — a substring check on the whole document would pass on any "2626"
    // anywhere in the markup.
    const total = 2626;
    const { container } = render(
      <GenericCollectionTable
        collectionName="grants"
        items={makeItems(total)}
      />,
    );
    const header = container.querySelector("#col-grants");
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain(String(total));
    // And the rendered subset count (MAX_SSR_ROWS) should NOT be the badge.
    expect(header!.textContent).not.toContain(`(${MAX_SSR_ROWS})`);
  });
});
