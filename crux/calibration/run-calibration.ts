/**
 * Calibration Runner (QUA-635)
 *
 * Replays the calibration corpus through the production record-sourcing
 * prompt against a specified model (haiku or sonnet) and writes results
 * to a JSON file. Each item's result includes the LLM verdict, confidence,
 * extracted_value, reasoning, latency, and token usage.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod pnpm tsx crux/calibration/run-calibration.ts --model=haiku
 *   WIKI_SERVER_ENV=prod pnpm tsx crux/calibration/run-calibration.ts --model=sonnet
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createLlmClient, callLlm } from '../lib/llm.ts';
import { MODELS } from '../lib/anthropic.ts';
import { parseJsonResponse } from '../lib/anthropic.ts';
import { buildRecordSourcingPrompt } from '../lib/sourcing/item-verifier.ts';
import { fetchSourceContent } from '../lib/sourcing/source-fetcher.ts';
import type { RecordItemData } from '../lib/sourcing/orchestrator-types.ts';
import type { RecordType } from '../../apps/wiki-server/src/api-types.ts';

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(): { model: 'haiku' | 'sonnet'; limit?: number } {
  const args = process.argv.slice(2);
  let model: 'haiku' | 'sonnet' = 'haiku';
  let limit: number | undefined;
  for (const a of args) {
    if (a.startsWith('--model=')) {
      const v = a.slice('--model='.length);
      if (v !== 'haiku' && v !== 'sonnet') {
        throw new Error(`Unknown model: ${v}. Use --model=haiku or --model=sonnet`);
      }
      model = v;
    } else if (a.startsWith('--limit=')) {
      limit = Number(a.slice('--limit='.length));
    }
  }
  return { model, limit };
}

// ── Pricing (USD per 1M tokens; approximate) ────────────────────────

const PRICING: Record<'haiku' | 'sonnet', { inputPerMTok: number; outputPerMTok: number }> = {
  // Claude Haiku 4.5: $1 / $5 per 1M tokens (Anthropic public pricing)
  haiku: { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  // Claude Sonnet 4.6: $3 / $15 per 1M tokens (Anthropic public pricing)
  sonnet: { inputPerMTok: 3.0, outputPerMTok: 15.0 },
};

// ── Corpus types (keep in sync with build-corpus.ts) ───────────────

interface CorpusItem {
  id: string;
  label: 'true' | 'false';
  expectedVerdict: 'confirmed' | 'contradicted' | 'unverifiable';
  recordType: 'personnel' | 'publication' | 'funding-round';
  recordId: string;
  entityDisplayName: string;
  description: string;
  fields: Record<string, string | number | null>;
  sourceUrl: string;
  mutation?: {
    kind: string; field: string;
    originalValue: string | number | null;
    mutatedValue: string | number | null;
    note: string;
  };
}

interface RunResult {
  itemId: string;
  label: 'true' | 'false';
  recordType: string;
  description: string;
  sourceUrl: string;
  verdict: string | null;            // parsed from LLM
  confidence: number | null;
  extractedValue: string;
  reasoning: string;
  rawResponse?: string;
  /** Whether extractedValue contains a substring (>= 40 chars) that appears in source_content */
  quoteFidelityHit: boolean | null;
  /** Longest substring of extracted_value (length >= 40) that appears verbatim in source text. */
  quoteFidelityExample: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

// ── Quote fidelity scorer ──────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Find the longest substring of `extracted` (length ≥ 40) that appears in
 * `sourceText`. Uses a simple sliding-window approach — adequate for a 100-item
 * corpus. Returns null if no substring ≥ 40 chars matches.
 */
function longestSharedSubstring(extracted: string, sourceText: string, minLen = 40): string | null {
  const e = normalize(extracted);
  const s = normalize(sourceText);
  if (e.length < minLen || s.length < minLen) return null;
  // Try to find any contiguous window of length >= minLen from e that appears in s.
  // Start with the longest-possible and shrink.
  for (let len = Math.min(e.length, 200); len >= minLen; len -= 10) {
    for (let i = 0; i + len <= e.length; i += 5) {
      const window = e.slice(i, i + len);
      if (s.includes(window)) return window;
    }
  }
  return null;
}

// ── Build a VerifyItem-shaped input for the prompt ────────────────

