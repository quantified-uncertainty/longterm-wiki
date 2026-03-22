/**
 * Tests for cost-tracker.ts — CostTracker with prompt caching support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from './cost-tracker.ts';

// Suppress the "Unknown model" warning in test output
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CostTracker', () => {
  it('records basic usage', () => {
    const tracker = new CostTracker();
    tracker.record('claude-sonnet-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
    }, 'test');

    expect(tracker.entries).toHaveLength(1);
    expect(tracker.entries[0].inputTokens).toBe(1000);
    expect(tracker.entries[0].outputTokens).toBe(500);
    expect(tracker.entries[0].cacheCreationInputTokens).toBe(0);
    expect(tracker.entries[0].cacheReadInputTokens).toBe(0);
    expect(tracker.entries[0].label).toBe('test');
    expect(tracker.entries[0].cost).toBeGreaterThan(0);
  });

  it('records usage with cache creation tokens', () => {
    const tracker = new CostTracker();
    tracker.record('claude-sonnet-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 0,
    }, 'cached-write');

    expect(tracker.entries[0].cacheCreationInputTokens).toBe(3000);
    expect(tracker.entries[0].cacheReadInputTokens).toBe(0);
  });

  it('records usage with cache read tokens', () => {
    const tracker = new CostTracker();
    tracker.record('claude-sonnet-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3000,
    }, 'cached-read');

    expect(tracker.entries[0].cacheCreationInputTokens).toBe(0);
    expect(tracker.entries[0].cacheReadInputTokens).toBe(3000);
    // Cost with cache read should be less than without
    const withCache = tracker.entries[0].cost;

    const tracker2 = new CostTracker();
    tracker2.record('claude-sonnet-4-6', {
      input_tokens: 4000, // equivalent total: 1000 non-cached + 3000 would-be-cached
      output_tokens: 500,
    }, 'no-cache');
    const withoutCache = tracker2.entries[0].cost;

    expect(withCache).toBeLessThan(withoutCache);
  });

  it('handles null cache fields from Anthropic API', () => {
    const tracker = new CostTracker();
    tracker.record('claude-sonnet-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    }, 'nulls');

    expect(tracker.entries[0].cacheCreationInputTokens).toBe(0);
    expect(tracker.entries[0].cacheReadInputTokens).toBe(0);
  });

  it('calculates totalCost across multiple entries', () => {
    const tracker = new CostTracker();
    tracker.record('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 500 }, 'a');
    tracker.record('claude-sonnet-4-6', { input_tokens: 2000, output_tokens: 1000 }, 'b');

    expect(tracker.totalCost).toBeGreaterThan(0);
    expect(tracker.entries).toHaveLength(2);
  });

  it('calculates breakdown by label', () => {
    const tracker = new CostTracker();
    tracker.record('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 500 }, 'phase-a');
    tracker.record('claude-sonnet-4-6', { input_tokens: 2000, output_tokens: 1000 }, 'phase-b');
    tracker.record('claude-sonnet-4-6', { input_tokens: 500, output_tokens: 250 }, 'phase-a');

    const breakdown = tracker.breakdown();
    expect(Object.keys(breakdown)).toContain('phase-a');
    expect(Object.keys(breakdown)).toContain('phase-b');
    // phase-a should have cost from two entries
    expect(breakdown['phase-a']).toBeGreaterThan(0);
    expect(breakdown['phase-b']).toBeGreaterThan(0);
  });

  it('records external cost with zero cache tokens', () => {
    const tracker = new CostTracker();
    tracker.recordExternalCost('perplexity/sonar', 0.05, 'research');

    expect(tracker.entries[0].cacheCreationInputTokens).toBe(0);
    expect(tracker.entries[0].cacheReadInputTokens).toBe(0);
    expect(tracker.entries[0].cost).toBe(0.05);
  });

  it('serializes to JSON with all fields', () => {
    const tracker = new CostTracker();
    tracker.record('claude-sonnet-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 0,
    }, 'test');

    const json = tracker.toJSON();
    expect(json.entries[0].cacheCreationInputTokens).toBe(2000);
    expect(json.entries[0].cacheReadInputTokens).toBe(0);
    expect(json.totalCost).toBeGreaterThan(0);
  });
});
