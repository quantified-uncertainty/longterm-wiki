import { MODEL_PRICING } from '../pricing.ts';
import type { CostBreakdown } from './types.ts';

export function emptyCost(): CostBreakdown {
  return { searchCost: 0, factExtractionCost: 0, quoteExtractCost: 0, entailmentCost: 0, rankCost: 0 };
}

export function totalOf(c: CostBreakdown): number {
  return c.searchCost + c.factExtractionCost + c.quoteExtractCost + c.entailmentCost + c.rankCost;
}

/** Add `delta` into `running` in place. */
export function addCost(running: CostBreakdown, delta: CostBreakdown): void {
  running.searchCost += delta.searchCost;
  running.factExtractionCost += delta.factExtractionCost;
  running.quoteExtractCost += delta.quoteExtractCost;
  running.entailmentCost += delta.entailmentCost;
  running.rankCost += delta.rankCost;
}

/**
 * Compute the USD cost of a single LLM call from its usage block. Returns 0
 * if either pricing or usage is missing — callers should treat that as a
 * "this stage was free" result rather than blocking.
 */
export function computeUsageCost(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing || !usage) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return (input * pricing.inputPerM + output * pricing.outputPerM) / 1_000_000;
}
