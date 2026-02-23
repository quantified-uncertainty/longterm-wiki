/**
 * Model Pricing — Single source of truth for per-token pricing.
 *
 * Used by CostTracker to calculate actual costs from API usage data,
 * and by research-agent.ts for fact-extraction cost estimates.
 *
 * Prices are in USD per million tokens.
 * Last verified against https://docs.anthropic.com/en/docs/about-claude/pricing
 */

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
}

/**
 * Per-model pricing table. Keyed by exact model ID.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5-20251001': { inputPerM: 0.80, outputPerM: 4.00 },
  'claude-sonnet-4-6': { inputPerM: 3.00, outputPerM: 15.00 },
  'claude-opus-4-6': { inputPerM: 15.00, outputPerM: 75.00 },
};

/** Date these prices were last verified. */
export const PRICING_LAST_VERIFIED = '2026-02-23';

/**
 * Alias map: short names → exact model IDs.
 * Allows callers to pass "haiku", "sonnet", or "opus" and get the right pricing.
 */
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

/**
 * Resolve a model string (exact ID or alias) to its pricing entry.
 * Returns undefined if the model is not recognized.
 */
export function getModelPricing(model: string): ModelPricing | undefined {
  // Direct match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Alias match
  const aliasId = MODEL_ALIASES[model.toLowerCase()];
  if (aliasId && MODEL_PRICING[aliasId]) return MODEL_PRICING[aliasId];

  // Partial match: model ID with date suffix (e.g. "claude-sonnet-4-6-20260101" matches "claude-sonnet-4-6")
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }

  return undefined;
}

/**
 * Calculate the cost of an API call given the model and token usage.
 *
 * @param model - Model ID or alias (e.g. "claude-sonnet-4-6" or "sonnet")
 * @param usage - Token counts from the API response
 * @returns Cost in USD, or 0 if model pricing is unknown
 */
export function calculateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const pricing = getModelPricing(model);
  if (!pricing) {
    console.warn(`[pricing] Unknown model "${model}" — cost will be reported as $0.00`);
    return 0;
  }

  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerM +
    (usage.outputTokens / 1_000_000) * pricing.outputPerM
  );
}
