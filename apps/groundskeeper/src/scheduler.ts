import cron from "node-cron";
import type { Config } from "./config.js";
import { sendDiscordNotification } from "./notify.js";
import { recordRun } from "./run-tracker.js";

export type TaskFn = () => Promise<{ success: boolean; summary?: string }>;

interface TaskState {
  name: string;
  consecutiveFailures: number;
  disabled: boolean;
  running: boolean;
}

const taskStates = new Map<string, TaskState>();

function getState(name: string): TaskState {
  let state = taskStates.get(name);
  if (!state) {
    state = { name, consecutiveFailures: 0, disabled: false, running: false };
    taskStates.set(name, state);
  }
  return state;
}

function log(taskName: string, data: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      task: taskName,
      ...data,
    })
  );
}

export function registerTask(
  config: Config,
  name: string,
  schedule: string,
  enabled: boolean,
  fn: TaskFn
): void {
  if (!enabled) {
    log(name, { event: "skipped", reason: "disabled" });
    return;
  }

  if (!cron.validate(schedule)) {
    log(name, { event: "error", reason: `Invalid cron: ${schedule}` });
    return;
  }

  log(name, { event: "registered", schedule });

  cron.schedule(schedule, async () => {
    const state = getState(name);

    // Guard: don't run if already running
    if (state.running) {
      log(name, { event: "skipped", reason: "already running" });
      return;
    }

    // Guard: circuit breaker
    if (state.disabled) {
      log(name, { event: "skipped", reason: "circuit breaker tripped" });
      return;
    }

    state.running = true;
    const start = Date.now();

    try {
      const result = await fn();
      const durationMs = Date.now() - start;

      if (result.success) {
        state.consecutiveFailures = 0;
        log(name, {
          event: "success",
          durationMs,
          summary: result.summary,
        });
      } else {
        state.consecutiveFailures++;
        log(name, {
          event: "failure",
          durationMs,
          consecutiveFailures: state.consecutiveFailures,
          summary: result.summary,
        });

        await sendDiscordNotification(
          config,
          `❌ **${name}** failed (${state.consecutiveFailures}/3): ${result.summary ?? "no details"}`
        );

        // Trip circuit breaker after 3 consecutive failures
        if (state.consecutiveFailures >= 3) {
          state.disabled = true;
          await sendDiscordNotification(
            config,
            `🔴 **Circuit breaker tripped** for **${name}** after 3 consecutive failures. Task disabled until pod restart or manual reset.`
          );
          log(name, { event: "circuit_breaker_tripped" });
        }
      }

      recordRun(config, {
        taskName: name,
        timestamp: new Date().toISOString(),
        durationMs,
        success: result.success,
        summary: result.summary,
      });
    } catch (error) {
      const durationMs = Date.now() - start;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      state.consecutiveFailures++;
      log(name, {
        event: "error",
        durationMs,
        error: errorMessage,
        consecutiveFailures: state.consecutiveFailures,
      });

      await sendDiscordNotification(
        config,
        `❌ **${name}** threw an error (${state.consecutiveFailures}/3): ${errorMessage}`
      );

      if (state.consecutiveFailures >= 3) {
        state.disabled = true;
        await sendDiscordNotification(
          config,
          `🔴 **Circuit breaker tripped** for **${name}** after 3 consecutive failures. Task disabled until pod restart or manual reset.`
        );
        log(name, { event: "circuit_breaker_tripped" });
      }

      recordRun(config, {
        taskName: name,
        timestamp: new Date().toISOString(),
        durationMs,
        success: false,
        error: errorMessage,
      });
    } finally {
      state.running = false;
    }
  });
}

export function resetCircuitBreaker(name: string): boolean {
  const state = taskStates.get(name);
  if (!state) return false;
  state.disabled = false;
  state.consecutiveFailures = 0;
  log(name, { event: "circuit_breaker_reset" });
  return true;
}

export function getTaskStates(): Map<string, TaskState> {
  return taskStates;
}
