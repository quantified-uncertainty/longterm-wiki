/**
 * Pure-logic tests for clampSourcingConcurrency (QUA-150).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clampSourcingConcurrency,
  getMaxSourcingConcurrency,
  DEFAULT_SOURCING_CONCURRENCY,
} from "./concurrency.ts";

describe("clampSourcingConcurrency", () => {
  let warnings: string[];
  const collectWarn = (msg: string) => warnings.push(msg);

  beforeEach(() => {
    warnings = [];
    delete process.env.SOURCING_CONCURRENCY_LIMIT;
  });

  afterEach(() => {
    delete process.env.SOURCING_CONCURRENCY_LIMIT;
  });

  describe("fallback to default", () => {
    it("returns default when input is undefined", () => {
      expect(clampSourcingConcurrency(undefined, collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });

    it("returns default when input is null", () => {
      expect(clampSourcingConcurrency(null, collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });

    it("returns default when input is empty string", () => {
      expect(clampSourcingConcurrency("", collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });

    it("returns default when input is unparseable ('abc')", () => {
      expect(clampSourcingConcurrency("abc", collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });

    it("returns default for 0", () => {
      expect(clampSourcingConcurrency(0, collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });

    it("returns default for negative", () => {
      expect(clampSourcingConcurrency(-5, collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });

    it("returns default for NaN", () => {
      expect(clampSourcingConcurrency(NaN, collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });

    it("returns default for Infinity", () => {
      expect(clampSourcingConcurrency(Infinity, collectWarn)).toBe(
        DEFAULT_SOURCING_CONCURRENCY,
      );
      expect(warnings).toEqual([]);
    });
  });

  describe("valid values pass through", () => {
    it("returns 1 for input 1", () => {
      expect(clampSourcingConcurrency(1, collectWarn)).toBe(1);
      expect(warnings).toEqual([]);
    });

    it("returns 5 for input 5", () => {
      expect(clampSourcingConcurrency(5, collectWarn)).toBe(5);
      expect(warnings).toEqual([]);
    });

    it("returns 10 for input 10 (at cap, no warning)", () => {
      expect(clampSourcingConcurrency(10, collectWarn)).toBe(10);
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
  });

  describe("clamping above cap", () => {
    it("clamps 20 to 10 and warns (the QUA-150 incident value)", () => {
      expect(clampSourcingConcurrency(20, collectWarn)).toBe(10);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("20");
      expect(warnings[0]).toContain("10");
      expect(warnings[0]).toContain("QUA-150");
    });

    it("clamps a huge input (1000) to 10 and warns", () => {
      expect(clampSourcingConcurrency(1000, collectWarn)).toBe(10);
      expect(warnings.length).toBe(1);
    });

    it("clamps a string input '50' to 10 and warns", () => {
      expect(clampSourcingConcurrency("50", collectWarn)).toBe(10);
      expect(warnings.length).toBe(1);
    });

    it("warning mentions the SOURCING_CONCURRENCY_LIMIT escape hatch", () => {
      clampSourcingConcurrency(50, collectWarn);
      expect(warnings[0]).toContain("SOURCING_CONCURRENCY_LIMIT");
    });
  });

  describe("SOURCING_CONCURRENCY_LIMIT override", () => {
    it("honors a higher limit from env (20)", () => {
      process.env.SOURCING_CONCURRENCY_LIMIT = "20";
      expect(getMaxSourcingConcurrency()).toBe(20);
      expect(clampSourcingConcurrency(15, collectWarn)).toBe(15);
      expect(warnings).toEqual([]);
    });

    it("clamps 25 to 20 when env sets limit to 20", () => {
      process.env.SOURCING_CONCURRENCY_LIMIT = "20";
      expect(clampSourcingConcurrency(25, collectWarn)).toBe(20);
      expect(warnings.length).toBe(1);
    });

    it("falls back to 10 when env value is unparseable", () => {
      process.env.SOURCING_CONCURRENCY_LIMIT = "not-a-number";
      expect(getMaxSourcingConcurrency()).toBe(10);
    });

    it("falls back to 10 when env value is 0 or negative", () => {
      process.env.SOURCING_CONCURRENCY_LIMIT = "0";
      expect(getMaxSourcingConcurrency()).toBe(10);
      process.env.SOURCING_CONCURRENCY_LIMIT = "-1";
      expect(getMaxSourcingConcurrency()).toBe(10);
    });

    it("defaults to 10 when env is unset", () => {
      delete process.env.SOURCING_CONCURRENCY_LIMIT;
      expect(getMaxSourcingConcurrency()).toBe(10);
    });
  });

  describe("default warn path", () => {
    it("does not throw when the default warn callback is used", () => {
      // Covers the line where we fall back to process.stderr.write.
      // The warning goes to stderr but tests run with stderr captured,
      // so this assertion is just "doesn't throw".
      expect(() => clampSourcingConcurrency(100)).not.toThrow();
      expect(clampSourcingConcurrency(100)).toBe(10);
    });
  });
});
