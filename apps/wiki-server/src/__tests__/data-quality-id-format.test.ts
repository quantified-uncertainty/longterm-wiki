/**
 * Tests for captureIdFormatAudit (QUA-407 / QUA-439).
 *
 * The ID format audit is a pure transform over a single aggregation row from
 * `things`. These tests mock the transaction + execute path to return a fixed
 * row and assert the transform produces the expected IdFormatAudit shape.
 *
 * Covered cases:
 *   1. all-zero           — empty DB / no matches
 *   2. mixed              — canonical + legacy + `other` on both tables
 *   3. legacy-only        — pure legacy counts (pre-QUA-43 baseline)
 *   4. null-safe empty    — no rows returned from the CTE at all
 */

import { describe, it, expect, vi } from "vitest";
import { mockDbModule } from "./test-utils.js";

vi.mock("../db.js", () =>
  mockDbModule((query, _params) => {
    const q = query.toLowerCase();
    // SET LOCAL — no rows
    if (q.includes("set local")) return [];
    // The facts_audit / resources_audit CTE pair is the only other SELECT
    // in this test path
    if (q.includes("facts_audit") || q.includes("resources_audit")) {
      return (globalThis as any).__ID_AUDIT_ROWS__ ?? [];
    }
    return [];
  }),
);

async function runCapture(row: Record<string, string> | null) {
  (globalThis as any).__ID_AUDIT_ROWS__ = row ? [row] : [];
  const { captureIdFormatAudit } = await import(
    "../routes/operational/data-quality.js"
  );
  const { getDrizzleDb } = await import("../db.js");
  return captureIdFormatAudit(getDrizzleDb());
}

