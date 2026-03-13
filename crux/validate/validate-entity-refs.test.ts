/**
 * Tests for entity reference integrity validator.
 *
 * Uses subprocess integration tests to verify the validator runs correctly
 * against the real KB data, plus unit tests for edge cases.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

const REPO_ROOT = `${__dirname}/../..`;

function run(cmd: string): { stdout: string; exitCode: number } {
  const fullCmd = `${cmd} 2>&1`;
  try {
    const stdout = execSync(fullCmd, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 60_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || "", exitCode: e.status ?? 1 };
  }
}

describe("validate-entity-refs", () => {
  it(
    "runs successfully in advisory mode (exit 0)",
    () => {
      const result = run(
        "npx tsx crux/validate/validate-entity-refs.ts"
      );
      // Advisory mode should always exit 0 (no threshold)
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Entity Reference Integrity Check");
      expect(result.stdout).toContain("TOTAL");
    },
    60_000
  );

  it(
    "produces valid JSON in --ci mode",
    () => {
      const result = run(
        "npx tsx crux/validate/validate-entity-refs.ts --ci"
      );
      expect(result.exitCode).toBe(0);

      // Filter out any non-JSON lines (warnings from node/kb loader)
      const jsonLines = result.stdout
        .split("\n")
        .filter((l) => l.startsWith("{"));
      expect(jsonLines.length).toBeGreaterThanOrEqual(1);

      const data = JSON.parse(jsonLines[jsonLines.length - 1]);
      expect(data).toHaveProperty("passed", true);
      expect(data).toHaveProperty("totalRecords");
      expect(data).toHaveProperty("totalLinks");
      expect(data).toHaveProperty("validLinks");
      expect(data).toHaveProperty("orphanedLinks");
      expect(data).toHaveProperty("linkRate");
      expect(data).toHaveProperty("byCollection");
      expect(typeof data.totalRecords).toBe("number");
      expect(data.totalRecords).toBeGreaterThan(0);
    },
    60_000
  );

  it(
    "fails when threshold is set impossibly high",
    () => {
      // With threshold=100 and known orphans, it should fail
      const result = run(
        "npx tsx crux/validate/validate-entity-refs.ts --threshold=100"
      );
      // Will fail because current link rate is ~43%
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("below threshold");
    },
    60_000
  );

  it(
    "passes when threshold is set low enough",
    () => {
      const result = run(
        "npx tsx crux/validate/validate-entity-refs.ts --threshold=1"
      );
      expect(result.exitCode).toBe(0);
    },
    60_000
  );
});
