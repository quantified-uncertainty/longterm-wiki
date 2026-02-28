import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node-cron before importing scheduler
const scheduledCallbacks: Array<() => Promise<void>> = [];
vi.mock("node-cron", () => ({
  default: {
    validate: (expr: string) => expr.includes("*") || /^\d/.test(expr),
    schedule: (_expr: string, fn: () => Promise<void>) => {
      scheduledCallbacks.push(fn);
    },
  },
}));

// Mock notify to prevent actual Discord calls
vi.mock("./notify.js", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue(undefined),
}));

// Mock run-tracker to prevent file writes
vi.mock("./run-tracker.js", () => ({
  recordRun: vi.fn(),
}));

import {
  registerTask,
  resetCircuitBreaker,
  getTaskStates,
  type TaskFn,
} from "./scheduler.js";
import type { Config } from "./config.js";

function makeConfig(): Config {
  return {
    githubAppId: "test",
    githubInstallationId: "test",
    githubAppPrivateKey: "test",
    githubRepo: "test/test",
    wikiServerUrl: "http://localhost:3000",
    discordWebhookUrl: "http://localhost/webhook",
    dailyRunCap: 20,
    runLogPath: "/tmp/test-run-log.json",
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      resolveConflicts: { enabled: false, schedule: "0 */2 * * *" },
      codeReview: { enabled: false, schedule: "0 9 * * 1" },
      issueResponder: { enabled: false, schedule: "*/10 * * * *" },
    },
  };
}

describe("scheduler", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    scheduledCallbacks.length = 0;
    // Clear task states between tests
    getTaskStates().clear();
  });

  describe("registerTask", () => {
    it("does not schedule disabled tasks", () => {
      const fn: TaskFn = vi.fn().mockResolvedValue({ success: true });
      registerTask(config, "disabled-task", "*/5 * * * *", false, fn);
      expect(scheduledCallbacks).toHaveLength(0);
    });

    it("does not schedule tasks with invalid cron", () => {
      const fn: TaskFn = vi.fn().mockResolvedValue({ success: true });
      registerTask(config, "bad-cron", "not a cron expression", true, fn);
      expect(scheduledCallbacks).toHaveLength(0);
    });

    it("schedules enabled tasks with valid cron", () => {
      const fn: TaskFn = vi.fn().mockResolvedValue({ success: true });
      registerTask(config, "test-task", "*/5 * * * *", true, fn);
      expect(scheduledCallbacks).toHaveLength(1);
    });
  });

  describe("circuit breaker", () => {
    it("resets consecutive failures on success", async () => {
      let callCount = 0;
      const fn: TaskFn = vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount <= 2
          ? { success: false, summary: "fail" }
          : { success: true, summary: "ok" };
      });

      registerTask(config, "breaker-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Two failures
      await callback();
      await callback();

      const states = getTaskStates();
      const state = states.get("breaker-test");
      expect(state?.consecutiveFailures).toBe(2);
      expect(state?.disabled).toBe(false);

      // Third call succeeds — resets counter
      await callback();
      expect(state?.consecutiveFailures).toBe(0);
      expect(state?.disabled).toBe(false);
    });

    it("trips after 3 consecutive failures", async () => {
      const fn: TaskFn = vi
        .fn()
        .mockResolvedValue({ success: false, summary: "down" });

      registerTask(config, "trip-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      await callback();
      await callback();
      await callback();

      const state = getTaskStates().get("trip-test");
      expect(state?.disabled).toBe(true);
      expect(state?.consecutiveFailures).toBe(3);
    });

    it("skips execution when circuit breaker is tripped", async () => {
      const fn: TaskFn = vi
        .fn()
        .mockResolvedValue({ success: false, summary: "fail" });

      registerTask(config, "skip-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      expect(fn).toHaveBeenCalledTimes(3);

      // Fourth call should be skipped (breaker tripped)
      await callback();
      expect(fn).toHaveBeenCalledTimes(3); // Not called again
    });

    it("trips on thrown errors too", async () => {
      const fn: TaskFn = vi.fn().mockRejectedValue(new Error("crash"));

      registerTask(config, "error-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      await callback();
      await callback();
      await callback();

      const state = getTaskStates().get("error-test");
      expect(state?.disabled).toBe(true);
    });
  });

  describe("resetCircuitBreaker", () => {
    it("resets a tripped breaker", async () => {
      const fn: TaskFn = vi
        .fn()
        .mockResolvedValue({ success: false, summary: "fail" });

      registerTask(config, "reset-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip breaker
      await callback();
      await callback();
      await callback();
      expect(getTaskStates().get("reset-test")?.disabled).toBe(true);

      // Reset
      const result = resetCircuitBreaker("reset-test");
      expect(result).toBe(true);

      const state = getTaskStates().get("reset-test");
      expect(state?.disabled).toBe(false);
      expect(state?.consecutiveFailures).toBe(0);
    });

    it("returns false for unknown tasks", () => {
      expect(resetCircuitBreaker("nonexistent")).toBe(false);
    });
  });

  describe("concurrent execution guard", () => {
    it("prevents overlapping executions", async () => {
      let resolveFirst: (() => void) | undefined;
      let callCount = 0;

      const fn: TaskFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: hang until we resolve
          return new Promise<{ success: boolean }>((resolve) => {
            resolveFirst = () => resolve({ success: true });
          });
        }
        return Promise.resolve({ success: true });
      });

      registerTask(config, "concurrent-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Start first execution (will hang)
      const first = callback();

      // Attempt second execution while first is running
      await callback();

      // fn should only have been called once (second was skipped)
      expect(fn).toHaveBeenCalledTimes(1);

      // Clean up: resolve first
      resolveFirst?.();
      await first;
    });
  });
});
