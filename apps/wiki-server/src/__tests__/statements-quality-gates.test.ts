/**
 * Unit tests for pipeline quality gates on statement creation.
 *
 * These tests verify the `validateStatementQuality()` function which rejects
 * semantically invalid statements that pass Zod schema validation but represent
 * garbage data:
 * 1. Empty structured statements (no value fields populated)
 * 2. Benchmark scores with implausible magnitudes (e.g. 34,000,000%)
 * 3. $0 values for financial properties (revenue, valuation, etc.)
 * 4. Attributed statements with empty/whitespace-only statementText
 *
 * See discussion #1736, Section 5 for context.
 */

import { describe, it, expect } from "vitest";
import { validateStatementQuality } from "../routes/statements.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid minimal structured statement with a value field. */
function validStructured() {
  return {
    variety: "structured" as const,
    statementText: "Anthropic was founded in 2021.",
    subjectEntityId: "anthropic",
    valueText: "2021",
    citations: [],
    pageReferences: [],
  };
}

/** A valid attributed statement. */
function validAttributed() {
  return {
    variety: "attributed" as const,
    statementText: "Dario Amodei said AI safety is critical.",
    subjectEntityId: "anthropic",
    attributedTo: "dario-amodei",
    citations: [],
    pageReferences: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Block empty structured statements
// ---------------------------------------------------------------------------

describe("Quality gate: block empty structured statements", () => {
  it("accepts structured statement with valueNumeric", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      valueText: undefined,
      valueNumeric: 42,
    });
    expect(result).toBeNull();
  });

  it("accepts structured statement with valueText", () => {
    const result = validateStatementQuality(validStructured());
    expect(result).toBeNull();
  });

  it("accepts structured statement with valueDate", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      valueText: undefined,
      valueDate: "2021-01-01",
    });
    expect(result).toBeNull();
  });

  it("accepts structured statement with valueEntityId", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      valueText: undefined,
      valueEntityId: "google",
    });
    expect(result).toBeNull();
  });

  it("accepts structured statement with valueSeries", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      valueText: undefined,
      valueSeries: { "2023": 100, "2024": 200 },
    });
    expect(result).toBeNull();
  });

  it("rejects structured statement with no value fields at all", () => {
    const result = validateStatementQuality({
      variety: "structured" as const,
      statementText: "Some statement.",
      subjectEntityId: "anthropic",
      citations: [],
      pageReferences: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Structured statements must have at least one value field");
  });

  it("rejects structured statement with all value fields explicitly null", () => {
    const result = validateStatementQuality({
      variety: "structured" as const,
      statementText: "Some statement.",
      subjectEntityId: "anthropic",
      valueNumeric: null,
      valueText: null,
      valueDate: null,
      valueEntityId: null,
      valueSeries: null,
      citations: [],
      pageReferences: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Structured statements must have at least one value field");
  });

  it("does not apply empty-value check to attributed statements", () => {
    // Attributed statements don't need value fields
    const result = validateStatementQuality(validAttributed());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Validate benchmark score magnitudes
// ---------------------------------------------------------------------------

describe("Quality gate: benchmark score magnitude", () => {
  it("accepts benchmark score of 95 (percentage)", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "benchmark-score",
      valueNumeric: 95,
    });
    expect(result).toBeNull();
  });

  it("accepts benchmark score of 1800 (ELO)", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "benchmark-score",
      valueNumeric: 1800,
    });
    expect(result).toBeNull();
  });

  it("accepts benchmark score at the boundary (10000)", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "benchmark-score",
      valueNumeric: 10000,
    });
    expect(result).toBeNull();
  });

  it("rejects benchmark score of 34000000 (raw score stored as percentage)", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "benchmark-score",
      valueNumeric: 34000000,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("exceeds maximum plausible value");
  });

  it("rejects large negative benchmark score", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "benchmark-score",
      valueNumeric: -50000,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("exceeds maximum plausible value");
  });

  it("does not apply benchmark check to other properties", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "employee-count",
      valueNumeric: 50000,
    });
    expect(result).toBeNull();
  });

  it("does not apply benchmark check when valueNumeric is null", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "benchmark-score",
      valueNumeric: null,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Block $0 for financial properties
// ---------------------------------------------------------------------------

describe("Quality gate: block $0 financial values", () => {
  const financialProperties = [
    "revenue",
    "valuation",
    "funding-round",
    "operating-expenses",
  ];

  for (const propId of financialProperties) {
    it(`rejects $0 for ${propId}`, () => {
      const result = validateStatementQuality({
        ...validStructured(),
        propertyId: propId,
        valueNumeric: 0,
      });
      expect(result).not.toBeNull();
      expect(result).toContain("cannot have a value of $0");
    });

    it(`accepts non-zero value for ${propId}`, () => {
      const result = validateStatementQuality({
        ...validStructured(),
        propertyId: propId,
        valueNumeric: 1000000,
      });
      expect(result).toBeNull();
    });
  }

  it("allows $0 for non-financial properties", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "employee-count",
      valueNumeric: 0,
    });
    expect(result).toBeNull();
  });

  it("allows null valueNumeric for financial properties", () => {
    const result = validateStatementQuality({
      ...validStructured(),
      propertyId: "revenue",
      valueNumeric: null,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Require statementText for attributed statements
// ---------------------------------------------------------------------------

describe("Quality gate: attributed statements need statementText", () => {
  it("accepts attributed statement with non-empty statementText", () => {
    const result = validateStatementQuality(validAttributed());
    expect(result).toBeNull();
  });

  it("rejects attributed statement with whitespace-only statementText", () => {
    const result = validateStatementQuality({
      ...validAttributed(),
      statementText: "   ",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("non-empty statementText");
  });
});

// ---------------------------------------------------------------------------
// Combined: multiple rules don't interfere
// ---------------------------------------------------------------------------

describe("Quality gate: combined checks", () => {
  it("a fully valid structured statement passes all checks", () => {
    const result = validateStatementQuality({
      variety: "structured" as const,
      statementText: "Anthropic raised $7.3B in total funding.",
      subjectEntityId: "anthropic",
      propertyId: "funding-round",
      valueNumeric: 7300000000,
      valueUnit: "USD",
      validStart: "2024-01-01",
      citations: [],
      pageReferences: [],
    });
    expect(result).toBeNull();
  });

  it("a fully valid attributed statement passes all checks", () => {
    const result = validateStatementQuality({
      variety: "attributed" as const,
      statementText: "We believe AI safety research is the most important work.",
      subjectEntityId: "anthropic",
      attributedTo: "dario-amodei",
      citations: [],
      pageReferences: [],
    });
    expect(result).toBeNull();
  });
});
