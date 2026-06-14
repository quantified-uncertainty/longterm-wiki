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

// Keep in lockstep with the server-side backstop in api-types.ts
// (MAX_LLM_PAYLOAD_REQUEST_BYTES / MAX_LLM_PAYLOAD_RESPONSE_CHARS).
//
// We do NOT truncate: a clipped prompt is useless for replay (you can't
// faithfully re-run a half prompt through a candidate model). Instead, if a
// call exceeds the cap we SKIP capturing it entirely and log — the corpus only
// ever holds complete, replayable rows. The cap is set high so this is rare;
// it's a safety valve against a pathological multi-MB row, not normal clipping.
const MAX_REQUEST_BYTES = 200_000;
const MAX_RESPONSE_CHARS = 200_000;

/** Sample rate from env, clamped to [0, 1]. 0 (or unset/invalid) = capture off. */
function captureRate(): number {
  const raw = process.env.LLM_PAYLOAD_CAPTURE_RATE;
  if (!raw) return 0;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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

    // Skip (don't clip) anything over the cap — a partial prompt can't be
    // replayed faithfully, so we'd rather have no row than a corrupt one.
    if (byteSize(input.request) > MAX_REQUEST_BYTES || input.response.length > MAX_RESPONSE_CHARS) {
      console.warn(
        `[llm-usage] payload skipped (over size cap, kept whole-or-nothing for replay): model=${input.model} flow=${getAmbientContext()?.flow ?? 'none'}`,
      );
      return;
    }

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
