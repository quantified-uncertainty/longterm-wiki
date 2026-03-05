/**
 * Unit tests for API boundary validation on statement endpoints.
 *
 * These tests verify that the API boundary enforces:
 * 1. Infinity is rejected for numeric fields (NaN is already rejected by Zod)
 * 2. Empty strings ("") are rejected for required string IDs and optional
 *    fields that, when provided, must be non-empty
 * 3. The CreateStatementBody and PatchStatementBody schemas enforce all constraints
 *
 * Root cause fix for issue #1647 — the statements extraction pipeline wrote junk
 * data across 5+ fix PRs because the API accepted empty entity IDs, Infinity
 * numeric values, and empty strings for required fields.
 */

import { describe, it, expect } from "vitest";
import {
  CreateStatementBody,
  PatchStatementBody,
} from "../routes/statements.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid minimal CreateStatementBody payload */
function validCreate() {
  return {
    variety: "structured" as const,
    statementText: "Anthropic was founded in 2021.",
    subjectEntityId: "anthropic",
  };
}

/** A valid full CreateStatementBody payload */
function validCreateFull() {
  return {
    variety: "structured" as const,
    statementText: "Anthropic has 500 employees.",
    subjectEntityId: "anthropic",
    propertyId: "employee-count",
    valueNumeric: 500,
    valueUnit: "employees",
    validStart: "2024-01-01",
    temporalGranularity: "year",
    sourceFactKey: "anthropic.employee_count",
    claimCategory: "size",
  };
}

// ---------------------------------------------------------------------------
// CreateStatementBody — required fields
// ---------------------------------------------------------------------------

describe("CreateStatementBody — required fields", () => {
  it("accepts a minimal valid payload", () => {
    expect(CreateStatementBody.safeParse(validCreate()).success).toBe(true);
  });

  it("accepts a full valid payload", () => {
    expect(CreateStatementBody.safeParse(validCreateFull()).success).toBe(true);
  });

  it("rejects when statementText is empty", () => {
    const payload = { ...validCreate(), statementText: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects when subjectEntityId is empty", () => {
    const payload = { ...validCreate(), subjectEntityId: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects when subjectEntityId is missing", () => {
    const { subjectEntityId: _dropped, ...payload } = validCreate();
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CreateStatementBody — numeric fields: Infinity and NaN rejection
// ---------------------------------------------------------------------------

describe("CreateStatementBody — valueNumeric rejects non-finite values", () => {
  it("accepts a valid finite numeric value", () => {
    const payload = { ...validCreate(), valueNumeric: 42.5 };
    expect(CreateStatementBody.safeParse(payload).success).toBe(true);
  });

  it("accepts null (value is optional)", () => {
    const payload = { ...validCreate(), valueNumeric: null };
    expect(CreateStatementBody.safeParse(payload).success).toBe(true);
  });

  it("accepts undefined (field is optional)", () => {
    const payload = { ...validCreate() };
    expect(CreateStatementBody.safeParse(payload).success).toBe(true);
  });

  it("rejects Infinity", () => {
    const payload = { ...validCreate(), valueNumeric: Infinity };
    const result = CreateStatementBody.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects -Infinity", () => {
    const payload = { ...validCreate(), valueNumeric: -Infinity };
    const result = CreateStatementBody.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects NaN", () => {
    const payload = { ...validCreate(), valueNumeric: NaN };
    const result = CreateStatementBody.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CreateStatementBody — optional string fields reject empty strings
// ---------------------------------------------------------------------------

describe("CreateStatementBody — optional string fields reject empty strings", () => {
  it("rejects empty propertyId", () => {
    const payload = { ...validCreate(), propertyId: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("accepts null propertyId (nullable is allowed)", () => {
    const payload = { ...validCreate(), propertyId: null };
    expect(CreateStatementBody.safeParse(payload).success).toBe(true);
  });

  it("rejects empty qualifierKey", () => {
    const payload = { ...validCreate(), qualifierKey: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty valueUnit", () => {
    const payload = { ...validCreate(), valueUnit: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty valueText", () => {
    const payload = { ...validCreate(), valueText: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty valueEntityId", () => {
    const payload = { ...validCreate(), valueEntityId: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty valueDate", () => {
    const payload = { ...validCreate(), valueDate: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty validStart", () => {
    const payload = { ...validCreate(), validStart: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty validEnd", () => {
    const payload = { ...validCreate(), validEnd: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty temporalGranularity", () => {
    const payload = { ...validCreate(), temporalGranularity: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty attributedTo", () => {
    const payload = { ...validCreate(), attributedTo: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty note", () => {
    const payload = { ...validCreate(), note: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty sourceFactKey", () => {
    const payload = { ...validCreate(), sourceFactKey: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty claimCategory", () => {
    const payload = { ...validCreate(), claimCategory: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty verdict", () => {
    const payload = { ...validCreate(), verdict: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });

  it("rejects empty verdictModel", () => {
    const payload = { ...validCreate(), verdictModel: "" };
    expect(CreateStatementBody.safeParse(payload).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PatchStatementBody — optional string fields reject empty strings
// ---------------------------------------------------------------------------

describe("PatchStatementBody — optional string fields reject empty strings", () => {
  it("accepts empty patch (no-op update)", () => {
    expect(PatchStatementBody.safeParse({}).success).toBe(true);
  });

  it("accepts a valid status update", () => {
    expect(PatchStatementBody.safeParse({ status: "retracted" }).success).toBe(true);
  });

  it("rejects empty statementText", () => {
    expect(PatchStatementBody.safeParse({ statementText: "" }).success).toBe(false);
  });

  it("rejects empty verdict", () => {
    expect(PatchStatementBody.safeParse({ verdict: "" }).success).toBe(false);
  });

  it("accepts null verdict (clearing a verdict)", () => {
    expect(PatchStatementBody.safeParse({ verdict: null }).success).toBe(true);
  });

  it("rejects empty archiveReason", () => {
    expect(PatchStatementBody.safeParse({ archiveReason: "" }).success).toBe(false);
  });

  it("accepts null archiveReason", () => {
    expect(PatchStatementBody.safeParse({ archiveReason: null }).success).toBe(true);
  });

  it("rejects empty note", () => {
    expect(PatchStatementBody.safeParse({ note: "" }).success).toBe(false);
  });

  it("rejects empty verdictModel", () => {
    expect(PatchStatementBody.safeParse({ verdictModel: "" }).success).toBe(false);
  });

  it("rejects Infinity for verdictScore", () => {
    expect(PatchStatementBody.safeParse({ verdictScore: Infinity }).success).toBe(false);
  });

  it("rejects NaN for verdictScore", () => {
    expect(PatchStatementBody.safeParse({ verdictScore: NaN }).success).toBe(false);
  });

  it("accepts null verdictScore (clearing a score)", () => {
    expect(PatchStatementBody.safeParse({ verdictScore: null }).success).toBe(true);
  });

  it("accepts a valid verdictScore in range", () => {
    expect(PatchStatementBody.safeParse({ verdictScore: 0.75 }).success).toBe(true);
  });
});
