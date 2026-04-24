/**
 * Tests for validate-aiid-no-report-text — the QUA-693 gate check that
 * defends against CC-BY-SA-excluded AIID report bodies sneaking into
 * the DB or ingest code.
 *
 * Runs the real `runCheck()` against the current repo. Passing means the
 * current AIID code path is clean. Failing indicates a real violation —
 * fix the code, don't "fix" the test.
 */

import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-aiid-no-report-text.ts";

describe("validate-aiid-no-report-text", () => {
  it("passes against the current repo (no banned patterns)", () => {
    const result = runCheck();
    if (!result.passed) {
      // Print violations to make CI failures actionable.
      for (const v of result.violations) {
        console.error(`  ${v.file}:${v.line} — ${v.label}: ${v.snippet}`);
      }
    }
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
