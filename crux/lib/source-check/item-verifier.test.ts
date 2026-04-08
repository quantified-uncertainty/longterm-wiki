/**
 * Tests for `storeResult` in item-verifier.ts.
 *
 * PR #4020 review C2 — when storeSourceCheckEvidence throws (the new
 * post-issue-#4017 contract), the function MUST still attempt
 * storeAggregateVerdict and re-throw the first error so the caller's
 * storage-error tracking sees it. The previous version skipped the
 * aggregate verdict on evidence failure, silently regressing the
 * displayed verdict.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStoreSourceCheckEvidence = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const mockStoreAggregateVerdict = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock('./verdict-handler.ts', () => ({
  storeSourceCheckEvidence: (...args: unknown[]) => mockStoreSourceCheckEvidence(...args),
  storeAggregateVerdict: (...args: unknown[]) => mockStoreAggregateVerdict(...args),
}));

vi.mock('./index.ts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./index.ts');
  return {
    ...actual,
    storeSourceCheckEvidence: (...args: unknown[]) => mockStoreSourceCheckEvidence(...args),
    storeAggregateVerdict: (...args: unknown[]) => mockStoreAggregateVerdict(...args),
  };
});

import { storeResult } from './item-verifier.ts';
import type { VerifyItem, VerifyResult } from './orchestrator-types.ts';

function makeFactItem(): VerifyItem {
  return {
    id: 'fact:f_test',
    kind: 'fact',
    description: 'test fact',
    sourceUrl: 'https://example.com',
    priority: 1,
    data: {
      kind: 'fact',
      fact: {
        id: 'f_test',
        subjectId: 'sid_test',
        propertyId: 'revenue',
        value: { type: 'number', value: 1000 },
        source: 'https://example.com',
      },
    },
  } as unknown as VerifyItem;
}

function makeRecordItem(): VerifyItem {
  return {
    id: 'record:personnel:p_test',
    kind: 'record',
    description: 'test record',
    sourceUrl: 'https://example.com',
    priority: 1,
    data: {
      kind: 'record',
      recordType: 'personnel',
      recordId: 'p_test',
      entityId: 'sid_test',
      displayName: 'Test Person',
      entityDisplayName: 'Test Org',
    },
  } as unknown as VerifyItem;
}

const sampleResult: VerifyResult = {
  verdict: 'confirmed',
  confidence: 0.95,
  extractedValue: '$1B',
  reasoning: 'matches source',
  sourceUrl: 'https://example.com',
  checkerModel: 'test-model',
} as unknown as VerifyResult;

describe('storeResult — issue #4017 C2 (evidence throw must NOT skip aggregate verdict)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreSourceCheckEvidence.mockImplementation(async () => {});
    mockStoreAggregateVerdict.mockImplementation(async () => {});
  });

  describe('fact items', () => {
    it('calls both evidence and aggregate verdict on the happy path', async () => {
      await storeResult(makeFactItem(), sampleResult);
      expect(mockStoreSourceCheckEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });

    // The regression: previously, an evidence throw would skip the aggregate
    // verdict because the awaits were sequential without try/catch.
    it('STILL calls aggregate verdict when evidence throws', async () => {
      mockStoreSourceCheckEvidence.mockRejectedValueOnce(new Error('evidence write failed'));

      await expect(storeResult(makeFactItem(), sampleResult)).rejects.toThrow('evidence write failed');

      // The key assertion: both were attempted, even though evidence threw.
      expect(mockStoreSourceCheckEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });

    it('throws the first error when both calls fail', async () => {
      mockStoreSourceCheckEvidence.mockRejectedValueOnce(new Error('first error'));
      mockStoreAggregateVerdict.mockRejectedValueOnce(new Error('second error'));

      await expect(storeResult(makeFactItem(), sampleResult)).rejects.toThrow('first error');
      expect(mockStoreSourceCheckEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });

    it('throws aggregate-verdict error when only that one fails', async () => {
      mockStoreAggregateVerdict.mockRejectedValueOnce(new Error('verdict write failed'));

      await expect(storeResult(makeFactItem(), sampleResult)).rejects.toThrow('verdict write failed');
      expect(mockStoreSourceCheckEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });
  });

  describe('record items', () => {
    it('STILL calls aggregate verdict when evidence throws (record path)', async () => {
      mockStoreSourceCheckEvidence.mockRejectedValueOnce(new Error('boom'));

      await expect(storeResult(makeRecordItem(), sampleResult)).rejects.toThrow('boom');

      expect(mockStoreSourceCheckEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });
  });
});
