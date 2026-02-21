// Claude pricing per 1M tokens
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number; // ~10% of input price
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.08 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0, cacheRead: 0.08 },
  default: { input: 3.0, output: 15.0, cacheRead: 0.3 },
};

export function getPricing(model?: string): ModelPricing {
  if (model && !PRICING[model]) {
    console.warn(
      `[pricing] Unknown model "${model}" — using default pricing. Update pricing.ts if this model is new.`
    );
  }
  return (model && PRICING[model]) || PRICING["default"]!;
}
