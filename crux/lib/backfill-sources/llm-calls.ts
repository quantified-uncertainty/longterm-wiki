/**
 * The three LLM calls the verification pipeline makes against a single source.
 *
 * Each function is a thin wrapper: build the prompt, call the model, parse
 * the response, return `(parsedResult, costUsd)`. On any error we log a
 * warning and return a "no support" / fallback result with cost 0 — the
 * pipeline keeps running rather than halting on a single transient failure.
 *
 * Dual-judge: when enabled, the local vLLM server is queried with the same
 * prompt in parallel with Haiku/Sonnet. The vLLM result is returned
 * alongside the primary result for offline comparison only — it never
 * influences accept/reject decisions or DB writes.
 */

import { createLlmClient, streamingCreate, extractText, MODELS } from '../llm.ts';
import { computeUsageCost } from './cost.ts';
import {
  buildQuoteExtractionPrompt,
  parseQuoteResponse,
  buildEntailmentPrompt,
  parseEntailmentResponse,
  buildRankingPrompt,
  parseRankingResponse,
} from './prompts.ts';
import type { RankCandidate } from './types.ts';
import { callVllm, loadVllmConfig, type VllmConfig } from './vllm-client.ts';

let _vllmConfig: VllmConfig | null = null;
function vllmConfig(): VllmConfig {
  if (!_vllmConfig) _vllmConfig = loadVllmConfig();
  return _vllmConfig;
}

/** Parallel vLLM observation for a quote-extraction call (or null if disabled/failed). */
export interface VllmQuoteObservation {
  raw_text: string;
  quotes: string[];
  duration_ms: number;
}

/** Parallel vLLM observation for an entailment call. */
export interface VllmEntailmentObservation {
  raw_text: string;
  /** null when the model's output couldn't be parsed as {"supports": bool}. */
  supports: boolean | null;
  duration_ms: number;
}

/** Haiku: extract up to 3 verbatim supporting passages, or [] if none. */
export async function extractSupportingQuotes(
  claim: string,
  entityName: string,
  content: string,
): Promise<{
  quotes: string[];
  cost: number;
  rawText: string;
  durationMs: number;
  vllm: VllmQuoteObservation | null;
}> {
  const prompt = buildQuoteExtractionPrompt(claim, entityName, content);
  const [haiku, vllm] = await Promise.all([
    callHaikuQuotes(prompt),
    callVllm(prompt, 400, vllmConfig()),
  ]);
  return {
    quotes: haiku.quotes,
    cost: haiku.cost,
    rawText: haiku.rawText,
    durationMs: haiku.durationMs,
    vllm: vllm
      ? {
          raw_text: vllm.text,
          quotes: parseQuoteResponse(vllm.text) ?? [],
          duration_ms: vllm.durationMs,
        }
      : null,
  };
}

async function callHaikuQuotes(
  prompt: string,
): Promise<{ quotes: string[]; cost: number; rawText: string; durationMs: number }> {
  const started = Date.now();
  try {
    const { text, cost } = await callLlm(MODELS.haiku, prompt, 400);
    return {
      quotes: parseQuoteResponse(text) ?? [],
      cost,
      rawText: text,
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    console.warn(`  Quote extraction failed (${errMessage(err)})`);
    return { quotes: [], cost: 0, rawText: '', durationMs: Date.now() - started };
  }
}

/** Sonnet: judge whether the supplied verbatim quotes entail the claim. */
export async function verifyEntailment(
  claim: string,
  quotes: string[],
  sourceUrl?: string,
  sourceTitle?: string,
): Promise<{
  supports: boolean;
  cost: number;
  rawText: string;
  durationMs: number;
  vllm: VllmEntailmentObservation | null;
}> {
  const prompt = buildEntailmentPrompt(claim, quotes, sourceUrl, sourceTitle);
  const [sonnet, vllm] = await Promise.all([
    callSonnetEntailment(prompt),
    callVllm(prompt, 50, vllmConfig()),
  ]);
  return {
    supports: sonnet.supports,
    cost: sonnet.cost,
    rawText: sonnet.rawText,
    durationMs: sonnet.durationMs,
    vllm: vllm
      ? {
          raw_text: vllm.text,
          supports: parseEntailmentResponse(vllm.text),
          duration_ms: vllm.durationMs,
        }
      : null,
  };
}

async function callSonnetEntailment(
  prompt: string,
): Promise<{ supports: boolean; cost: number; rawText: string; durationMs: number }> {
  const started = Date.now();
  try {
    const { text, cost } = await callLlm(MODELS.sonnet, prompt, 50);
    const supports = parseEntailmentResponse(text);
    return {
      supports: supports === true,
      cost,
      rawText: text,
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    console.warn(`  Entailment check failed (${errMessage(err)})`);
    return { supports: false, cost: 0, rawText: '', durationMs: Date.now() - started };
  }
}

/**
 * Haiku: pick the single matching source that best directly supports the
 * claim. Returns the index plus the call's USD cost. On error or unparseable
 * output, falls back to index 0 so the caller still gets an answer.
 *
 * Dual-judge is intentionally NOT applied here — ranking only fires when
 * multiple candidates pass verification (rare), and the comparison signal
 * we care about is on the per-source accept/reject decision.
 */
export async function rankMatchingSources(
  claim: string,
  entityName: string,
  candidates: RankCandidate[],
): Promise<{ index: number; cost: number }> {
  if (candidates.length <= 1) return { index: 0, cost: 0 };

  const prompt = buildRankingPrompt(claim, entityName, candidates);
  try {
    const { text, cost } = await callLlm(MODELS.haiku, prompt, 100);
    const idx = parseRankingResponse(text, candidates.length);
    return { index: idx ?? 0, cost };
  } catch (err: unknown) {
    console.warn(`  Ranking call failed (${errMessage(err)}) — falling back to first match`);
    return { index: 0, cost: 0 };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function callLlm(model: string, prompt: string, maxTokens: number): Promise<{ text: string; cost: number }> {
  const client = createLlmClient();
  const response = await streamingCreate(client, {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  return {
    text: extractText(response),
    cost: computeUsageCost(model, response.usage),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
