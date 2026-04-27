// @vitest-environment jsdom
/** FactValueDisplay component tests — Phase 4 of #3768. */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Fact, Property } from "@longterm-wiki/factbase";

// Mock data-layer imports
vi.mock("@data/factbase", () => ({
  getKBEntity: vi.fn((id: string) => {
    const entities: Record<string, { name: string; slug: string }> = {
      anthropic: { name: "Anthropic", slug: "anthropic" },
      openai: { name: "OpenAI", slug: "openai" },
    };
    return entities[id];
  }),
  getKBEntitySlug: vi.fn((id: string) => id),
  getKBProperty: vi.fn(),
  isFactExpired: vi.fn(() => false),
}));

vi.mock("@data/entity-nav", () => ({
  getEntityHref: vi.fn((id: string) => `/organizations/${id}`),
}));

// Mock next/link as a simple anchor
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { FactValueDisplay } from "@components/directory/FactsSection";

// ── Test helpers ─────────────────────────────────────────────────────

function makeFact(value: Fact["value"], opts?: Partial<Fact>): Fact {
  return { id: "test-fact", subjectId: "test-entity", propertyId: "test-prop", value, ...opts };
}

function makeProperty(unit?: string, display?: Property["display"]): Property {
  return { id: "test-prop", name: "Test", dataType: "number", unit, display };
}

describe("FactValueDisplay", () => {
  describe("monetary values (production data)", () => {
    it("renders Anthropic valuation as compact '$62B' not '61500000000'", () => {
      // 61.5 rounds to 62 because ≥10 drops decimal (QUA-681).
      const fact = makeFact({ type: "number", value: 61_500_000_000, unit: "USD" });
      const prop = makeProperty("USD");
      render(<FactValueDisplay fact={fact} property={prop} />);
      expect(screen.getByText("$62B")).toBeInTheDocument();
    });

    it("renders OpenAI valuation as '$300B'", () => {
      const fact = makeFact({ type: "number", value: 300_000_000_000, unit: "USD" });
      const prop = makeProperty("USD");
      render(<FactValueDisplay fact={fact} property={prop} />);
      expect(screen.getByText("$300B")).toBeInTheDocument();
    });

    it("renders revenue in millions compactly", () => {
      const fact = makeFact({ type: "number", value: 850_000_000, unit: "USD" });
      const prop = makeProperty("USD");
      render(<FactValueDisplay fact={fact} property={prop} />);
      expect(screen.getByText("$850M")).toBeInTheDocument();
    });

    it("renders total funding compactly", () => {
      const fact = makeFact({ type: "number", value: 10_750_000_000, unit: "USD" });
      const prop = makeProperty("USD");
      render(<FactValueDisplay fact={fact} property={prop} />);
      // 10.75 rounds to 11 because ≥10 drops decimal (QUA-681).
      expect(screen.getByText("$11B")).toBeInTheDocument();
    });

    it("renders small revenue as compact thousands (Redwood Research bug from QUA-681)", () => {
      // Before the fix, this rendered as "$22,060" on /organizations/redwood-research.
      const fact = makeFact({ type: "number", value: 22_060, unit: "USD" });
      const prop = makeProperty("USD");
      render(<FactValueDisplay fact={fact} property={prop} />);
      expect(screen.getByText("$22K")).toBeInTheDocument();
    });
  });

  describe("headcount values", () => {
    it("renders headcount as locale-formatted number", () => {
      const fact = makeFact({ type: "number", value: 4074 });
      render(<FactValueDisplay fact={fact} />);
      expect(screen.getByText("4,074")).toBeInTheDocument();
    });

    it("renders large headcount as locale-formatted number", () => {
      const fact = makeFact({ type: "number", value: 180000, unit: "employees" });
      const prop = makeProperty("employees");
      render(<FactValueDisplay fact={fact} property={prop} />);
      expect(screen.getByText("180,000")).toBeInTheDocument();
    });
  });

  describe("entity references", () => {
    it("renders ref as entity name link when entity exists", () => {
      const fact = makeFact({ type: "ref", value: "anthropic" });
      render(<FactValueDisplay fact={fact} />);
      const link = screen.getByRole("link", { name: "Anthropic" });
      expect(link).toHaveAttribute("href", expect.stringContaining("anthropic"));
    });

    it("renders ref as raw ID when entity not found", () => {
      const fact = makeFact({ type: "ref", value: "unknown-entity-xyz" });
      render(<FactValueDisplay fact={fact} />);
      expect(screen.getByText("unknown-entity-xyz")).toBeInTheDocument();
    });

    it("renders refs as comma-separated entity links", () => {
      const fact = makeFact({ type: "refs", value: ["anthropic", "openai"] });
      render(<FactValueDisplay fact={fact} />);
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
    });
  });

  describe("other value types", () => {
    it("renders boolean true as Yes", () => {
      const fact = makeFact({ type: "boolean", value: true });
      render(<FactValueDisplay fact={fact} />);
      expect(screen.getByText("Yes")).toBeInTheDocument();
    });

    it("renders boolean false as No", () => {
      const fact = makeFact({ type: "boolean", value: false });
      render(<FactValueDisplay fact={fact} />);
      expect(screen.getByText("No")).toBeInTheDocument();
    });

    it("renders date as formatted month/year", () => {
      const fact = makeFact({ type: "date", value: "2021-01" });
      render(<FactValueDisplay fact={fact} />);
      expect(screen.getByText("Jan 2021")).toBeInTheDocument();
    });

    it("renders text value directly", () => {
      const fact = makeFact({ type: "text", value: "San Francisco, CA" });
      render(<FactValueDisplay fact={fact} />);
      expect(screen.getByText("San Francisco, CA")).toBeInTheDocument();
    });

    it("filters [object Object] text artifacts to empty string", () => {
      const fact = makeFact({ type: "text", value: "[object Object]" });
      const { container } = render(<FactValueDisplay fact={fact} />);
      // formatKBFactValue returns "" for [object Object] text
      expect(container.querySelector("span")?.textContent).toBe("");
    });

    it("renders range with currency", () => {
      const fact = makeFact({ type: "range", low: 1_000_000_000, high: 2_000_000_000 });
      const prop = makeProperty("USD");
      const { container } = render(<FactValueDisplay fact={fact} property={prop} />);
      const text = container.querySelector("span")?.textContent ?? "";
      expect(text).toContain("$1B");
      expect(text).toContain("$2B");
    });
  });

  describe("edge cases", () => {
    it("renders zero correctly", () => {
      const fact = makeFact({ type: "number", value: 0, unit: "USD" });
      const prop = makeProperty("USD");
      render(<FactValueDisplay fact={fact} property={prop} />);
      expect(screen.getByText("$0")).toBeInTheDocument();
    });

    it("renders min value with >= prefix", () => {
      const fact = makeFact({ type: "min", value: 5_000_000_000 });
      const prop = makeProperty("USD");
      const { container } = render(<FactValueDisplay fact={fact} property={prop} />);
      const text = container.querySelector("span")?.textContent ?? "";
      expect(text).toContain("≥");
      expect(text).toContain("$5B");
    });
  });
});
