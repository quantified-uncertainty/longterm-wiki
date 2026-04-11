/**
 * Tests for `storeResult` in item-verifier.ts.
 *
 * PR #4020 review C2 — when storeSourcingEvidence throws (the new
 * post-issue-#4017 contract), the function MUST still attempt
 * storeAggregateVerdict and re-throw the first error so the caller's
 * storage-error tracking sees it. The previous version skipped the
 * aggregate verdict on evidence failure, silently regressing the
 * displayed verdict.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStoreSourcingEvidence = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const mockStoreAggregateVerdict = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock('./verdict-handler.ts', () => ({
  storeSourcingEvidence: (...args: unknown[]) => mockStoreSourcingEvidence(...args),
  storeAggregateVerdict: (...args: unknown[]) => mockStoreAggregateVerdict(...args),
}));

vi.mock('./index.ts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./index.ts');
  return {
    ...actual,
    storeSourcingEvidence: (...args: unknown[]) => mockStoreSourcingEvidence(...args),
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
    mockStoreSourcingEvidence.mockImplementation(async () => {});
    mockStoreAggregateVerdict.mockImplementation(async () => {});
  });

  describe('fact items', () => {
    it('calls both evidence and aggregate verdict on the happy path', async () => {
      await storeResult(makeFactItem(), sampleResult);
      expect(mockStoreSourcingEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });

    // The regression: previously, an evidence throw would skip the aggregate
    // verdict because the awaits were sequential without try/catch.
    it('STILL calls aggregate verdict when evidence throws', async () => {
      mockStoreSourcingEvidence.mockRejectedValueOnce(new Error('evidence write failed'));

      await expect(storeResult(makeFactItem(), sampleResult)).rejects.toThrow('evidence write failed');

      // The key assertion: both were attempted, even though evidence threw.
      expect(mockStoreSourcingEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });

    it('throws the first error when both calls fail', async () => {
      mockStoreSourcingEvidence.mockRejectedValueOnce(new Error('first error'));
      mockStoreAggregateVerdict.mockRejectedValueOnce(new Error('second error'));

      await expect(storeResult(makeFactItem(), sampleResult)).rejects.toThrow('first error');
      expect(mockStoreSourcingEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });

    it('throws aggregate-verdict error when only that one fails', async () => {
      mockStoreAggregateVerdict.mockRejectedValueOnce(new Error('verdict write failed'));

      await expect(storeResult(makeFactItem(), sampleResult)).rejects.toThrow('verdict write failed');
      expect(mockStoreSourcingEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });
  });

  describe('record items', () => {
    it('STILL calls aggregate verdict when evidence throws (record path)', async () => {
      mockStoreSourcingEvidence.mockRejectedValueOnce(new Error('boom'));

      await expect(storeResult(makeRecordItem(), sampleResult)).rejects.toThrow('boom');

      expect(mockStoreSourcingEvidence).toHaveBeenCalledOnce();
      expect(mockStoreAggregateVerdict).toHaveBeenCalledOnce();
    });
  });
});
