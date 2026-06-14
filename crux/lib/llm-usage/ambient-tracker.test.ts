/**
 * Unit tests for the ambient cost tracker.
 */

import { describe, it, expect, vi } from 'vitest';
import { CostTracker } from '../cost-tracker.ts';
import {
  runWithAmbientTracker,
  runWithAmbientContext,
  getAmbientContext,
  getAmbientTracker,
  recordAmbient,
  recordAmbientExternalCost,
} from './ambient-tracker.ts';

describe('ambient-tracker', () => {
  it('exposes the tracker set for the async context', async () => {
    const tracker = new CostTracker();
    expect(getAmbientTracker()).toBeUndefined();
    await runWithAmbientTracker(tracker, async () => {
      expect(getAmbientTracker()).toBe(tracker);
    });
    // Restored after the context exits.
    expect(getAmbientTracker()).toBeUndefined();
  });

  it('runWithAmbientContext exposes flow + runId', () => {
    const tracker = new CostTracker();
    runWithAmbientContext({ tracker, flow: 'source-discover', runId: 'r-9' }, () => {
      const ctx = getAmbientContext();
      expect(ctx?.flow).toBe('source-discover');
      expect(ctx?.runId).toBe('r-9');
      expect(getAmbientTracker()).toBe(tracker);
    });
    expect(getAmbientContext()).toBeUndefined();
  });

  it('recordAmbient records into the ambient tracker', () => {
    const tracker = new CostTracker();
    runWithAmbientTracker(tracker, () => {
      recordAmbient(
        'claude-haiku-4-5-20251001',
        { input_tokens: 1000, output_tokens: 500 },
        'verify',
      );
    });
    expect(tracker.entries).toHaveLength(1);
    expect(tracker.entries[0].label).toBe('verify');
    expect(tracker.totalCost).toBeGreaterThan(0);
  });

  it('recordAmbientExternalCost records a direct cost', () => {
    const tracker = new CostTracker();
    runWithAmbientTracker(tracker, () => {
      recordAmbientExternalCost('deepseek/deepseek-v4-flash', 0.0123, 'entail');
    });
    expect(tracker.entries).toHaveLength(1);
    expect(tracker.totalCost).toBeCloseTo(0.0123);
  });

  it('is a no-op outside any context', () => {
    // Must not throw when there's no ambient tracker.
    expect(() =>
      recordAmbient('claude-haiku-4-5-20251001', { input_tokens: 1, output_tokens: 1 }),
    ).not.toThrow();
  });

  it('swallows recording failures so instrumentation never breaks the call', () => {
    const tracker = new CostTracker();
    // Force record() to throw — recordAmbient must catch and log, not rethrow.
    vi.spyOn(tracker, 'record').mockImplementation(() => {
      throw new Error('boom');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runWithAmbientTracker(tracker, () => {
      expect(() =>
        recordAmbient('claude-haiku-4-5-20251001', { input_tokens: 1, output_tokens: 1 }),
      ).not.toThrow();
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
