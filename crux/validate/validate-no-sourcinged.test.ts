import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-no-sourcinged.ts";

describe("validate-no-sourcinged", () => {
  it("passes on the current codebase (QUA-897 fix landed)", () => {
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.violations).toEqual([]);
  });
});
