// @vitest-environment jsdom
/**
 * FBF tests — QUA-657 regression guard.
 *
 * The missing-fact fallback must never render the raw entity id in visible
 * text — `entity` may be a stableId like `sid_xxx` which leaks into
 * user-facing pages.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock data-layer imports before importing the component
vi.mock("@data/factbase", () => ({
  getKBFacts: vi.fn(() => []),
  getKBLatest: vi.fn(() => undefined),
  getKBProperty: vi.fn((id: string) => {
    const properties: Record<string, { name: string }> = {
      revenue: { name: "Revenue" },
    };
    return properties[id];
  }),
}));

vi.mock("@/components/sourcing/FactSourcingDot", () => ({
  FactSourcingDot: () => null,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { FBF } from "@/components/wiki/FBF";

describe("FBF — missing fact fallback (QUA-657)", () => {
  it("renders children as fallback text when fact is missing", () => {
    render(
      <FBF entity="sid_mK9pX3rQ7n" property="revenue">
        $4 billion
      </FBF>,
    );
    expect(screen.getByText("$4 billion")).toBeDefined();
    expect(screen.queryByText(/sid_mK9pX3rQ7n/)).toBeNull();
  });

  it("renders property name (not stableId) as fallback when no children", () => {
    render(<FBF entity="sid_mK9pX3rQ7n" property="revenue" />);
    expect(screen.getByText("[missing: Revenue]")).toBeDefined();
    expect(screen.queryByText(/sid_mK9pX3rQ7n/)).toBeNull();
    expect(screen.queryByText(/\[missing: sid_/)).toBeNull();
  });

  it("falls back to raw property key when no registered property", () => {
    render(<FBF entity="sid_mK9pX3rQ7n" property="coding-market-share" />);
    expect(screen.getByText("[missing: coding-market-share]")).toBeDefined();
    expect(screen.queryByText(/sid_mK9pX3rQ7n/)).toBeNull();
  });

  it("preserves entity+property in title attribute for dev debugging", () => {
    const { container } = render(
      <FBF entity="sid_mK9pX3rQ7n" property="revenue" />,
    );
    const span = container.querySelector("span[title]");
    expect(span?.getAttribute("title")).toBe(
      "Missing FactBase fact: sid_mK9pX3rQ7n.revenue",
    );
  });
});
