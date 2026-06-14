/**
 * LLM payload capture (model-swap eval, step 1b).
 *
 * Captures sampled request/response bodies and ships them to the wiki-server
 * `llm_call_payloads` table so we can later replay the same prompts through
 * candidate models. Tagged with the ambient flow + run id (see
 * ambient-tracker.ts) so each payload joins back to its pipeline run.
 *
 * Design constraints:
 *   - OFF by default. Controlled by LLM_PAYLOAD_CAPTURE_RATE (0..1); 0 = off.
 *     This keeps prod untouched until we deliberately turn capture on to
 *     gather a corpus.
 *   - Best-effort & fire-and-forget. The POST is never awaited in the hot
 *     path and any failure is logged and swallowed — capture must never add
 *     latency to, or break, a real LLM call.
 *   - Bounded. request + response are truncated to a size cap before sending;
 *     `truncated` records whether that happened.
 */

import { recordLlmPayload } from '../wiki-server/llm-payloads.ts';
import { getAmbientContext } from './ambient-tracker.ts';

// No size cap: payloads are stored whole. Postgres text/jsonb handle multi-MB
// values fine, and a clipped prompt is useless for replay — so we'd rather
// store the full thing. Capture is sampled and off by default, so the corpus
// stays bounded by the sample rate, not a per-row clip.

/** Sample rate from env, clamped to [0, 1]. 0 (or unset/invalid) = capture off. */
function captureRate(): number {
  const raw = process.env.LLM_PAYLOAD_CAPTURE_RATE;
  if (!raw) return 0;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

export interface CapturePayloadInput {
  model: string;
  /** The request we sent: system + messages (+ key params). */
  request: Record<string, unknown>;
  /** The model's response text. */
  response: string;
  viaOpenrouter?: boolean;
  label?: string;
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
}

/**
 * Capture one LLM call if sampling is enabled. Returns immediately; the actual
 * POST runs in the background. Safe to call on every LLM call — it self-gates
 * on the sample rate and never throws.
 */
export function capturePayload(input: CapturePayloadInput): void {
  try {
    const rate = captureRate();
    if (rate <= 0) return;
    if (rate < 1 && Math.random() >= rate) return;

    const ctx = getAmbientContext();

    // Fire-and-forget. Never await; swallow all errors.
    void recordLlmPayload({
      runId: ctx?.runId ?? null,
      flow: ctx?.flow ?? null,
      label: input.label ?? null,
      model: input.model,
      viaOpenrouter: input.viaOpenrouter ?? false,
      request: input.request,
      response: input.response,
      tokensInput: input.usage?.input_tokens ?? null,
      tokensOutput: input.usage?.output_tokens ?? null,
    }).then(
      (res) => {
        if (!res.ok) {
          console.warn(`[llm-usage] payload capture POST failed (non-fatal): ${res.message}`);
        }
      },
      (err: unknown) => {
        console.warn(
          `[llm-usage] payload capture threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  } catch (err) {
    console.warn(
      `[llm-usage] capturePayload failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
