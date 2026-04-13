/**
 * Concurrency guard for source-check pipelines (QUA-150).
 *
 * On 2026-04-09, running the sourcing orchestrator with `--concurrency=20`
 * overwhelmed the wiki-server with concurrent write requests, causing
 * cascading timeouts and triggering a FortiGuard IPS firewall block.
 *
 * This module centralizes concurrency parsing so every source-check
 * pipeline enforces the same hard cap. Callers pass the user-supplied
 * value (from `--concurrency=N` or similar), and this helper:
 *
 *   1. Falls back to DEFAULT_SOURCING_CONCURRENCY when the input is
 *      missing, unparseable, or below 1.
 *   2. Clamps to the max and logs a warning when the request exceeds it.
 *
 * The cap can be overridden for local experimentation via the
 * `SOURCING_CONCURRENCY_LIMIT` env var (rare — most operators should
 * not need this). The default (10) is 2x the pipeline's default of 5
 * and is the largest value we've seen complete without back-pressure.
 */

export const DEFAULT_SOURCING_CONCURRENCY = 5;

/**
 * Hard upper bound on source-check pipeline concurrency.
 *
 * Reads `SOURCING_CONCURRENCY_LIMIT` at call time so tests can set and
 * unset the env var between assertions. Values < 1 or unparseable fall
 * back to 10, matching the hardcoded baseline before QUA-150.
 */
export function getMaxSourcingConcurrency(): number {
  const override = process.env.SOURCING_CONCURRENCY_LIMIT;
  if (!override) return 10;
  const parsed = Number.parseInt(override, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return parsed;
}

export type WarnFn = (msg: string) => void;

/**
 * Parse a user-supplied concurrency value and clamp it into [1, MAX].
 *
 * - `undefined` / `null` / empty string → DEFAULT_SOURCING_CONCURRENCY
 * - non-numeric / NaN / < 1              → DEFAULT_SOURCING_CONCURRENCY
 * - value > MAX                          → MAX, plus a warning via `warn`
 * - otherwise                            → floored integer value
 *
 * The `warn` callback defaults to writing to stderr so the CLI surfaces
 * the clamp in ordinary terminal runs. Tests pass a collector function
 * to assert on the exact message.
 */
export function clampSourcingConcurrency(
  requested: unknown,
  warn: WarnFn = (msg) => process.stderr.write(`${msg}\n`),
): number {
  if (requested === undefined || requested === null || requested === "") {
    return DEFAULT_SOURCING_CONCURRENCY;
  }

  const parsed =
    typeof requested === "number"
      ? requested
      : Number.parseInt(String(requested), 10);

  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_SOURCING_CONCURRENCY;
  }

  const max = getMaxSourcingConcurrency();
  const floored = Math.floor(parsed);
  if (floored > max) {
    warn(
      `Sourcing concurrency ${floored} exceeds safe cap ${max}; clamping to ${max} to prevent wiki-server overload (QUA-150). ` +
        `Set SOURCING_CONCURRENCY_LIMIT=<n> to override for local testing only.`,
    );
    return max;
  }
  return floored;
}
