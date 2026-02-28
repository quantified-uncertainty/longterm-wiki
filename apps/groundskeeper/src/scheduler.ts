import cron from "node-cron";
import type { Config } from "./config.js";
import { sendDiscordNotification } from "./notify.js";
import { recordRun } from "./run-tracker.js";
import { recordRunToServer, updateActiveAgent } from "./wiki-server.js";
import { logger as rootLogger } from "./logger.js";

/** Set by index.ts after registering as an active agent. */
let groundskeeperAgentId: number | null = null;

export function setGroundskeeperAgentId(id: number): void {
  groundskeeperAgentId = id;
}

export type TaskFn = () => Promise<{ success: boolean; summary?: string }>;

interface TaskState {
  name: string;
  consecutiveFailures: number;
  disabled: boolean;
  trippedAt: number | null;
  running: boolean;
}

const taskStates = new Map<string, TaskState>();

function getState(name: string): TaskState {
  let state = taskStates.get(name);
  if (!state) {
    state = { name, consecutiveFailures: 0, disabled: false, trippedAt: null, running: false };
    taskStates.set(name, state);
  }
  return state;
}

export function registerTask(
  config: Config,
  name: string,
  schedule: string,
  enabled: boolean,
  fn: TaskFn
): void {
  const logger = rootLogger.child({ task: name });

  if (!enabled) {
    logger.info({ event: "skipped", reason: "disabled" }, "Task disabled");
    return;
  }

  if (!cron.validate(schedule)) {
    logger.error({ event: "error", reason: `Invalid cron: ${schedule}` }, "Invalid cron schedule");
    return;
  }

  logger.info({ event: "registered", schedule }, "Task registered");

  cron.schedule(schedule, async () => {
    const state = getState(name);

    // Guard: don't run if already running
    if (state.running) {
      logger.warn({ event: "skipped", reason: "already running" }, "Task skipped");
      return;
    }

    // Claim the running lock immediately, before any async work,
    // to prevent concurrent executions during half-open Discord notifications.
    state.running = true;

    // Guard: circuit breaker (with half-open recovery)
    let isHalfOpenProbe = false;
    if (state.disabled) {
      if (
        state.trippedAt == null ||
        Date.now() - state.trippedAt >= config.circuitBreakerCooldownMs
      ) {
        // Half-open: cooldown elapsed, allow one probe attempt
        isHalfOpenProbe = true;
        logger.info({ event: "half_open_attempt" }, "Circuit breaker half-open probe");
        await sendDiscordNotification(
          config,
          `🟡 **${name}** circuit breaker cooldown elapsed — attempting recovery probe...`
        );
      } else {
        logger.warn({ event: "skipped", reason: "circuit breaker tripped" }, "Task skipped");
        state.running = false;
        return;
      }
    }
    const start = Date.now();

    try {
      const result = await fn();
      const durationMs = Date.now() - start;

      if (result.success) {
        if (isHalfOpenProbe) {
          state.disabled = false;
          state.trippedAt = null;
          logger.info({ event: "half_open_success" }, "Half-open probe succeeded");
          await sendDiscordNotification(
            config,
            `🟢 **${name}** recovery probe succeeded — circuit breaker reset automatically.`
          );
        }
        state.consecutiveFailures = 0;
        logger.info({
          event: "success",
          durationMs,
          summary: result.summary,
        }, "Task succeeded");
      } else {
        if (isHalfOpenProbe) {
          // Probe failed — restart cooldown, stay tripped
          state.trippedAt = Date.now();
          logger.error({
            event: "failure",
            durationMs,
            consecutiveFailures: state.consecutiveFailures,
            summary: result.summary,
            halfOpenProbe: true,
          }, "Half-open probe failed");
          await sendDiscordNotification(
            config,
            `🔴 **${name}** recovery probe failed — circuit breaker remains tripped. Will retry after cooldown.`
          );
        } else {
          state.consecutiveFailures++;
          logger.error({
            event: "failure",
            durationMs,
            consecutiveFailures: state.consecutiveFailures,
            summary: result.summary,
          }, "Task failed");

          await sendDiscordNotification(
            config,
            `❌ **${name}** failed (${state.consecutiveFailures}/3): ${result.summary ?? "no details"}`
          );

          // Trip circuit breaker after 3 consecutive failures
          if (state.consecutiveFailures >= 3) {
            state.disabled = true;
            state.trippedAt = Date.now();
            await sendDiscordNotification(
              config,
              `🔴 **Circuit breaker tripped** for **${name}** after 3 consecutive failures. Will auto-retry after cooldown.`
            );
            logger.fatal({ event: "circuit_breaker_tripped" }, "Circuit breaker tripped");
          }
        }
      }

      const runTs = new Date().toISOString();
      const event = result.success ? "success" : "failure";

      recordRun(config, {
        taskName: name,
        timestamp: runTs,
        durationMs,
        success: result.success,
        summary: result.summary,
      });

      // Best-effort: push to wiki-server
      recordRunToServer(config, {
        taskName: name,
        event,
        success: result.success,
        durationMs,
        summary: result.summary,
        consecutiveFailures: state.consecutiveFailures,
        circuitBreakerActive: state.disabled,
        timestamp: runTs,
      }).catch(() => {});

      // Update active agent step + heartbeat
      if (groundskeeperAgentId) {
        updateActiveAgent(config, groundskeeperAgentId, {
          currentStep: `${name}: ${result.summary ?? event} (${Math.round(durationMs / 1000)}s)`,
        }).catch(() => {});
      }

      // Circuit breaker event — only on a fresh trip, not on failed half-open probes
      if (state.disabled && !isHalfOpenProbe) {
        recordRunToServer(config, {
          taskName: name,
          event: "circuit_breaker_tripped",
          success: false,
          consecutiveFailures: state.consecutiveFailures,
          circuitBreakerActive: true,
          timestamp: runTs,
        }).catch(() => {});
      }
    } catch (error) {
      const durationMs = Date.now() - start;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (isHalfOpenProbe) {
        // Probe threw — restart cooldown, stay tripped
        state.trippedAt = Date.now();
        logger.error({
          event: "error",
          durationMs,
          error: errorMessage,
          consecutiveFailures: state.consecutiveFailures,
          halfOpenProbe: true,
        }, "Half-open probe threw an error");
        await sendDiscordNotification(
          config,
          `🔴 **${name}** recovery probe threw an error — circuit breaker remains tripped. Will retry after cooldown.`
        );
      } else {
        state.consecutiveFailures++;
        logger.error({
          event: "error",
          durationMs,
          error: errorMessage,
          consecutiveFailures: state.consecutiveFailures,
        }, "Task threw an error");

        await sendDiscordNotification(
          config,
          `❌ **${name}** threw an error (${state.consecutiveFailures}/3): ${errorMessage}`
        );

        if (state.consecutiveFailures >= 3) {
          state.disabled = true;
          state.trippedAt = Date.now();
          await sendDiscordNotification(
            config,
            `🔴 **Circuit breaker tripped** for **${name}** after 3 consecutive failures. Will auto-retry after cooldown.`
          );
          logger.fatal({ event: "circuit_breaker_tripped" }, "Circuit breaker tripped");
        }
      }

      const errorTs = new Date().toISOString();

      recordRun(config, {
        taskName: name,
        timestamp: errorTs,
        durationMs,
        success: false,
        error: errorMessage,
      });

      // Best-effort: push to wiki-server
      recordRunToServer(config, {
        taskName: name,
        event: "error",
        success: false,
        durationMs,
        errorMessage,
        consecutiveFailures: state.consecutiveFailures,
        circuitBreakerActive: state.disabled,
        timestamp: errorTs,
      }).catch(() => {});

      if (groundskeeperAgentId) {
        updateActiveAgent(config, groundskeeperAgentId, {
          currentStep: `${name}: ERROR — ${errorMessage.slice(0, 100)}`,
        }).catch(() => {});
      }
    } finally {
      state.running = false;
    }
  });
}

export function resetCircuitBreaker(name: string): boolean {
  const state = taskStates.get(name);
  if (!state) return false;
  state.disabled = false;
  state.trippedAt = null;
  state.consecutiveFailures = 0;
  rootLogger.child({ task: name }).info({ event: "circuit_breaker_reset" }, "Circuit breaker reset");
  return true;
}

export function getTaskStates(): Map<string, TaskState> {
  return taskStates;
}
