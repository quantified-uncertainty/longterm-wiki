/**
 * Unit tests for quality dimension Zod schemas in the statements route.
 *
 * These tests verify that the API boundary enforces:
 * 1. Exactly the 10 known quality dimension keys (no extras, none missing)
 * 2. Dimension values are in [0, 1]
 * 3. Category score values are in [0, 1]
 *
 * Issue: https://github.com/quantified-uncertainty/longterm-wiki/issues/1663
 */

import { describe, it, expect } from "vitest";
import {
  QualityDimensionsSchema,
  BatchScoreBody,
  CoverageScoreBody,
} from "../routes/statements.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid set of all 10 quality dimensions with in-range values */
function validDimensions() {
  return {
    structure:          0.8,
    precision:          0.7,
    clarity:            0.9,
    resolvability:      0.6,
    uniqueness:         0.5,
    atomicity:          0.4,
    importance:         0.3,
    neglectedness:      0.2,
    recency:            0.1,
    crossEntityUtility: 0.0,
  };
}

// ---------------------------------------------------------------------------
// QualityDimensionsSchema
// ---------------------------------------------------------------------------

describe("QualityDimensionsSchema", () => {
  it("accepts a valid full dimension set", () => {
    const result = QualityDimensionsSchema.safeParse(validDimensions());
    expect(result.success).toBe(true);
  });

  it("accepts boundary values (0 and 1)", () => {
    const dims = Object.fromEntries(
      Object.keys(validDimensions()).map((k) => [k, k === "structure" ? 0 : 1])
    );
    expect(QualityDimensionsSchema.safeParse(dims).success).toBe(true);
  });

  it("rejects an unknown extra key", () => {
    const dims = { ...validDimensions(), unknownKey: 0.5 };
    const result = QualityDimensionsSchema.safeParse(dims);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/unrecognized_keys/i);
    }
  });

  it("rejects a payload with a missing required key", () => {
    const { structure: _dropped, ...dims } = validDimensions();
    const result = QualityDimensionsSchema.safeParse(dims);
    expect(result.success).toBe(false);
  });

  it("rejects a value above 1", () => {
    const dims = { ...validDimensions(), structure: 1.1 };
    const result = QualityDimensionsSchema.safeParse(dims);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("structure");
    }
  });

  it("rejects a value below 0", () => {
    const dims = { ...validDimensions(), precision: -0.01 };
    const result = QualityDimensionsSchema.safeParse(dims);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("precision");
    }
  });

  it("rejects null dimension values", () => {
    const dims = { ...validDimensions(), clarity: null };
    const result = QualityDimensionsSchema.safeParse(dims);
    expect(result.success).toBe(false);
  });

  it("rejects string dimension values", () => {
    const dims = { ...validDimensions(), recency: "high" };
    const result = QualityDimensionsSchema.safeParse(dims);
    expect(result.success).toBe(false);
  });

  it("rejects an entirely empty object", () => {
    expect(QualityDimensionsSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BatchScoreBody (POST /score)
// ---------------------------------------------------------------------------

describe("BatchScoreBody", () => {
  function validScorePayload() {
    return {
      scores: [
        {
          statementId: 1,
          qualityScore: 0.75,
          qualityDimensions: validDimensions(),
        },
      ],
    };
  }

  it("accepts a valid batch payload", () => {
    expect(BatchScoreBody.safeParse(validScorePayload()).success).toBe(true);
  });

  it("rejects when qualityDimensions has an unknown key", () => {
    const payload = validScorePayload();
    (payload.scores[0].qualityDimensions as Record<string, unknown>).bogusKey = 0.5;
    expect(BatchScoreBody.safeParse(payload).success).toBe(false);
  });

  it("rejects when qualityDimensions is missing a key", () => {
    const payload = validScorePayload();
    const { structure: _dropped, ...rest } = payload.scores[0].qualityDimensions;
    payload.scores[0].qualityDimensions = rest as typeof payload.scores[0]["qualityDimensions"];
    expect(BatchScoreBody.safeParse(payload).success).toBe(false);
  });

  it("rejects when a dimension value is out of range", () => {
    const payload = validScorePayload();
    payload.scores[0].qualityDimensions.structure = 2.0;
    expect(BatchScoreBody.safeParse(payload).success).toBe(false);
  });

  it("rejects when qualityScore is out of range", () => {
    const payload = validScorePayload();
    payload.scores[0].qualityScore = 1.5;
    expect(BatchScoreBody.safeParse(payload).success).toBe(false);
  });

  it("rejects an empty scores array", () => {
    expect(BatchScoreBody.safeParse({ scores: [] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CoverageScoreBody (POST /coverage-score)
// ---------------------------------------------------------------------------

describe("CoverageScoreBody", () => {
  function validCoveragePayload() {
    return {
      entityId: "anthropic",
      coverageScore: 0.6,
      categoryScores: { financial: 0.8, safety: 0.4 },
      statementCount: 42,
      qualityAvg: 0.7,
    };
  }

  it("accepts a valid coverage payload", () => {
    expect(CoverageScoreBody.safeParse(validCoveragePayload()).success).toBe(true);
  });

  it("accepts omitted qualityAvg (optional)", () => {
    const { qualityAvg: _dropped, ...payload } = validCoveragePayload();
    expect(CoverageScoreBody.safeParse(payload).success).toBe(true);
  });

  it("rejects a category score above 1", () => {
    const payload = validCoveragePayload();
    payload.categoryScores.financial = 1.5;
    expect(CoverageScoreBody.safeParse(payload).success).toBe(false);
  });

  it("rejects a category score below 0", () => {
    const payload = validCoveragePayload();
    payload.categoryScores.safety = -0.1;
    expect(CoverageScoreBody.safeParse(payload).success).toBe(false);
  });

  it("rejects when coverageScore is out of range", () => {
    const payload = validCoveragePayload();
    payload.coverageScore = -1;
    expect(CoverageScoreBody.safeParse(payload).success).toBe(false);
  });

  it("rejects null category score values", () => {
    const payload = {
      ...validCoveragePayload(),
      categoryScores: { financial: null },
    };
    expect(CoverageScoreBody.safeParse(payload).success).toBe(false);
  });
});
