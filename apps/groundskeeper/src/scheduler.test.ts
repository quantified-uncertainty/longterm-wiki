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

// Mock wiki-server to capture recordRunToServer calls
const mockRecordRunToServer = vi.fn().mockResolvedValue(undefined);
vi.mock("./wiki-server.js", () => ({
  recordRunToServer: (...args: unknown[]) => mockRecordRunToServer(...args),
  updateActiveAgent: vi.fn().mockResolvedValue(undefined),
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
    circuitBreakerCooldownMs: 60_000, // 1 minute for tests
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
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
    mockRecordRunToServer.mockClear();
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

  describe("half-open recovery", () => {
    it("does not retry before cooldown elapses", async () => {
      const fn: TaskFn = vi
        .fn()
        .mockResolvedValue({ success: false, summary: "fail" });

      registerTask(config, "no-retry-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      expect(fn).toHaveBeenCalledTimes(3);

      const state = getTaskStates().get("no-retry-test")!;
      expect(state.disabled).toBe(true);

      // Advance time by less than cooldown (30s < 60s)
      state.trippedAt = Date.now() - 30_000;

      await callback();
      // Should still be skipped — fn not called again
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("retries after cooldown elapses (half-open probe)", async () => {
      let callCount = 0;
      const fn: TaskFn = vi.fn().mockImplementation(async () => {
        callCount++;
        return { success: false, summary: "still down" };
      });

      registerTask(config, "retry-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      expect(callCount).toBe(3);

      const state = getTaskStates().get("retry-test")!;
      expect(state.disabled).toBe(true);

      // Advance time past cooldown
      state.trippedAt = Date.now() - 61_000;

      await callback();
      // Should have made a probe attempt
      expect(callCount).toBe(4);
      // Probe failed — should still be disabled with refreshed trippedAt
      expect(state.disabled).toBe(true);
      expect(state.trippedAt).toBeGreaterThan(Date.now() - 5_000);
    });

    it("resets breaker on successful probe", async () => {
      let callCount = 0;
      const fn: TaskFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) return { success: false, summary: "down" };
        return { success: true, summary: "recovered" };
      });

      registerTask(config, "recover-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      expect(callCount).toBe(3);

      const state = getTaskStates().get("recover-test")!;
      expect(state.disabled).toBe(true);

      // Advance time past cooldown
      state.trippedAt = Date.now() - 61_000;

      // Probe succeeds
      await callback();
      expect(callCount).toBe(4);
      expect(state.disabled).toBe(false);
      expect(state.trippedAt).toBeNull();
      expect(state.consecutiveFailures).toBe(0);
    });

    it("restarts cooldown on failed probe (error path)", async () => {
      let callCount = 0;
      const fn: TaskFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) return { success: false, summary: "down" };
        throw new Error("probe crash");
      });

      registerTask(config, "probe-error-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();

      const state = getTaskStates().get("probe-error-test")!;
      expect(state.disabled).toBe(true);
      const originalFailures = state.consecutiveFailures;

      // Advance time past cooldown
      state.trippedAt = Date.now() - 61_000;

      // Probe throws
      await callback();
      expect(callCount).toBe(4);
      expect(state.disabled).toBe(true);
      // Failures should not increment during half-open probe
      expect(state.consecutiveFailures).toBe(originalFailures);
      // trippedAt should be refreshed
      expect(state.trippedAt).toBeGreaterThan(Date.now() - 5_000);
    });

    it("sets trippedAt when circuit breaker trips", async () => {
      const fn: TaskFn = vi
        .fn()
        .mockResolvedValue({ success: false, summary: "fail" });

      registerTask(config, "tripped-at-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      const beforeTrip = Date.now();
      await callback();
      await callback();
      await callback();

      const state = getTaskStates().get("tripped-at-test")!;
      expect(state.disabled).toBe(true);
      expect(state.trippedAt).toBeGreaterThanOrEqual(beforeTrip);
      expect(state.trippedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("wiki-server event recording for half-open probes", () => {
    it("records half_open_attempt when probe starts", async () => {
      const fn: TaskFn = vi.fn().mockResolvedValue({ success: false, summary: "down" });

      registerTask(config, "attempt-event-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      mockRecordRunToServer.mockClear();

      const state = getTaskStates().get("attempt-event-test")!;
      // Advance time past cooldown
      state.trippedAt = Date.now() - 61_000;

      // Trigger half-open probe
      await callback();

      // Should have recorded half_open_attempt event
      const attemptCall = mockRecordRunToServer.mock.calls.find(
        (call: unknown[]) => (call[1] as { event: string }).event === "half_open_attempt"
      );
      expect(attemptCall).toBeDefined();
      expect((attemptCall![1] as { taskName: string }).taskName).toBe("attempt-event-test");
    });

    it("records half_open_success when probe succeeds", async () => {
      let callCount = 0;
      const fn: TaskFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) return { success: false, summary: "down" };
        return { success: true, summary: "recovered" };
      });

      registerTask(config, "success-event-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      mockRecordRunToServer.mockClear();

      const state = getTaskStates().get("success-event-test")!;
      // Advance time past cooldown
      state.trippedAt = Date.now() - 61_000;

      // Probe succeeds
      await callback();

      // The main run event should be "half_open_success", not plain "success"
      const runCalls = mockRecordRunToServer.mock.calls.filter(
        (call: unknown[]) => {
          const evt = (call[1] as { event: string }).event;
          return evt === "half_open_success" || evt === "success";
        }
      );
      expect(runCalls.length).toBeGreaterThanOrEqual(1);
      const hasHalfOpenSuccess = runCalls.some(
        (call: unknown[]) => (call[1] as { event: string }).event === "half_open_success"
      );
      expect(hasHalfOpenSuccess).toBe(true);
    });

    it("does not record half_open_success for normal successful runs", async () => {
      const fn: TaskFn = vi.fn().mockResolvedValue({ success: true, summary: "ok" });

      registerTask(config, "normal-success-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      await callback();

      const hasHalfOpenSuccess = mockRecordRunToServer.mock.calls.some(
        (call: unknown[]) => (call[1] as { event: string }).event === "half_open_success"
      );
      expect(hasHalfOpenSuccess).toBe(false);

      // Should have recorded a plain "success" event
      const hasSuccess = mockRecordRunToServer.mock.calls.some(
        (call: unknown[]) => (call[1] as { event: string }).event === "success"
      );
      expect(hasSuccess).toBe(true);
    });
  });

  describe("wiki-server event recording for manual reset", () => {
    it("records circuit_breaker_reset when config is provided", async () => {
      const fn: TaskFn = vi.fn().mockResolvedValue({ success: false, summary: "fail" });

      registerTask(config, "manual-reset-test", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      mockRecordRunToServer.mockClear();

      // Manual reset with config
      resetCircuitBreaker("manual-reset-test", config);

      // Should have recorded circuit_breaker_reset event
      const resetCall = mockRecordRunToServer.mock.calls.find(
        (call: unknown[]) => (call[1] as { event: string }).event === "circuit_breaker_reset"
      );
      expect(resetCall).toBeDefined();
      expect((resetCall![1] as { taskName: string }).taskName).toBe("manual-reset-test");
    });

    it("does not record to wiki-server when config is omitted", async () => {
      const fn: TaskFn = vi.fn().mockResolvedValue({ success: false, summary: "fail" });

      registerTask(config, "no-config-reset", "*/5 * * * *", true, fn);
      const callback = scheduledCallbacks[scheduledCallbacks.length - 1];

      // Trip the breaker
      await callback();
      await callback();
      await callback();
      mockRecordRunToServer.mockClear();

      // Manual reset without config
      resetCircuitBreaker("no-config-reset");

      // Should NOT have recorded circuit_breaker_reset event
      const resetCall = mockRecordRunToServer.mock.calls.find(
        (call: unknown[]) => (call[1] as { event: string }).event === "circuit_breaker_reset"
      );
      expect(resetCall).toBeUndefined();
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
