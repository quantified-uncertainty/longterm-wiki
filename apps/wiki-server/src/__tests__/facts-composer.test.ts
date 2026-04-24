/**
 * Regression coverage for the facts composer (QUA-673).
 *
 * The fact composer builds `things.title`, `things.description`, and
 * `things.parent_title` from a `facts` row. Raw numeric values leaking into
 * description was the regression of QUA-82 that surfaced as unformatted 10+
 * digit numbers on `/organizations/:slug` Database tab (render-audit e2e).
 *
 * The composer is registered at module load as a side effect of importing
 * the facts route.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { composeThing, hasComposer } from "../routes/shared/compose-thing.js";

import "../routes/factbase/facts.js";

interface FactRow {
  factId: string;
  entityId: string;
  label?: string | null;
  measure?: string | null;
  value?: string | null;
  numeric?: string | number | null;
  currency?: string | null;
}

const ENTITY_STABLE_ID = "sid_deepmind001";

function compose(row: FactRow) {
  const titleMap = new Map<string, string>([[ENTITY_STABLE_ID, "Google DeepMind"]]);
  return composeThing<FactRow>("fact", row, titleMap);
}

describe("facts composer (QUA-673)", () => {
  beforeAll(() => {
    expect(hasComposer("fact")).toBe(true);
  });

  it("formats a USD revenue fact compactly", () => {
    const result = compose({
      factId: "f_abc",
      entityId: ENTITY_STABLE_ID,
      label: "Internal Revenue",
      measure: "internal-revenue",
      value: "1700000000",
      numeric: 1700000000,
      currency: "USD",
    });
    expect(result.description).toBe("Internal Revenue: $1.7B");
    expect(result.description).not.toMatch(/\d{10,}/);
  });

  it("formats a non-currency numeric fact compactly", () => {
    const result = compose({
      factId: "f_users",
      entityId: ENTITY_STABLE_ID,
      label: "User Count",
      measure: "user-count",
      value: "1000000000",
      numeric: 1000000000,
      currency: null,
    });
    expect(result.description).toBe("User Count: 1B");
    expect(result.description).not.toMatch(/\d{10,}/);
  });

  it("formats a scientific-notation numeric string", () => {
    const result = compose({
      factId: "f_losses",
      entityId: ENTITY_STABLE_ID,
      label: "Cumulative Losses",
      measure: "cumulative-losses",
      value: "7e+10",
      numeric: 7e10,
      currency: "USD",
    });
    expect(result.description).toBe("Cumulative Losses: $70B");
  });

  it("uses GBP symbol when currency is GBP", () => {
    const result = compose({
      factId: "f_gbp",
      entityId: ENTITY_STABLE_ID,
      label: "Turnover",
      measure: "turnover",
      value: "1325000000",
      numeric: 1325000000,
      currency: "GBP",
    });
    expect(result.description).toBe("Turnover: £1.3B");
  });

  it("preserves non-numeric text values verbatim", () => {
    const result = compose({
      factId: "f_hq",
      entityId: ENTITY_STABLE_ID,
      label: "Headquarters",
      measure: "headquarters",
      value: "Menlo Park, CA",
      numeric: null,
      currency: null,
    });
    expect(result.description).toBe("Headquarters: Menlo Park, CA");
  });

  it("preserves a ref-typed value (sid_...) verbatim", () => {
    const result = compose({
      factId: "f_founder",
      entityId: ENTITY_STABLE_ID,
      label: "Founder",
      measure: "founded-by",
      value: "sid_cMbVUVK29Q",
      numeric: null,
      currency: null,
    });
    expect(result.description).toBe("Founder: sid_cMbVUVK29Q");
  });

  it("preserves a range value verbatim (en-dash breaks the numeric regex)", () => {
    const result = compose({
      factId: "f_range",
      entityId: ENTITY_STABLE_ID,
      label: "Stake",
      measure: "stake",
      value: "0.015–0.025",
      numeric: null,
      currency: null,
    });
    expect(result.description).toBe("Stake: 0.015–0.025");
  });

  it("falls back to numeric column when value is null", () => {
    const result = compose({
      factId: "f_fallback",
      entityId: ENTITY_STABLE_ID,
      label: "Headcount",
      measure: "headcount",
      value: null,
      numeric: 78800,
      currency: null,
    });
    expect(result.description).toBe("Headcount: 78.8K");
  });

  it("leaves small numbers as-is (no suffix, no 10+ digit run risk)", () => {
    const result = compose({
      factId: "f_small",
      entityId: ENTITY_STABLE_ID,
      label: "Market Share",
      measure: "market-share",
      value: "63",
      numeric: 63,
      currency: null,
    });
    expect(result.description).toBe("Market Share: 63");
  });

  it("returns null description when both value and numeric are missing", () => {
    const result = compose({
      factId: "f_empty",
      entityId: ENTITY_STABLE_ID,
      label: "Unknown",
      measure: null,
      value: null,
      numeric: null,
      currency: null,
    });
    expect(result.description).toBeNull();
  });

  it("never leaks a 10+ digit run for any of the meta-ai regression values", () => {
    // The render-audit e2e flagged these exact values on /organizations/meta-ai.
    const cases: Array<[string, number]> = [
      ["1000000000", 1e9],
      ["69000000000", 6.9e10],
      ["125000000000", 1.25e11],
      ["70000000000", 7e10],
      ["164500000000", 1.645e11],
      ["200970000000", 2.0097e11],
      ["27000000000", 2.7e10],
      ["630000000", 6.3e8],
    ];
    for (const [valueStr, numeric] of cases) {
      const result = compose({
        factId: "f_case",
        entityId: ENTITY_STABLE_ID,
        label: "Revenue",
        measure: "revenue",
        value: valueStr,
        numeric,
        currency: "USD",
      });
      expect(
        result.description,
        `description must not contain a 10+ digit run for value=${valueStr}: ${result.description}`,
      ).not.toMatch(/(?<![a-zA-Z_])\d{10,}(?![a-zA-Z])/);
    }
  });
});
