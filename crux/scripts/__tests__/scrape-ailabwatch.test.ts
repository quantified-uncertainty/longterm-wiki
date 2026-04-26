/**
 * Tests for the AI Lab Watch scrape script's pure helpers (QUA-751).
 *
 * `runScrape()` itself is integration-shaped (network + filesystem), so
 * here we cover the helper that gates valid `--wave` input. The rest is
 * covered by `parse-ailabwatch.test.ts` (parser + grades-file builder).
 */

import { describe, it, expect } from "vitest";
import { publishedAtFromWave } from "../scrape-ailabwatch.ts";

describe("publishedAtFromWave", () => {
  it("returns YYYY-MM-01 for a valid YYYY-MM wave slug", () => {
    expect(publishedAtFromWave("2025-09")).toBe("2025-09-01");
    expect(publishedAtFromWave("2024-01")).toBe("2024-01-01");
    expect(publishedAtFromWave("2026-12")).toBe("2026-12-01");
  });

  it("throws on the wrong shape", () => {
    expect(() => publishedAtFromWave("2025")).toThrowError(/--wave must be YYYY-MM/);
    expect(() => publishedAtFromWave("2025-9")).toThrowError(/--wave must be YYYY-MM/);
    expect(() => publishedAtFromWave("Sept 2025")).toThrowError(/--wave must be YYYY-MM/);
    expect(() => publishedAtFromWave("")).toThrowError(/--wave must be YYYY-MM/);
  });

  it("rejects invalid month numbers (00, 13)", () => {
    expect(() => publishedAtFromWave("2025-00")).toThrowError(/month out of range/);
    expect(() => publishedAtFromWave("2025-13")).toThrowError(/month out of range/);
  });

  it("does NOT strip trailing whitespace silently", () => {
    // Trim is the caller's responsibility — a wave with leading/trailing
    // whitespace is almost certainly an arg-parsing bug, not user intent.
    expect(() => publishedAtFromWave(" 2025-09")).toThrowError(/--wave must be YYYY-MM/);
    expect(() => publishedAtFromWave("2025-09 ")).toThrowError(/--wave must be YYYY-MM/);
  });
});
