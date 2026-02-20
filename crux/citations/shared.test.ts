import { describe, it, expect, vi } from 'vitest';
import { logBatchProgress } from './shared.ts';
import type { Colors } from '../lib/output.ts';

const noopColors: Colors = {
  red: '', green: '', yellow: '', blue: '', dim: '',
  bold: '', reset: '', cyan: '',
};

describe('logBatchProgress', () => {
  it('logs ETA when pages remain', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = Date.now();

    logBatchProgress(noopColors, {
      batchIndex: 0,
      concurrency: 1,
      totalPages: 10,
      runStartMs: now - 10_000, // 10s ago
      batchStartMs: now - 1_000, // 1s ago
    });

    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('ETA');
    expect(output).toContain('batch');
    expect(output).toContain('elapsed');

    spy.mockRestore();
  });

  it('logs "done" when all pages completed', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = Date.now();

    logBatchProgress(noopColors, {
      batchIndex: 9,
      concurrency: 1,
      totalPages: 10,
      runStartMs: now - 30_000,
      batchStartMs: now - 3_000,
    });

    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('done');

    spy.mockRestore();
  });

  it('handles concurrency > 1', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = Date.now();

    logBatchProgress(noopColors, {
      batchIndex: 0,
      concurrency: 3,
      totalPages: 9,
      runStartMs: now - 5_000,
      batchStartMs: now - 2_000,
    });

    expect(spy).toHaveBeenCalled();
    // Should not throw — just verify it runs without error
    spy.mockRestore();
  });
});
