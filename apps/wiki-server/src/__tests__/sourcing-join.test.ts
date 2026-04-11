import { describe, it, expect } from "vitest";
import {
  formatSourcing,
  type VerdictJoinFields,
} from "../routes/shared/sourcing-join.js";

describe("formatSourcing", () => {
  it("returns null when no verdict is present", () => {
    const row: VerdictJoinFields = {
      sourcingVerdict: null,
      sourcingConfidence: null,
      sourcingSourcesChecked: null,
      sourcingCheckedAt: null,
    };
    expect(formatSourcing(row)).toBeNull();
  });

  it("formats a complete verdict row", () => {
    const checkedAt = new Date("2026-04-01T12:00:00Z");
    const row: VerdictJoinFields = {
      sourcingVerdict: "confirmed",
      sourcingConfidence: 0.95,
      sourcingSourcesChecked: 3,
      sourcingCheckedAt: checkedAt,
    };
    const result = formatSourcing(row);
    expect(result).toEqual({
      verdict: "confirmed",
      confidence: 0.95,
      sourcesChecked: 3,
      checkedAt: "2026-04-01T12:00:00.000Z",
    });
  });

  it("defaults sourcesChecked to 0 when null", () => {
    const row: VerdictJoinFields = {
      sourcingVerdict: "partial",
      sourcingConfidence: null,
      sourcingSourcesChecked: null,
      sourcingCheckedAt: null,
    };
    const result = formatSourcing(row);
    expect(result).not.toBeNull();
    expect(result!.sourcesChecked).toBe(0);
    expect(result!.checkedAt).toBeNull();
  });
});

// Note: fetchFieldVerdicts requires a live Drizzle DB connection.
// Its integration behavior is tested via the grants route tests.
// Here we verify the shared formatting utilities are correct, which
// is the unit-testable surface of sourcing-join.ts.
