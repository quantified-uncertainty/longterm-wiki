import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-url-normalize.ts";

describe("validate-url-normalize (QUA-341)", () => {
  it("passes on the current codebase (no stray URL normalizers)", () => {
    // Regression guard: any new file that defines its own `normalizeUrl`,
    // `normalizeUrlForJoin`, `normalizeUrlForDedup`, `normalizeUrlKey`, or
    // `urlMatches` outside the canonical package and ALLOWLIST will fail this.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
