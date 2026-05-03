/**
 * Idle-cycle circuit breaker for the PR patrol daemon.
 *
 * Background (QUA-1071): patrol cycles every `intervalSeconds` even when the
 * PR queue is empty. Each cycle does GraphQL fetches, deploy-health checks,
 * etc. — cheap individually but pointless when there's nothing to do. After
 * `tripThreshold` consecutive no-op cycles the breaker engages and the daemon
 * exponentially backs off the inter-cycle sleep up to `maxSleepSeconds`. Any
 * cycle that does real work (a PR fix, a main-branch fix, a merge enqueue,
 * an undraft) resets the streak and restores `baseSleepSeconds`.
 *
 * The state is intentionally in-memory: a daemon restart resets the streak,
 * which is the correct behavior — restarts imply a new opportunity to find
 * work, and the supervisor's 30s respawn cadence already provides a floor.
 */

export interface IdleTrackerState {
  /** Number of consecutive cycles where no work was done. */
  noOpStreak: number;
}

export interface IdleTrackerConfig {
  /** Streak length at which the breaker engages. AC #4 of QUA-1071: K=20. */
  tripThreshold: number;
  /** Sleep before next cycle when no backoff is active. */
  baseSleepSeconds: number;
  /** Maximum sleep after exponential backoff. Cap so the daemon never goes silent for hours. */
  maxSleepSeconds: number;
}

export interface IdleTrackerStep {
  state: IdleTrackerState;
  /** Sleep duration in seconds before the next cycle. */
  sleepSeconds: number;
  /** True only on the cycle that crossed the threshold (single-shot). */
  justTripped: boolean;
}

export const DEFAULT_TRIP_THRESHOLD = 20;
export const DEFAULT_MAX_SLEEP_SECONDS = 30 * 60;

export function createIdleState(): IdleTrackerState {
  return { noOpStreak: 0 };
}

/**
 * Compute the next state and sleep duration after a cycle.
 *
 * - `didWork = true` resets the streak and uses base sleep.
 * - Below `tripThreshold`: streak increments, sleep stays at base.
 * - At/above `tripThreshold`: sleep doubles for each cycle past the threshold,
 *   capped at `maxSleepSeconds`. Formula: base * 2^(streak - threshold).
 */
export function nextCycle(
  state: IdleTrackerState,
  didWork: boolean,
  config: IdleTrackerConfig,
): IdleTrackerStep {
  if (didWork) {
    return {
      state: { noOpStreak: 0 },
      sleepSeconds: config.baseSleepSeconds,
      justTripped: false,
    };
  }
  const newStreak = state.noOpStreak + 1;
  if (newStreak < config.tripThreshold) {
    return {
      state: { noOpStreak: newStreak },
      sleepSeconds: config.baseSleepSeconds,
      justTripped: false,
    };
  }
  const overshoot = newStreak - config.tripThreshold;
  const desired = config.baseSleepSeconds * Math.pow(2, overshoot);
  // Clamp to [base, max]. Backoff must never shorten the base interval —
  // it can only grow it. This protects against misconfig where
  // baseSleepSeconds > maxSleepSeconds.
  const sleepSeconds = Math.max(
    config.baseSleepSeconds,
    Math.min(desired, config.maxSleepSeconds),
  );
  return {
    state: { noOpStreak: newStreak },
    sleepSeconds,
    justTripped: newStreak === config.tripThreshold,
  };
}
