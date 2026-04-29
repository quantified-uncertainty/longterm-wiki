/**
 * The three LLM calls the verification pipeline makes against a single source.
 *
 * Each function is a thin wrapper: build the prompt, call the model, parse
 * the response, return `(parsedResult, costUsd)`. On any error we log a
 * warning and return a "no support" / fallback result with cost 0 — the
 * pipeline keeps running rather than halting on a single transient failure.
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

/** Haiku: extract up to 3 verbatim supporting passages, or [] if none. */
export async function extractSupportingQuotes(
  claim: string,
  entityName: string,
  content: string,
): Promise<{ quotes: string[]; cost: number }> {
  const prompt = buildQuoteExtractionPrompt(claim, entityName, content);
  try {
    const { text, cost } = await callLlm(MODELS.haiku, prompt, 400);
    return { quotes: parseQuoteResponse(text) ?? [], cost };
  } catch (err: unknown) {
    console.warn(`  Quote extraction failed (${errMessage(err)})`);
    return { quotes: [], cost: 0 };
  }
}

/** Sonnet: judge whether the supplied verbatim quotes entail the claim. */
export async function verifyEntailment(
  claim: string,
  quotes: string[],
  sourceUrl?: string,
  sourceTitle?: string,
): Promise<{ supports: boolean; cost: number }> {
  const prompt = buildEntailmentPrompt(claim, quotes, sourceUrl, sourceTitle);
  try {
    const { text, cost } = await callLlm(MODELS.sonnet, prompt, 50);
    const supports = parseEntailmentResponse(text);
    return { supports: supports === true, cost };
  } catch (err: unknown) {
    console.warn(`  Entailment check failed (${errMessage(err)})`);
    return { supports: false, cost: 0 };
  }
}

/**
 * Haiku: pick the single matching source that best directly supports the
 * claim. Returns the index plus the call's USD cost. On error or unparseable
 * output, falls back to index 0 so the caller still gets an answer.
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
