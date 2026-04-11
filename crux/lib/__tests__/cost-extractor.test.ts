import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractUsageFromLines, computeCost, computeCostFromLines } from '../cost-extractor.ts';

// Suppress pricing warnings for unknown models
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeAssistantLine(model: string, usage: Record<string, number>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { model, usage, content: [{ type: 'text', text: 'hello' }] },
    timestamp: '2026-04-11T10:00:00.000Z',
  });
}

describe('extractUsageFromLines', () => {
  it('extracts usage from assistant messages', () => {
    const lines = [
      makeAssistantLine('claude-sonnet-4-6', {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      }),
    ];
    const usages = extractUsageFromLines(lines);
    expect(usages).toHaveLength(1);
    expect(usages[0].model).toBe('claude-sonnet-4-6');
    expect(usages[0].inputTokens).toBe(1000);
    expect(usages[0].outputTokens).toBe(500);
    expect(usages[0].cacheCreationInputTokens).toBe(200);
    expect(usages[0].cacheReadInputTokens).toBe(300);
  });

  it('skips non-assistant messages', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'system', subtype: 'local_command' }),
      makeAssistantLine('claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 }),
    ];
    const usages = extractUsageFromLines(lines);
    expect(usages).toHaveLength(1);
  });

  it('skips synthetic model messages', () => {
    const lines = [
      makeAssistantLine('<synthetic>', { input_tokens: 100, output_tokens: 50 }),
    ];
    const usages = extractUsageFromLines(lines);
    expect(usages).toHaveLength(0);
  });

  it('skips malformed JSON lines', () => {
    const lines = [
      'not json at all',
      '{"type": "assistant"',  // truncated
      makeAssistantLine('claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 }),
    ];
    const usages = extractUsageFromLines(lines);
    expect(usages).toHaveLength(1);
  });

  it('handles empty lines', () => {
    const lines = ['', '  ', '\n'];
    const usages = extractUsageFromLines(lines);
    expect(usages).toHaveLength(0);
  });

  it('handles missing usage fields gracefully', () => {
    const lines = [
      makeAssistantLine('claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 }),
    ];
    const usages = extractUsageFromLines(lines);
    expect(usages[0].cacheCreationInputTokens).toBe(0);
    expect(usages[0].cacheReadInputTokens).toBe(0);
  });
});

describe('computeCost', () => {
  it('computes correct cost for sonnet messages', () => {
    const usages = [
      { model: 'claude-sonnet-4-6', inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ];
    const result = computeCost(usages);
    // 1M input * $3/M + 100K output * $15/M = $3 + $1.5 = $4.50
    expect(result.totalCostUsd).toBeCloseTo(4.50, 2);
    expect(result.totalCostCents).toBe(450);
    expect(result.costString).toBe('$4.50');
    expect(result.primaryModel).toBe('claude-sonnet-4-6');
    expect(result.messageCount).toBe(1);
  });

  it('sums costs across multiple messages', () => {
    const usages = [
      { model: 'claude-sonnet-4-6', inputTokens: 500_000, outputTokens: 50_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { model: 'claude-sonnet-4-6', inputTokens: 500_000, outputTokens: 50_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ];
    const result = computeCost(usages);
    // Each: 500K * $3/M + 50K * $15/M = $1.50 + $0.75 = $2.25, total = $4.50
    expect(result.totalCostUsd).toBeCloseTo(4.50, 2);
    expect(result.messageCount).toBe(2);
  });

  it('handles cache creation and read tokens', () => {
    const usages = [
      {
        model: 'claude-sonnet-4-6',
        inputTokens: 100_000,
        outputTokens: 50_000,
        cacheCreationInputTokens: 500_000,
        cacheReadInputTokens: 200_000,
      },
    ];
    const result = computeCost(usages);
    // 100K input * $3/M = $0.30
    // 500K cache_create * $3/M * 1.25 = $1.875
    // 200K cache_read * $3/M * 0.1 = $0.06
    // 50K output * $15/M = $0.75
    // Total = $2.985
    expect(result.totalCostUsd).toBeCloseTo(2.985, 2);
    expect(result.totalCacheCreationTokens).toBe(500_000);
    expect(result.totalCacheReadTokens).toBe(200_000);
  });

  it('identifies primary model from mixed usage', () => {
    const usages = [
      { model: 'claude-opus-4-6', inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ];
    const result = computeCost(usages);
    expect(result.primaryModel).toBe('claude-sonnet-4-6');
    expect(Object.keys(result.byModel)).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6']);
    expect(result.byModel['claude-sonnet-4-6'].messages).toBe(2);
    expect(result.byModel['claude-opus-4-6'].messages).toBe(1);
  });

  it('returns zero for empty input', () => {
    const result = computeCost([]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalCostCents).toBe(0);
    expect(result.costString).toBe('$0.00');
    expect(result.primaryModel).toBeNull();
    expect(result.messageCount).toBe(0);
  });
});

describe('computeCostFromLines', () => {
  it('is a convenience wrapper combining extract + compute', () => {
    const lines = [
      makeAssistantLine('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 100_000 }),
    ];
    const result = computeCostFromLines(lines);
    expect(result.totalCostUsd).toBeCloseTo(4.50, 2);
    expect(result.messageCount).toBe(1);
  });
});
