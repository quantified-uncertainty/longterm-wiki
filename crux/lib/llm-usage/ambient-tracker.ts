/**
 * Ambient cost tracker (QUA — model-swap eval, step 1).
 *
 * Threads a per-run CostTracker through the call stack via AsyncLocalStorage
 * so that LLM helpers (streamingCreate, the OpenRouter path, and direct
 * `client.messages.create` calls) can record every API call's real spend
 * WITHOUT each call site passing a tracker explicitly.
 *
 * `withPipelineRun` sets the ambient tracker for the duration of a pipeline
 * body; its existing `/end` path then persists the totals into the
 * `pipeline_runs` cost columns. The result: every pipeline-wrapped flow gets
 * its real per-flow spend recorded automatically, which is what the
 * model-swap ranking step needs.
 *
 * FAIL-SAFE CONTRACT: instrumentation must NEVER break a real LLM call.
 * `recordAmbient` swallows and logs its own errors; callers wrap it in the
 * same spirit. A logging failure logs and lets the call proceed.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { CostTracker } from '../cost-tracker.ts';

const storage = new AsyncLocalStorage<CostTracker>();

/** Run `fn` with `tracker` set as the ambient tracker for the async context. */
export function runWithAmbientTracker<T>(tracker: CostTracker, fn: () => T): T {
  return storage.run(tracker, fn);
}

/** The ambient tracker for the current async context, or undefined. */
export function getAmbientTracker(): CostTracker | undefined {
  return storage.getStore();
}

/**
 * Record a completed LLM call into the ambient tracker, if one is set.
 *
 * Best-effort: any failure (pricing lookup, unexpected usage shape) is logged
 * and swallowed so instrumentation can never break the underlying call.
 * No-op when there's no ambient tracker (e.g. a one-off CLI call outside any
 * pipeline) — such calls simply aren't attributed.
 */
export function recordAmbient(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
  label?: string,
): void {
  try {
    const tracker = storage.getStore();
    if (!tracker) return;
    tracker.record(model, usage, label);
  } catch (err) {
    console.warn(
      `[llm-usage] recordAmbient failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Record an externally-priced call (e.g. OpenRouter reports cost directly)
 * into the ambient tracker, if one is set. Best-effort, same contract as
 * {@link recordAmbient}.
 */
export function recordAmbientExternalCost(model: string, cost: number, label: string): void {
  try {
    const tracker = storage.getStore();
    if (!tracker) return;
    tracker.recordExternalCost(model, cost, label);
  } catch (err) {
    console.warn(
      `[llm-usage] recordAmbientExternalCost failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
