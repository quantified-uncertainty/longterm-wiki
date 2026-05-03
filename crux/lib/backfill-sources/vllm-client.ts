/**
 * Minimal OpenAI-compatible client for the local vLLM server used as a
 * second judge alongside Haiku. The vLLM result is recorded for offline
 * comparison only — Haiku's result still drives every accept/reject and
 * every DB write. Failures here must never break the pipeline.
 */

const DEFAULT_BASE_URL = 'http://localhost:8000/v1';
const DEFAULT_MODEL = '/root/model-gptq';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface VllmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export function loadVllmConfig(): VllmConfig {
  const enabled = process.env.BACKFILL_DUAL_JUDGE !== '0';
  return {
    enabled,
    baseUrl: process.env.VLLM_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.VLLM_MODEL ?? DEFAULT_MODEL,
    timeoutMs: Number(process.env.VLLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

export interface VllmResult {
  text: string;
  durationMs: number;
}

export async function callVllm(
  prompt: string,
  maxTokens: number,
  config: VllmConfig,
): Promise<VllmResult | null> {
  if (!config.enabled) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        // vLLM honors OpenAI's JSON-mode hint and constrains output to a
        // single valid JSON object — prevents unescaped inner quotes from
        // breaking our `extractJsonObject` parser (seen on quotes that
        // legitimately contain `"`).
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`  [vllm] HTTP ${res.status} (${(Date.now() - started) | 0}ms)`);
      return null;
    }
    const body = await res.json() as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content ?? '';
    return { text, durationMs: Date.now() - started };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [vllm] call failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}
