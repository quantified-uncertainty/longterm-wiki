/**
 * Pure-logic tests for clampSourcingConcurrency (QUA-150).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  clampSourcingConcurrency,
  DEFAULT_SOURCING_CONCURRENCY,
  MAX_SOURCING_CONCURRENCY,
} from "./concurrency.ts";

describe("clampSourcingConcurrency", () => {
  let warnings: string[];
  const collectWarn = (msg: string) => warnings.push(msg);

  beforeEach(() => {
    warnings = [];
  });

  // ── empty / missing input falls back to default ──

  describe("fallback to default", () => {
    const cases: [string, unknown][] = [
      ["undefined", undefined],
      ["null", null],
      ["empty string", ""],
      ["unparseable 'abc'", "abc"],
      ["0", 0],
      ["negative", -5],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
      // parseInt would have accepted partial parses; Number() rejects.
      ["'20abc' (partial)", "20abc"],
      ["'abc20' (trailing partial)", "abc20"],
    ];

    for (const [label, input] of cases) {
      it(`returns default for ${label}`, () => {
        expect(clampSourcingConcurrency(input, collectWarn)).toBe(
          DEFAULT_SOURCING_CONCURRENCY,
        );
        expect(warnings).toEqual([]);
      });
    }
  });

  // ── values that parse to valid in-range numbers ──

  describe("valid values pass through", () => {
    it("returns 1 for input 1", () => {
      expect(clampSourcingConcurrency(1, collectWarn)).toBe(1);
      expect(warnings).toEqual([]);
    });

    it("returns 5 for input 5 (the default)", () => {
      expect(clampSourcingConcurrency(5, collectWarn)).toBe(5);
      expect(warnings).toEqual([]);
    });

    it("returns MAX for input MAX (at cap, no warning)", () => {
      expect(
        clampSourcingConcurrency(MAX_SOURCING_CONCURRENCY, collectWarn),
      ).toBe(MAX_SOURCING_CONCURRENCY);
      expect(warnings).toEqual([]);
    });

    it("floors decimals: 3.7 → 3", () => {
      expect(clampSourcingConcurrency(3.7, collectWarn)).toBe(3);
      expect(warnings).toEqual([]);
    });

    it("accepts string inputs like '3'", () => {
      expect(clampSourcingConcurrency("3", collectWarn)).toBe(3);
      expect(warnings).toEqual([]);
    });

    it("tolerates leading/trailing whitespace in strings", () => {
      expect(clampSourcingConcurrency("  5  ", collectWarn)).toBe(5);
      expect(warnings).toEqual([]);
    });

    it("accepts scientific notation: '1e1' → 10 (clamped down to MAX)", () => {
      // Number('1e1') === 10. Since MAX is 8, this clamps with a warning.
      // The point of this test is that scientific notation is correctly
      // interpreted by Number() rather than misread as 1 like parseInt would.
      expect(clampSourcingConcurrency("1e1", collectWarn)).toBe(
        MAX_SOURCING_CONCURRENCY,
      );
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("10");
    });

    it("accepts hex notation: '0x8' → 8", () => {
      // Number('0x8') === 8. parseInt('0x8', 10) === 0 would have been a
      // silent downgrade; this asserts we interpret hex correctly.
      expect(clampSourcingConcurrency("0x8", collectWarn)).toBe(8);
      expect(warnings).toEqual([]);
    });
  });

  // ── values above the cap get clamped and warned ──

  describe("clamping above cap", () => {
    it("clamps 20 to MAX and warns (the QUA-150 incident value)", () => {
      expect(clampSourcingConcurrency(20, collectWarn)).toBe(
        MAX_SOURCING_CONCURRENCY,
      );
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("20");
      expect(warnings[0]).toContain(String(MAX_SOURCING_CONCURRENCY));
      expect(warnings[0]).toContain("QUA-150");
    });

    it("clamps a huge input (1000) to MAX and warns", () => {
      expect(clampSourcingConcurrency(1000, collectWarn)).toBe(
        MAX_SOURCING_CONCURRENCY,
      );
      expect(warnings.length).toBe(1);
    });

    it("clamps a string input '50' to MAX and warns", () => {
      expect(clampSourcingConcurrency("50", collectWarn)).toBe(
        MAX_SOURCING_CONCURRENCY,
      );
      expect(warnings.length).toBe(1);
    });

    it("MAX+1 triggers the clamp", () => {
      expect(
        clampSourcingConcurrency(MAX_SOURCING_CONCURRENCY + 1, collectWarn),
      ).toBe(MAX_SOURCING_CONCURRENCY);
      expect(warnings.length).toBe(1);
    });
  });

  // ── no escape hatch via env var ──

  describe("env var override (removed in the review fix)", () => {
    it("ignores SOURCING_CONCURRENCY_LIMIT=1000 (no escape hatch)", () => {
      const prev = process.env.SOURCING_CONCURRENCY_LIMIT;
      process.env.SOURCING_CONCURRENCY_LIMIT = "1000";
      try {
        expect(clampSourcingConcurrency(20, collectWarn)).toBe(
          MAX_SOURCING_CONCURRENCY,
        );
      } finally {
        if (prev === undefined) delete process.env.SOURCING_CONCURRENCY_LIMIT;
        else process.env.SOURCING_CONCURRENCY_LIMIT = prev;
      }
    });
  });

  // ── default warn path ──

  describe("default warn path", () => {
    it("does not throw when the default warn callback is used", () => {
      // Uses process.stderr.write; test just asserts the function runs.
      expect(() => clampSourcingConcurrency(100)).not.toThrow();
      expect(clampSourcingConcurrency(100)).toBe(MAX_SOURCING_CONCURRENCY);
    });
  });
});
