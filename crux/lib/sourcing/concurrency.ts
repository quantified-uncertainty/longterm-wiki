/**
 * Concurrency guard for sourcing pipelines (QUA-150).
 *
 * On 2026-04-09, running the sourcing orchestrator with `--concurrency=20`
 * overwhelmed the wiki-server with concurrent writes and tripped the
 * FortiGuard IPS firewall. Each orchestrator task fans out to ~4-6
 * wiki-server calls (source fetch + existing-evidence lookup + verdict
 * write + evidence write + optional archive/resource-suggest), so the
 * task-level concurrency ceiling translates to ~5× that number of
 * in-flight HTTP requests.
 *
 * MAX_SOURCING_CONCURRENCY is the task-level hard cap, chosen so peak
 * in-flight request count stays comfortably below the incident level:
 *
 *     max_tasks × ~5 requests/task ≈ MAX_SOURCING_CONCURRENCY × 5
 *     8 × 5 = 40 in-flight  (fix)    vs.    20 × 5 = 100 in-flight  (incident)
 *
 * A proper request-level semaphore in `crux/lib/wiki-server/client.ts`
 * would be a stronger defense — this file only constrains the task
 * dispatch — and is tracked as a QUA-150 follow-up. Until that lands,
 * the task cap is the only thing protecting the wiki-server from
 * runaway fan-out in the orchestrator.
 *
 * There is no environment-variable escape hatch: any override would
 * reopen the exact bug the cap exists to prevent. If a future operator
 * has a legitimate need to raise it (e.g., the wiki-server gets a real
 * rate limiter), update this file in a follow-up PR.
 */

export const DEFAULT_SOURCING_CONCURRENCY = 5;
export const MAX_SOURCING_CONCURRENCY = 8;

export type WarnFn = (msg: string) => void;

/**
 * Parse a user-supplied concurrency value and clamp it into
 * [1, MAX_SOURCING_CONCURRENCY].
 *
 * - `undefined` / `null` / empty string   → DEFAULT_SOURCING_CONCURRENCY
 * - non-numeric / NaN / ±Infinity / < 1   → DEFAULT_SOURCING_CONCURRENCY
 * - value > MAX                           → MAX, plus a warning via `warn`
 * - otherwise                             → floored integer value
 *
 * Parsing uses `Number()`, not `parseInt()`, so strings with non-numeric
 * suffixes (`"20abc"`, `"1e3"` when ambiguous, `"0x10"`) are rejected
 * instead of silently misinterpreted. `parseInt("1e3", 10) === 1` was a
 * specific footgun flagged during review: a user setting "1e3" expects
 * 1000 and would silently get 1.
 *
 * The `warn` callback defaults to writing to stderr so the CLI surfaces
 * the clamp in ordinary terminal runs. Machine-readable callers pass a
 * collector function to capture the message into structured output.
 */
export function clampSourcingConcurrency(
  requested: unknown,
  warn: WarnFn = (msg) => process.stderr.write(`${msg}\n`),
): number {
  if (requested === undefined || requested === null || requested === "") {
    return DEFAULT_SOURCING_CONCURRENCY;
  }

  // Use Number() (not parseInt) so partial-parse strings like "20abc"
  // become NaN and fall through to the default. parseInt("20abc") = 20
  // would silently accept the garbage; Number("20abc") is NaN, which the
  // next guard rejects.
  const parsed =
    typeof requested === "number"
      ? requested
      : Number(String(requested).trim());

  // Number.isFinite rejects both NaN and ±Infinity in a single check.
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SOURCING_CONCURRENCY;
  }

  const floored = Math.floor(parsed);
  if (floored > MAX_SOURCING_CONCURRENCY) {
    warn(
      `Sourcing concurrency ${floored} exceeds safe cap ${MAX_SOURCING_CONCURRENCY}; ` +
        `clamping to ${MAX_SOURCING_CONCURRENCY} to prevent wiki-server overload (QUA-150).`,
    );
    return MAX_SOURCING_CONCURRENCY;
  }
  return floored;
}
