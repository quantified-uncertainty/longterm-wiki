import { describe, it, expect } from "vitest";

import { checkContent } from "./validate-factbase-fact-unit-field.ts";

describe("validate-factbase-fact-unit-field", () => {
  it("flags a top-level `unit:` field on a fact (indent 4)", () => {
    const yaml = [
      "entity: sid_abc123",
      "facts:",
      "  - id: f_foo",
      "    property: total-funding",
      "    value: 5e+6",
      "    unit: GBP",
      "    asOf: 2018-01",
      "",
    ].join("\n");

    const violations = checkContent(yaml);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(6);
    expect(violations[0].suggestion).toContain("currency: GBP");
  });

  it("does not flag `currency:` at fact top-level", () => {
    const yaml = [
      "entity: sid_abc123",
      "facts:",
      "  - id: f_foo",
      "    property: total-funding",
      "    value: 5e+6",
      "    currency: GBP",
      "",
    ].join("\n");

    expect(checkContent(yaml)).toHaveLength(0);
  });

  it("does not flag `unit:` inside a structured value block (indent 6+)", () => {
    const yaml = [
      "entity: sid_abc123",
      "facts:",
      "  - id: f_foo",
      "    property: total-funding",
      "    value:",
      "      type: number",
      "      value: 5e+6",
      "      unit: GBP",
      "",
    ].join("\n");

    expect(checkContent(yaml)).toHaveLength(0);
  });

  it("flags multiple violations and reports each line", () => {
    const yaml = [
      "facts:",
      "  - id: f_1",
      "    property: revenue",
      "    unit: EUR",
      "  - id: f_2",
      "    property: valuation",
      "    unit: JPY",
      "",
    ].join("\n");

    const violations = checkContent(yaml);
    expect(violations).toHaveLength(2);
    expect(violations[0].line).toBe(4);
    expect(violations[0].suggestion).toContain("currency: EUR");
    expect(violations[1].line).toBe(7);
    expect(violations[1].suggestion).toContain("currency: JPY");
  });

  it("flags percent/count units too (even when non-monetary) because the loader drops them the same way", () => {
    const yaml = [
      "facts:",
      "  - id: f_1",
      "    property: market-share",
      "    value: 64",
      "    unit: percent",
      "",
    ].join("\n");

    const violations = checkContent(yaml);
    expect(violations).toHaveLength(1);
    expect(violations[0].text).toContain("unit: percent");
  });

  it("returns no violations for a well-formed facts file", () => {
    const yaml = [
      "entity: sid_abc123",
      "facts:",
      "  - id: f_1",
      "    property: founded-date",
      "    value: '2018'",
      "  - id: f_2",
      "    property: total-funding",
      "    value: 5e+6",
      "    currency: GBP",
      "    usdEquivalent: 6700000",
      "",
    ].join("\n");

    expect(checkContent(yaml)).toHaveLength(0);
  });
});
