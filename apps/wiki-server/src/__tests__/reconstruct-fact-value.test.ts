import { describe, it, expect } from "vitest";
import { reconstructFactValue } from "../routes/factbase/facts.js";

/**
 * Minimal row shape matching the facts table columns used by reconstructFactValue.
 * Only the fields the function reads are required.
 */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    entityId: "sid_test",
    factId: "f_test",
    label: null,
    value: null,
    numeric: null,
    low: null,
    high: null,
    asOf: null,
    validEnd: null,
    currency: null,
    measure: null,
    subject: null,
    note: null,
    source: null,
    format: null,
    formatDivisor: null,
    sourceQuote: null,
    usdEquivalent: null,
    exchangeRate: null,
    exchangeRateDate: null,
    dollarYear: null,
    syncedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as Parameters<typeof reconstructFactValue>[0];
}

describe("reconstructFactValue", () => {
  // ── Explicit format cases ──────────────────────────────────────

  it("number format returns numeric value", () => {
    const result = reconstructFactValue(makeRow({ format: "number", numeric: 380000000000 }));
    expect(result).toEqual({ type: "number", value: 380000000000 });
  });

  it("text format returns string value", () => {
    const result = reconstructFactValue(makeRow({ format: "text", value: "hello" }));
    expect(result).toEqual({ type: "text", value: "hello" });
  });

  it("range format returns low/high", () => {
    const result = reconstructFactValue(makeRow({ format: "range", low: 100, high: 200 }));
    expect(result).toEqual({ type: "range", low: 100, high: 200 });
  });

  it("boolean format parses 'true'", () => {
    const result = reconstructFactValue(makeRow({ format: "boolean", value: "true" }));
    expect(result).toEqual({ type: "boolean", value: true });
  });

  it("date format returns value", () => {
    const result = reconstructFactValue(makeRow({ format: "date", value: "2026-02" }));
    expect(result).toEqual({ type: "date", value: "2026-02" });
  });

  // ── Null format inference (the bug) ────────────────────────────

  it("null format with numeric column infers number type", () => {
    // This is the exact scenario that caused raw "380000000000" on org pages.
    // Facts synced before the format column was backfilled have format=null
    // but numeric is populated. Without inference, these render as raw text.
    const result = reconstructFactValue(makeRow({
      format: null,
      numeric: 380000000000,
      value: "380000000000",
    }));
    expect(result.type).toBe("number");
    expect(result).toEqual({ type: "number", value: 380000000000 });
  });

  it("null format with low/high columns infers range type", () => {
    const result = reconstructFactValue(makeRow({
      format: null,
      low: 53000000000,
      high: 80000000000,
      value: "53000000000–80000000000",
    }));
    expect(result.type).toBe("range");
    expect(result).toEqual({ type: "range", low: 53000000000, high: 80000000000 });
  });

  it("null format with only value column returns text", () => {
    const result = reconstructFactValue(makeRow({
      format: null,
      value: "San Francisco",
    }));
    expect(result).toEqual({ type: "text", value: "San Francisco" });
  });

  it("null format with null value returns empty text", () => {
    const result = reconstructFactValue(makeRow({ format: null }));
    expect(result).toEqual({ type: "text", value: "" });
  });

  // ── Edge cases ────────────────────────────────────────────────

  it("[object Object] artifacts are sanitized", () => {
    const result = reconstructFactValue(makeRow({ format: null, value: "[object Object]" }));
    expect(result).toEqual({ type: "text", value: "" });
  });

  it("json format parses valid JSON", () => {
    const result = reconstructFactValue(makeRow({ format: "json", value: '{"key":"val"}' }));
    expect(result).toEqual({ type: "json", value: { key: "val" } });
  });

  it("json format falls back to text for invalid JSON", () => {
    const result = reconstructFactValue(makeRow({ format: "json", value: "not json" }));
    expect(result).toEqual({ type: "text", value: "not json" });
  });
});
