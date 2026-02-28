import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  recordRun,
  incrementDailyAiCount,
  getDailyAiCount,
  isDailyCapReached,
  getRecentRuns,
  type RunRecord,
} from "./run-tracker.js";
import type { Config } from "./config.js";

function makeConfig(runLogPath: string): Config {
  return {
    githubAppId: "test",
    githubInstallationId: "test",
    githubAppPrivateKey: "test",
    githubRepo: "test/test",
    wikiServerUrl: "http://localhost:3000",
    discordWebhookUrl: "http://localhost/webhook",
    dailyRunCap: 5,
    runLogPath,
    circuitBreakerCooldownMs: 1_800_000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      resolveConflicts: { enabled: false, schedule: "0 */2 * * *" },
      codeReview: { enabled: false, schedule: "0 9 * * 1" },
      issueResponder: { enabled: false, schedule: "*/10 * * * *" },
    },
  };
}

describe("run-tracker", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "groundskeeper-test-"));
    config = makeConfig(join(tempDir, "run-log.json"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("recordRun", () => {
    it("records a successful run", () => {
      recordRun(config, {
        taskName: "health-check",
        timestamp: new Date().toISOString(),
        durationMs: 100,
        success: true,
        summary: "All good",
      });

      const runs = getRecentRuns(config);
      expect(runs).toHaveLength(1);
      expect(runs[0].taskName).toBe("health-check");
      expect(runs[0].success).toBe(true);
    });

    it("records a failed run with error", () => {
      recordRun(config, {
        taskName: "health-check",
        timestamp: new Date().toISOString(),
        durationMs: 500,
        success: false,
        error: "Connection refused",
      });

      const runs = getRecentRuns(config);
      expect(runs).toHaveLength(1);
      expect(runs[0].success).toBe(false);
      expect(runs[0].error).toBe("Connection refused");
    });

    it("trims to 200 runs maximum", () => {
      for (let i = 0; i < 210; i++) {
        recordRun(config, {
          taskName: "health-check",
          timestamp: new Date().toISOString(),
          durationMs: 10,
          success: true,
          summary: `Run ${i}`,
        });
      }

      const runs = getRecentRuns(config, undefined, 300);
      expect(runs.length).toBeLessThanOrEqual(200);
    });

    it("creates parent directory if missing", () => {
      const nestedPath = join(tempDir, "subdir", "nested", "run-log.json");
      const nestedConfig = makeConfig(nestedPath);

      recordRun(nestedConfig, {
        taskName: "test",
        timestamp: new Date().toISOString(),
        durationMs: 10,
        success: true,
      });

      expect(existsSync(nestedPath)).toBe(true);
    });
  });

  describe("getRecentRuns", () => {
    it("returns empty array when no runs exist", () => {
      const runs = getRecentRuns(config);
      expect(runs).toEqual([]);
    });

    it("filters by task name", () => {
      recordRun(config, {
        taskName: "health-check",
        timestamp: new Date().toISOString(),
        durationMs: 100,
        success: true,
      });
      recordRun(config, {
        taskName: "code-review",
        timestamp: new Date().toISOString(),
        durationMs: 200,
        success: true,
      });
      recordRun(config, {
        taskName: "health-check",
        timestamp: new Date().toISOString(),
        durationMs: 150,
        success: false,
      });

      const healthRuns = getRecentRuns(config, "health-check");
      expect(healthRuns).toHaveLength(2);
      expect(healthRuns.every((r) => r.taskName === "health-check")).toBe(true);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        recordRun(config, {
          taskName: "test",
          timestamp: new Date().toISOString(),
          durationMs: 10,
          success: true,
          summary: `Run ${i}`,
        });
      }

      const runs = getRecentRuns(config, undefined, 3);
      expect(runs).toHaveLength(3);
      // Should return the last 3
      expect(runs[2].summary).toBe("Run 9");
    });
  });

  describe("daily AI count", () => {
    it("starts at zero", () => {
      expect(getDailyAiCount(config)).toBe(0);
    });

    it("increments daily count", () => {
      incrementDailyAiCount(config);
      expect(getDailyAiCount(config)).toBe(1);

      incrementDailyAiCount(config);
      expect(getDailyAiCount(config)).toBe(2);
    });

    it("respects daily cap", () => {
      expect(isDailyCapReached(config)).toBe(false);

      for (let i = 0; i < 5; i++) {
        incrementDailyAiCount(config);
      }
      expect(isDailyCapReached(config)).toBe(true);
    });

    it("cap is not reached at count less than cap", () => {
      for (let i = 0; i < 4; i++) {
        incrementDailyAiCount(config);
      }
      expect(isDailyCapReached(config)).toBe(false);
    });
  });

  describe("corrupted log file", () => {
    it("handles malformed JSON gracefully", () => {
      const { writeFileSync } = require("fs");
      writeFileSync(config.runLogPath, "not valid json{{{", "utf-8");

      // Should not throw — returns empty state
      const runs = getRecentRuns(config);
      expect(runs).toEqual([]);
      expect(getDailyAiCount(config)).toBe(0);
    });
  });
});
