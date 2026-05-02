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

// `entity-collection-table` reads from the global database/factbase module
// to look up record schemas + verdicts. Mock both so the test stays a pure
// render check that doesn't depend on built artifacts.
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

import { GenericCollectionTable } from "@/components/factbase/entity-collection-table";

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
  it("renders all rows when count is at or below the 200-row cap", () => {
    const { container } = render(
      <GenericCollectionTable collectionName="grants" items={makeItems(50)} />,
    );
    expect(countDataRows(container)).toBe(50);
    // Truncation notice should not appear.
    expect(container.textContent).not.toContain("Showing first");
  });

  it("renders all rows when count is exactly at the cap", () => {
    const { container } = render(
      <GenericCollectionTable collectionName="grants" items={makeItems(200)} />,
    );
    expect(countDataRows(container)).toBe(200);
    expect(container.textContent).not.toContain("Showing first");
  });

  it("caps rendered rows and shows truncation notice when count exceeds cap", () => {
    const { container } = render(
      <GenericCollectionTable collectionName="grants" items={makeItems(2626)} />,
    );
    // Only the first 200 rows make it into SSR — this is what guards
    // hydration on coefficient-giving's 2,626-grant collection.
    expect(countDataRows(container)).toBe(200);
    expect(screen.getByText(/Showing first 200 of 2,626 rows/)).toBeTruthy();
  });

  it("preserves the full count badge in the section header even when truncated", () => {
    const { container } = render(
      <GenericCollectionTable collectionName="grants" items={makeItems(2626)} />,
    );
    // The SectionHeader renders the *true* total (2626), not the rendered
    // subset, so users see the full size of the underlying collection.
    expect(container.textContent).toContain("2626");
  });
});
