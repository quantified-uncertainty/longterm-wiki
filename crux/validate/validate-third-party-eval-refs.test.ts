import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-third-party-eval-refs.ts";

describe("validate-third-party-eval-refs", () => {
  it("passes against the canonical sources", async () => {
    const result = await runCheck({ ci: false });
    if (!result.passed) {
      console.log("Findings:", result.findings);
    }
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
