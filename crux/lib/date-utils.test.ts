import { describe, it, expect } from "vitest";
import { normalizeDate, normalizeTimestamp } from "./date-utils.ts";

describe("normalizeDate", () => {
  it("returns null for undefined", () => {
    expect(normalizeDate(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeDate("")).toBeNull();
  });

  it("extracts YYYY-MM-DD from a Date object", () => {
    expect(normalizeDate(new Date("2025-06-15T00:00:00Z"))).toBe("2025-06-15");
  });

  it("returns YYYY-MM-DD string as-is", () => {
    expect(normalizeDate("2025-01-15")).toBe("2025-01-15");
  });

  it("extracts date portion from datetime string", () => {
    expect(normalizeDate("2025-12-28 02:55:47")).toBe("2025-12-28");
  });

  it("returns null for unparseable strings", () => {
    expect(normalizeDate("bad-date")).toBeNull();
    expect(normalizeDate("not-a-date")).toBeNull();
  });
});

describe("normalizeTimestamp", () => {
  it("returns null for undefined", () => {
    expect(normalizeTimestamp(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeTimestamp("")).toBeNull();
  });

  it("converts Date object to ISO string", () => {
    expect(normalizeTimestamp(new Date("2025-12-28T02:55:47Z"))).toBe(
      "2025-12-28T02:55:47.000Z"
    );
  });

  it("converts 'YYYY-MM-DD HH:MM:SS' to ISO format", () => {
    expect(normalizeTimestamp("2025-12-28 02:55:47")).toBe(
      "2025-12-28T02:55:47Z"
    );
  });

  it("converts date-only string to midnight UTC", () => {
    expect(normalizeTimestamp("2025-12-28")).toBe("2025-12-28T00:00:00Z");
  });

  it("returns null for unparseable strings", () => {
    expect(normalizeTimestamp("not-a-date")).toBeNull();
  });

  it("handles other parseable date strings via Date constructor", () => {
    const result = normalizeTimestamp("June 15, 2025");
    expect(result).not.toBeNull();
    // The exact output depends on timezone, but it should be a valid ISO string
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
