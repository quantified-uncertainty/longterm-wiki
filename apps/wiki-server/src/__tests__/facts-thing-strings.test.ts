import { describe, it, expect } from "vitest";
import { buildFactThingStrings } from "../routes/factbase/facts.js";

/**
 * Regression tests for the FactBase → things dual-write title generation.
 * See QUA-397: the pre-fix code fell back to `f.factId` when `f.label` was
 * missing, leaking raw IDs like `f_qR5tY9wE1a — Anthropic` into the things
 * table (visible in entity profile viewer, search, etc).
 */

describe("buildFactThingStrings", () => {
  it("uses label when present", () => {
    const { title, description } = buildFactThingStrings(
      { label: "Total funding", measure: "total-funding", value: "$5B", numeric: null },
      "Anthropic"
    );
    expect(title).toBe("Total funding — Anthropic");
    expect(description).toBe("Total funding: $5B");
  });

  it("falls back to measure when label is missing", () => {
    const { title, description } = buildFactThingStrings(
      { label: null, measure: "interpretability-team-size", value: "12", numeric: null },
      "Anthropic"
    );
    expect(title).toBe("interpretability-team-size — Anthropic");
    expect(description).toBe("interpretability-team-size: 12");
  });

  it("falls back to entity name only when both label AND measure are missing", () => {
    const { title, description } = buildFactThingStrings(
      { label: null, measure: null, value: "1000000000", numeric: null },
      "Anthropic"
    );
    expect(title).toBe("Anthropic");
    expect(description).toBe("1000000000");
  });

  it("NEVER falls back to the raw factId in title or description (QUA-397)", () => {
    const { title, description } = buildFactThingStrings(
      { label: null, measure: null, value: null, numeric: 42 },
      "DeepMind"
    );
    // The critical assertion: nothing in the output matches the fact-ID shape.
    expect(title).not.toMatch(/^f_[A-Za-z0-9]{8,}/);
    expect(title).not.toMatch(/^[a-f0-9]{8,12}/);
    expect(description ?? "").not.toMatch(/^f_[A-Za-z0-9]{8,}/);
    expect(description ?? "").not.toMatch(/^[a-f0-9]{8,12}/);
  });

  it("uses label over measure even if both are present", () => {
    const { title } = buildFactThingStrings(
      { label: "Annual revenue", measure: "annual-revenue", value: "$100M", numeric: null },
      "Acme"
    );
    expect(title).toBe("Annual revenue — Acme");
  });

  it("handles numeric-only facts (no value string)", () => {
    const { title, description } = buildFactThingStrings(
      { label: "Employee count", measure: "employee-count", value: null, numeric: 250 },
      "Acme"
    );
    expect(title).toBe("Employee count — Acme");
    expect(description).toBe("Employee count: 250");
  });

  it("omits description when both value and numeric are missing", () => {
    const { description } = buildFactThingStrings(
      { label: "Unknown", measure: null, value: null, numeric: null },
      "Acme"
    );
    expect(description).toBeUndefined();
  });

  it("treats empty-string label as missing (falsy fallback)", () => {
    const { title } = buildFactThingStrings(
      { label: "", measure: "some-measure", value: null, numeric: null },
      "Acme"
    );
    expect(title).toBe("some-measure — Acme");
  });
});
