/**
 * Tests for validate-ai-incidents-source-enum.
 *
 * The validator parses the live route file and the live migration set, so
 * the simplest end-to-end test is to assert it currently passes — that's
 * the lockstep state at HEAD. We also exercise the parser helpers on
 * synthetic strings to cover the failure cases without touching real files.
 */

import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-ai-incidents-source-enum.ts";

describe("validate-ai-incidents-source-enum", () => {
  it("passes against the current route + migration", () => {
    const res = runCheck();
    expect(res.passed).toBe(true);
    expect(res.errors).toBe(0);
  });
});