describe("captureIdFormatAudit", () => {
  it("all-zero: empty DB returns zero buckets but valid shape", async () => {
    const result = await runCapture({
      facts_canonical_f: "0",
      facts_canonical_sid: "0",
      facts_legacy_hex8: "0",
      facts_legacy_alnum10: "0",
      facts_legacy_hex16: "0",
      facts_total: "0",
      resources_canonical_f: "0",
      resources_canonical_sid: "0",
      resources_legacy_hex8: "0",
      resources_legacy_alnum10: "0",
      resources_legacy_hex16: "0",
      resources_total: "0",
    });
    expect(result.totals).toEqual({
      canonical_f: 0,
      canonical_sid: 0,
      legacy_hex8: 0,
      legacy_alnum10: 0,
      legacy_hex16: 0,
      other: 0,
    });
    expect(result.bySourceTable.facts.other).toBe(0);
    expect(result.bySourceTable.resources.other).toBe(0);
    expect(typeof result.scannedAt).toBe("string");
    expect(() => new Date(result.scannedAt)).not.toThrow();
  });

  it("mixed: canonical + legacy + other computed correctly per table", async () => {
    const result = await runCapture({
      facts_canonical_f: "1000",
      facts_canonical_sid: "0",
      facts_legacy_hex8: "50",
      facts_legacy_alnum10: "20",
      facts_legacy_hex16: "0",
      facts_total: "1080", // => other = 10
      resources_canonical_f: "0",
      resources_canonical_sid: "500",
      resources_legacy_hex8: "0",
      resources_legacy_alnum10: "0",
      resources_legacy_hex16: "30",
      resources_total: "532", // => other = 2
    });
    expect(result.bySourceTable.facts).toEqual({
      canonical_f: 1000,
      canonical_sid: 0,
      legacy_hex8: 50,
      legacy_alnum10: 20,
      legacy_hex16: 0,
      other: 10,
    });
    expect(result.bySourceTable.resources).toEqual({
      canonical_f: 0,
      canonical_sid: 500,
      legacy_hex8: 0,
      legacy_alnum10: 0,
      legacy_hex16: 30,
      other: 2,
    });
    // totals merge both tables
    expect(result.totals.canonical_f).toBe(1000);
    expect(result.totals.canonical_sid).toBe(500);
    expect(result.totals.legacy_hex8).toBe(50);
    expect(result.totals.legacy_alnum10).toBe(20);
    expect(result.totals.legacy_hex16).toBe(30);
    expect(result.totals.other).toBe(12);
  });

  it("legacy-only: pre-QUA-43 baseline with no canonical counts", async () => {
    const result = await runCapture({
      facts_canonical_f: "0",
      facts_canonical_sid: "0",
      facts_legacy_hex8: "200",
      facts_legacy_alnum10: "150",
      facts_legacy_hex16: "0",
      facts_total: "350",
      resources_canonical_f: "0",
      resources_canonical_sid: "0",
      resources_legacy_hex8: "0",
      resources_legacy_alnum10: "0",
      resources_legacy_hex16: "400",
      resources_total: "400",
    });
    expect(result.totals.canonical_f).toBe(0);
    expect(result.totals.canonical_sid).toBe(0);
    expect(result.totals.legacy_hex8).toBe(200);
    expect(result.totals.legacy_hex16).toBe(400);
    expect(result.totals.other).toBe(0);
  });

  it("null-safe: no rows returned produces zeroed shape, not undefined", async () => {
    const result = await runCapture(null);
    expect(result.bySourceTable.facts).toEqual({
      canonical_f: 0,
      canonical_sid: 0,
      legacy_hex8: 0,
      legacy_alnum10: 0,
      legacy_hex16: 0,
      other: 0,
    });
    expect(result.bySourceTable.resources).toEqual({
      canonical_f: 0,
      canonical_sid: 0,
      legacy_hex8: 0,
      legacy_alnum10: 0,
      legacy_hex16: 0,
      other: 0,
    });
    expect(result.totals.other).toBe(0);
  });

  it("legacy_alnum10 regex matches naked 10-char alnums (QUA-499)", async () => {
    const { ID_FORMAT_REGEXES } = await import(
      "../routes/operational/data-quality.js"
    );
    const re = new RegExp(ID_FORMAT_REGEXES.legacy_alnum10);
    // The canonical example from the ticket — has upper + lower, no digit.
    expect(re.test("gNRivVEYsw")).toBe(true);
    // Mixed-case with digit still matches.
    expect(re.test("aB3cD4eF5g")).toBe(true);
    // All-lowercase alnum.
    expect(re.test("abcdefghij")).toBe(true);
    // Prefixed canonical forms must NOT match (length > 10).
    expect(re.test("f_gNRivVEYsw")).toBe(false);
    expect(re.test("sid_gNRivVEY")).toBe(false);
    // Pure hex8 (8 chars) — wrong length.
    expect(re.test("abc12345")).toBe(false);
    // Pure hex16 (16 chars) — wrong length.
    expect(re.test("abcdef0123456789")).toBe(false);
    // Non-alnum rejected.
    expect(re.test("gNRivVEY-w")).toBe(false);
    // 9 or 11 chars rejected.
    expect(re.test("gNRivVEYs")).toBe(false);
    expect(re.test("gNRivVEYsww")).toBe(false);
  });

  it("negative-safe: named sum > total still produces non-negative other", async () => {
    // Degenerate case — shouldn't happen in prod but we clamp with Math.max(0, ...)
    const result = await runCapture({
      facts_canonical_f: "100",
      facts_canonical_sid: "0",
      facts_legacy_hex8: "0",
      facts_legacy_alnum10: "0",
      facts_legacy_hex16: "0",
      facts_total: "50", // less than named sum
      resources_canonical_f: "0",
      resources_canonical_sid: "0",
      resources_legacy_hex8: "0",
      resources_legacy_alnum10: "0",
      resources_legacy_hex16: "0",
      resources_total: "0",
    });
    expect(result.bySourceTable.facts.other).toBeGreaterThanOrEqual(0);
  });
});
