import { describe, it, expect } from "vitest";
import { calculateCost, formatCost } from "./logger.js";

describe("calculateCost", () => {
  it("uses default pricing when no model is provided", () => {
    // Default: input $3.0/M, output $15.0/M
    const cost = calculateCost(1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.0);
  });

  it("uses default pricing when unknown model is provided", () => {
    const cost = calculateCost(1_000_000, 1_000_000, "unknown-model");
    expect(cost).toBeCloseTo(18.0);
  });

  it("uses claude-opus-4-6 pricing (input $5/M, output $25/M)", () => {
    const cost = calculateCost(1_000_000, 1_000_000, "claude-opus-4-6");
    expect(cost).toBeCloseTo(30.0);
  });

  it("uses claude-sonnet-4-20250514 pricing (input $3/M, output $15/M)", () => {
    const cost = calculateCost(1_000_000, 1_000_000, "claude-sonnet-4-20250514");
    expect(cost).toBeCloseTo(18.0);
  });

  it("uses claude-3-5-haiku pricing (input $0.8/M, output $4/M)", () => {
    const cost = calculateCost(1_000_000, 1_000_000, "claude-3-5-haiku-20241022");
    expect(cost).toBeCloseTo(4.8);
  });

  it("returns 0 for zero tokens", () => {
    expect(calculateCost(0, 0)).toBe(0);
    expect(calculateCost(0, 0, "claude-opus-4-6")).toBe(0);
  });

  it("calculates cost proportionally for small token counts", () => {
    // 1000 input tokens at $3/M = $0.003, 500 output at $15/M = $0.0075
    const cost = calculateCost(1_000, 500);
    expect(cost).toBeCloseTo(0.003 + 0.0075);
  });

  it("handles input-only tokens correctly", () => {
    const cost = calculateCost(1_000_000, 0, "claude-opus-4-6");
    expect(cost).toBeCloseTo(5.0);
  });

  it("handles output-only tokens correctly", () => {
    const cost = calculateCost(0, 1_000_000, "claude-opus-4-6");
    expect(cost).toBeCloseTo(25.0);
  });
});

describe("formatCost", () => {
  it("formats costs below $0.01 in cents", () => {
    expect(formatCost(0.001)).toBe("0.10¢");
    expect(formatCost(0.005)).toBe("0.50¢");
    expect(formatCost(0.009999)).toBe("1.00¢");
  });

  it("formats costs of $0.01 or more in dollars", () => {
    expect(formatCost(0.01)).toBe("$0.0100");
    expect(formatCost(0.1234)).toBe("$0.1234");
    expect(formatCost(1.5678)).toBe("$1.5678");
  });

  it("formats zero cost in cents", () => {
    expect(formatCost(0)).toBe("0.00¢");
  });

  it("formats exactly $0.01 in dollars", () => {
    expect(formatCost(0.01)).toBe("$0.0100");
  });

  it("formats large costs correctly", () => {
    expect(formatCost(100)).toBe("$100.0000");
  });
});
