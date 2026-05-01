import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-table-states.ts";

describe("validate-table-states", () => {
  it("passes on the current codebase (all violations fixed)", () => {
    // Regression guard: if someone adds a bespoke "Loading..." string to a
    // *-table.tsx or page.tsx file outside @/components/ui/table-states.tsx,
    // this test will fail (QUA-1008).
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
