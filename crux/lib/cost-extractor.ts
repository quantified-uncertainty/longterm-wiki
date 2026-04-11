/**
 * Cost Extractor — compute total session cost from Claude Code JSONL transcripts.
 *
 * Reads assistant messages with usage data and sums costs using the pricing module.
 * Used by session-finalize to auto-populate the cost field.
 */

import { calculateCost, type ExtendedUsage } from './pricing.ts';

/** Usage stats from a single assistant message in a JSONL transcript. */
export interface TranscriptUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Aggregated cost result from a transcript. */
export interface CostResult {
  /** Total cost in USD. */
  totalCostUsd: number;
  /** Total cost in cents (integer, rounded). */
  totalCostCents: number;
  /** Human-readable cost string (e.g. "$1.23"). */
  costString: string;
  /** Total input tokens (non-cached). */
  totalInputTokens: number;
  /** Total output tokens. */
  totalOutputTokens: number;
  /** Total cache creation tokens. */
  totalCacheCreationTokens: number;
  /** Total cache read tokens. */
  totalCacheReadTokens: number;
  /** Number of assistant messages with usage data. */
  messageCount: number;
  /** Primary model used (most frequent). */
  primaryModel: string | null;
  /** Per-model breakdown. */
  byModel: Record<string, { cost: number; messages: number }>;
}

/**
 * Extract usage data from JSONL transcript lines.
 *
 * Each line is expected to be a JSON object. We extract only assistant messages
 * with `message.usage` data and a non-synthetic model.
 */
export function extractUsageFromLines(lines: string[]): TranscriptUsage[] {
  const usages: TranscriptUsage[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // Skip malformed lines
    }

    if (parsed.type !== 'assistant') continue;

    const message = parsed.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const model = message.model as string | undefined;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!model || !usage || model === '<synthetic>') continue;

    usages.push({
      model,
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
    });
  }

  return usages;
}

/**
 * Compute total cost from extracted usage data.
 */
export function computeCost(usages: TranscriptUsage[]): CostResult {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  const modelCounts: Record<string, number> = {};
  const byModel: Record<string, { cost: number; messages: number }> = {};

  for (const u of usages) {
    const extUsage: ExtendedUsage = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheCreationInputTokens: u.cacheCreationInputTokens,
      cacheReadInputTokens: u.cacheReadInputTokens,
    };

    const cost = calculateCost(u.model, extUsage);
    totalCostUsd += cost;
    totalInputTokens += u.inputTokens;
    totalOutputTokens += u.outputTokens;
    totalCacheCreationTokens += u.cacheCreationInputTokens;
    totalCacheReadTokens += u.cacheReadInputTokens;

    modelCounts[u.model] = (modelCounts[u.model] ?? 0) + 1;
    if (!byModel[u.model]) byModel[u.model] = { cost: 0, messages: 0 };
    byModel[u.model].cost += cost;
    byModel[u.model].messages += 1;
  }

  // Determine primary model (most messages)
  let primaryModel: string | null = null;
  let maxCount = 0;
  for (const [model, count] of Object.entries(modelCounts)) {
    if (count > maxCount) {
      maxCount = count;
      primaryModel = model;
    }
  }

  const totalCostCents = Math.round(totalCostUsd * 100);

  return {
    totalCostUsd,
    totalCostCents,
    costString: `$${totalCostUsd.toFixed(2)}`,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
    messageCount: usages.length,
    primaryModel,
    byModel,
  };
}

/**
 * Convenience: extract usage from lines and compute cost in one call.
 */
export function computeCostFromLines(lines: string[]): CostResult {
  return computeCost(extractUsageFromLines(lines));
}