function buildRecordItemData(item: CorpusItem): RecordItemData {
  return {
    kind: 'record',
    recordType: item.recordType as RecordType,
    recordId: item.recordId,
    fields: item.fields,
    entityId: null,
    displayName: item.description,
    entityDisplayName: item.entityDisplayName,
  };
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const { model, limit } = parseArgs();
  const corpusPath = new URL('./data/corpus.json', import.meta.url).pathname;
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
    items: CorpusItem[];
  };
  const items = limit ? corpus.items.slice(0, limit) : corpus.items;
  console.log(`Loaded ${items.length} items. Model: ${model} → ${MODELS[model]}`);

  const client = createLlmClient();
  const results: RunResult[] = [];
  const modelPricing = PRICING[model];

  // Track total cost
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let processed = 0;

  for (const item of items) {
    processed++;
    const start = Date.now();
    try {
      // Fetch source content (uses citation_content cache — same path production uses).
      const fetchResult = await fetchSourceContent(item.sourceUrl, undefined, '[calib]');
      if (!fetchResult.content) {
        results.push({
          itemId: item.id,
          label: item.label,
          recordType: item.recordType,
          description: item.description,
          sourceUrl: item.sourceUrl,
          verdict: null,
          confidence: null,
          extractedValue: '',
          reasoning: '',
          quoteFidelityHit: null,
          quoteFidelityExample: null,
          latencyMs: Date.now() - start,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          error: `fetchSourceContent: ${fetchResult.errorType ?? 'no_content'}`,
        });
        continue;
      }

      // Build the prompt using the exact production builder.
      const prompt = buildRecordSourcingPrompt(
        buildRecordItemData(item),
        item.description,
        fetchResult.content,
      );

      // Call the model.
      const llmResult = await callLlm(client, prompt, {
        model: MODELS[model],
        maxTokens: 500,
        temperature: 0,
        retryLabel: `calib-${item.id}`,
      });

      const raw = parseJsonResponse(llmResult.text);
      const verdict = (raw as { verdict?: string }).verdict ?? null;
      const confidence = (raw as { confidence?: number }).confidence ?? null;
      const extractedValue = (raw as { extracted_value?: string }).extracted_value ?? '';
      const reasoning = (raw as { reasoning?: string }).reasoning ?? '';

      // Quote-fidelity check.
      const quoteMatch = longestSharedSubstring(extractedValue, fetchResult.content);

      const inputTok = llmResult.usage?.input_tokens ?? 0;
      const outputTok = llmResult.usage?.output_tokens ?? 0;
      const cost = (inputTok / 1e6) * modelPricing.inputPerMTok
        + (outputTok / 1e6) * modelPricing.outputPerMTok;

      totalInputTokens += inputTok;
      totalOutputTokens += outputTok;
      totalCost += cost;

      results.push({
        itemId: item.id,
        label: item.label,
        recordType: item.recordType,
        description: item.description,
        sourceUrl: item.sourceUrl,
        verdict,
        confidence,
        extractedValue,
        reasoning,
        rawResponse: llmResult.text.slice(0, 2000),
        quoteFidelityHit: quoteMatch != null,
        quoteFidelityExample: quoteMatch,
        latencyMs: Date.now() - start,
        inputTokens: inputTok,
        outputTokens: outputTok,
        costUsd: cost,
      });

      if (processed % 10 === 0) {
        console.log(`  [${processed}/${items.length}] last: ${item.label}→${verdict} (conf=${confidence}) cost=$${cost.toFixed(4)}`);
      }
    } catch (e) {
      results.push({
        itemId: item.id,
        label: item.label,
        recordType: item.recordType,
        description: item.description,
        sourceUrl: item.sourceUrl,
        verdict: null,
        confidence: null,
        extractedValue: '',
        reasoning: '',
        quoteFidelityHit: null,
        quoteFidelityExample: null,
        latencyMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: e instanceof Error ? e.message : String(e),
      });
      console.error(`  [${processed}/${items.length}] ERROR on ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const outputPath = new URL(`./data/results-${model}.json`, import.meta.url).pathname;
  writeFileSync(outputPath, JSON.stringify({
    runAt: new Date().toISOString(),
    model,
    modelId: MODELS[model],
    itemsProcessed: results.length,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: totalCost,
    results,
  }, null, 2));

  console.log(`\n✓ Wrote ${results.length} results to ${outputPath}`);
  console.log(`Total cost: $${totalCost.toFixed(4)}  (input: ${totalInputTokens} tok, output: ${totalOutputTokens} tok)`);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
