import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-things-denorm-dead.ts";

describe("validate-things-denorm-dead", () => {
  it("passes against the current tree", () => {
    const { passed, violations } = runCheck();
    if (!passed) {
      console.error(violations);
    }
    expect(passed).toBe(true);
    expect(violations).toEqual([]);
  });
});
