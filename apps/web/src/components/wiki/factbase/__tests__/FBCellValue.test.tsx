// @vitest-environment jsdom
/**
 * Tests for FBCellValue component — covers all rendering code paths.
 *
 * Regression tests for Bug A/C (unformatted numbers in table cells)
 * and general FBCellValue correctness.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FieldDef } from "@longterm-wiki/factbase";

// Mock the data-layer import so we don't need database.json
vi.mock("@data/factbase", () => ({
  getFactBaseEntity: vi.fn(() => undefined),
}));

// Mock FBRefLink to avoid pulling in full entity rendering
vi.mock("../FBRefLink", () => ({
  FBRefLink: ({ id }: { id: string }) => <span data-testid="ref-link">{id}</span>,
}));

import { FBCellValue } from "../FBCellValue";

describe("FBCellValue", () => {
  // ── Path 1: null/undefined → em-dash ──
  it("renders em-dash for null value", () => {
    render(<FBCellValue value={null} fieldName="test" />);
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });

  it("renders em-dash for undefined value", () => {
    render(<FBCellValue value={undefined} fieldName="test" />);
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });

  // ── Path 2: entity reference via shouldResolveAsRef ──
  it("renders ref link for sid_-prefixed string values", () => {
    // sid_ values short-circuit in shouldResolveAsRef (isSid check) — no getEntity call needed
    render(<FBCellValue value="sid_abc12345" fieldName="org" />);
    expect(screen.getByTestId("ref-link")).toHaveTextContent("sid_abc12345");
  });

  it("renders ref link when fieldType is ref", () => {
    const fieldDef: FieldDef = { type: "ref", description: "Reference" };
    render(<FBCellValue value="some-entity" fieldName="parent" fieldDef={fieldDef} />);
    expect(screen.getByTestId("ref-link")).toHaveTextContent("some-entity");
  });

  // ── Path 3: source/key-publication URL ──
  it("renders source URL as short domain link", () => {
    render(
      <FBCellValue
        value="https://www.reuters.com/technology/article"
        fieldName="source"
      />
    );
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("reuters.com");
    expect(link).toHaveAttribute("href", "https://www.reuters.com/technology/article");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders key-publication URL as short domain link", () => {
    render(
      <FBCellValue
        value="https://arxiv.org/abs/2301.12345"
        fieldName="key-publication"
      />
    );
    expect(screen.getByRole("link")).toHaveTextContent("arxiv.org");
  });

  // ── Path 4: number with currency unit (USD) ──
  it("formats number with USD unit as compact currency", () => {
    const fieldDef: FieldDef = { type: "number", unit: "USD", description: "" };
    render(<FBCellValue value={380_000_000_000} fieldName="valuation" fieldDef={fieldDef} />);
    expect(screen.getByText("$380B")).toBeInTheDocument();
  });

  it("formats smaller USD amount compactly", () => {
    const fieldDef: FieldDef = { type: "number", unit: "USD", description: "" };
    render(<FBCellValue value={850_000_000} fieldName="revenue" fieldDef={fieldDef} />);
    expect(screen.getByText("$850M")).toBeInTheDocument();
  });

  // ── Path 5: number with fraction field → percentage ──
  it("formats fraction field as percentage", () => {
    const fieldDef: FieldDef = { type: "number", description: "" };
    render(<FBCellValue value={0.85} fieldName="stake" fieldDef={fieldDef} />);
    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("formats pledge fraction as percentage", () => {
    const fieldDef: FieldDef = { type: "number", description: "" };
    render(<FBCellValue value={0.01} fieldName="pledge" fieldDef={fieldDef} />);
    expect(screen.getByText("1%")).toBeInTheDocument();
  });

  // ── Path 6: array range with fraction ──
  it("formats array range with fraction field as percentage range", () => {
    const fieldDef: FieldDef = { type: "number", description: "" };
    const { container } = render(
      <FBCellValue value={[0.015, 0.025]} fieldName="stake" fieldDef={fieldDef} />
    );
    expect(container.textContent).toContain("1.5%");
    expect(container.textContent).toContain("2.5%");
  });

  // ── Path 7: array range with currency ──
  it("formats array range with USD unit as compact currency range", () => {
    const fieldDef: FieldDef = { type: "number", unit: "USD", description: "" };
    const { container } = render(
      <FBCellValue value={[5_000_000, 10_000_000]} fieldName="amount" fieldDef={fieldDef} />
    );
    expect(container.textContent).toContain("$5M");
    expect(container.textContent).toContain("$10M");
  });

  // ── Path 8: date ──
  it("formats date string as month year", () => {
    const fieldDef: FieldDef = { type: "date", description: "" };
    render(<FBCellValue value="2024-06-15" fieldName="founded" fieldDef={fieldDef} />);
    expect(screen.getByText("Jun 2024")).toBeInTheDocument();
  });

  // ── Path 9: boolean by schema ──
  it("renders boolean true as checkmark via schema type", () => {
    const fieldDef: FieldDef = { type: "boolean", description: "" };
    render(<FBCellValue value={true} fieldName="active" fieldDef={fieldDef} />);
    expect(screen.getByText("\u2713")).toBeInTheDocument();
  });

  // ── Path 10: boolean by typeof ──
  it("renders boolean false as X mark without schema", () => {
    render(<FBCellValue value={false} fieldName="active" />);
    expect(screen.getByText("\u2717")).toBeInTheDocument();
  });

  // ── Path 11: fallback array range without schema ──
  it("formats array range without schema using field name hint", () => {
    const { container } = render(
      <FBCellValue value={[5_000_000, 10_000_000]} fieldName="amount" />
    );
    expect(container.textContent).toContain("$5M");
    expect(container.textContent).toContain("$10M");
  });

  // ── Path 12: fallback number without schema ──
  it("formats plain number with currency hint from field name", () => {
    render(<FBCellValue value={1_000_000_000} fieldName="valuation" />);
    expect(screen.getByText("$1B")).toBeInTheDocument();
  });

  it("formats plain number without currency hint", () => {
    render(<FBCellValue value={4074} fieldName="headcount" />);
    expect(screen.getByText("4,074")).toBeInTheDocument();
  });

  // ── Path 13: role badge ──
  it("renders known role as styled badge", () => {
    render(<FBCellValue value="founder" fieldName="role" />);
    const badge = screen.getByText("Founder");
    expect(badge.className).toContain("rounded-full");
  });

  it("does not render unknown role as badge", () => {
    render(<FBCellValue value="advisor" fieldName="role" />);
    const el = screen.getByText("advisor");
    expect(el.className).not.toContain("rounded-full");
  });

  // ── Path 14: generic URL ──
  it("renders generic URL as short domain link", () => {
    render(
      <FBCellValue
        value="https://github.com/anthropics/claude"
        fieldName="repo"
      />
    );
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("github.com");
    expect(link).toHaveAttribute("href", "https://github.com/anthropics/claude");
  });

  // ── Path 15: final fallback → formatKBCellValue ──
  it("renders plain string as text via fallback", () => {
    render(<FBCellValue value="Board Member" fieldName="role" />);
    expect(screen.getByText("Board Member")).toBeInTheDocument();
  });

  // ── Edge cases ──
  it("does not render currency for headcount field with number schema", () => {
    const fieldDef: FieldDef = { type: "number", description: "" };
    render(<FBCellValue value={4074} fieldName="headcount" fieldDef={fieldDef} />);
    const text = screen.getByText("4,074");
    expect(text).toBeInTheDocument();
  });

  it("infers USD for amount field without schema", () => {
    render(<FBCellValue value={50_000_000} fieldName="amount" />);
    expect(screen.getByText("$50M")).toBeInTheDocument();
  });

  // Drizzle numeric() columns return JS strings. These tests guard the
  // coerce-then-delegate path in FBCellValue against regressions.
  describe("string-typed PG numeric fallback", () => {
    it("formats string-typed funding round raised as USD", () => {
      render(<FBCellValue value="8000000000" fieldName="raised" />);
      expect(screen.getByText("$8B")).toBeInTheDocument();
    });

    it("formats string-typed valuation as USD", () => {
      render(<FBCellValue value="380000000000" fieldName="valuation" />);
      expect(screen.getByText("$380B")).toBeInTheDocument();
    });

    it("formats camelCase raisedLow (PG column) as USD", () => {
      render(<FBCellValue value="2600000000" fieldName="raisedLow" />);
      expect(screen.getByText("$2.6B")).toBeInTheDocument();
    });

    it("formats impliedValuation as USD (≥10 drops decimal: 61.5 → 62)", () => {
      render(<FBCellValue value="61500000000" fieldName="impliedValuation" />);
      expect(screen.getByText("$62B")).toBeInTheDocument();
    });

    it("formats string-typed fraction field as percentage", () => {
      const fieldDef: FieldDef = { type: "number", description: "" };
      render(<FBCellValue value="0.05" fieldName="stake" fieldDef={fieldDef} />);
      expect(screen.getByText("5%")).toBeInTheDocument();
    });

    it("respects explicit unit from schema over default USD", () => {
      const fieldDef: FieldDef = { type: "number", unit: "percent", description: "" };
      const { container } = render(
        <FBCellValue value="0.12" fieldName="raised" fieldDef={fieldDef} />
      );
      expect(container.textContent).toContain("%");
      expect(container.textContent).not.toContain("$");
    });

    it("leaves non-currency string values to existing paths", () => {
      render(<FBCellValue value="123" fieldName="notes" />);
      expect(screen.getByText("123")).toBeInTheDocument();
    });

    it("does not crash on non-numeric string in currency field", () => {
      render(<FBCellValue value="not a number" fieldName="amount" />);
      expect(screen.getByText("not a number")).toBeInTheDocument();
    });

    it("renders empty output for empty string in currency field", () => {
      // Empty string hits the length guard in the new block and falls through
      // to formatKBCellValue which stringifies to "".
      const { container } = render(<FBCellValue value="" fieldName="raised" />);
      expect(container.textContent).toBe("");
    });

    it("handles non-finite strings gracefully", () => {
      render(<FBCellValue value="Infinity" fieldName="valuation" />);
      expect(screen.getByText("Infinity")).toBeInTheDocument();
    });

    it("formats string-typed zero as $0", () => {
      render(<FBCellValue value="0" fieldName="raised" />);
      expect(screen.getByText("$0")).toBeInTheDocument();
    });

    it("formats negative string currency correctly", () => {
      // Would only occur for NAV-style fields, but the parse path handles it.
      render(<FBCellValue value="-5000000" fieldName="amount" />);
      const el = screen.getByText(/5M/);
      expect(el.textContent).toMatch(/-\$/);
    });
  });
});
