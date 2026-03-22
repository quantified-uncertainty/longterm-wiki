/**
 * Tests for pricing.ts — cost calculation with prompt caching and batch discount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateCost, getModelPricing } from './pricing.ts';

// Suppress the "Unknown model" warning in test output
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('calculateCost', () => {
  it('calculates standard cost for sonnet', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 1M input * $3/M + 1M output * $15/M = $18
    expect(cost).toBeCloseTo(18.0, 2);
  });

  it('calculates standard cost for haiku', () => {
    const cost = calculateCost('claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 1M input * $0.80/M + 1M output * $4.00/M = $4.80
    expect(cost).toBeCloseTo(4.80, 2);
  });

  it('returns 0 for unknown model', () => {
    const cost = calculateCost('unknown-model', {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(cost).toBe(0);
  });

  it('handles cache creation tokens (25% premium)', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreationInputTokens: 500_000,
      cacheReadInputTokens: 0,
    });
    // 500K input * $3/M + 500K cache_write * $3/M * 1.25 + 500K output * $15/M
    // = $1.50 + $1.875 + $7.50 = $10.875
    expect(cost).toBeCloseTo(10.875, 2);
  });

  it('handles cache read tokens (90% discount = 0.1x)', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 500_000,
    });
    // 500K input * $3/M + 500K cache_read * $3/M * 0.1 + 500K output * $15/M
    // = $1.50 + $0.15 + $7.50 = $9.15
    expect(cost).toBeCloseTo(9.15, 2);
  });

  it('applies batch discount (50% off)', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { batchDiscount: true });
    // Standard: $18, with 50% discount: $9
    expect(cost).toBeCloseTo(9.0, 2);
  });

  it('applies batch discount with cache tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 500_000,
    }, { batchDiscount: true });
    // Standard with cache: $9.15, with 50% batch discount: $4.575
    expect(cost).toBeCloseTo(4.575, 2);
  });

  it('handles zero tokens', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('handles null cache fields gracefully', () => {
    const cost = calculateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
    });
    // Should behave same as no caching
    expect(cost).toBeCloseTo(3.0, 2);
  });
});

describe('getModelPricing', () => {
  it('resolves exact model ID', () => {
    const pricing = getModelPricing('claude-sonnet-4-6');
    expect(pricing).toBeDefined();
    expect(pricing!.inputPerM).toBe(3.00);
    expect(pricing!.outputPerM).toBe(15.00);
  });

  it('resolves alias', () => {
    const pricing = getModelPricing('sonnet');
    expect(pricing).toBeDefined();
    expect(pricing!.inputPerM).toBe(3.00);
  });

  it('returns undefined for unknown model', () => {
    const pricing = getModelPricing('unknown-model');
    expect(pricing).toBeUndefined();
  });
});
