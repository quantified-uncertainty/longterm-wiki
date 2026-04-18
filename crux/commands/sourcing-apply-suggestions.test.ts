/**
 * Tests for sourcing-apply-suggestions (QUA-591).
 *
 * Uses --dry-run where possible so the LLM layer doesn't need stubbing, and
 * stubs the sourcing helpers (fetchSourceContent, callLlmForSourcing, etc.)
 * for the live-path tests. Follows the same mocking pattern as
 * sourcing-recheck.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListUrlSuggestions = vi.fn();
const mockUpdateUrlSuggestionStatus = vi.fn();
const mockStoreVerdictRpc = vi.fn();
const mockGetVerdictByRecord = vi.fn();

vi.mock('../lib/wiki-server/sourcing-client.ts', () => ({
  listUrlSuggestions: (...args: unknown[]) => mockListUrlSuggestions(...args),
  updateUrlSuggestionStatus: (...args: unknown[]) => mockUpdateUrlSuggestionStatus(...args),
  storeVerdict: (...args: unknown[]) => mockStoreVerdictRpc(...args),
  getVerdictByRecord: (...args: unknown[]) => mockGetVerdictByRecord(...args),
}));

const mockFetchSourceContent = vi.fn();
const mockCallLlmForSourcing = vi.fn();
const mockStoreSourcingEvidence = vi.fn();

vi.mock('../lib/sourcing/index.ts', () => ({
  fetchSourceContent: (...args: unknown[]) => mockFetchSourceContent(...args),
  callLlmForSourcing: (...args: unknown[]) => mockCallLlmForSourcing(...args),
  storeSourcingEvidence: (...args: unknown[]) => mockStoreSourcingEvidence(...args),
  storeAggregateVerdict: vi.fn(),
  SOURCE_CHECK_CONSTANTS: {
    ESTIMATED_COST_PER_VERIFICATION: 0.01,
    PROMPT_CONTENT_LENGTH: 30_000,
  },
}));

vi.mock('../lib/llm.ts', () => ({
  createLlmClient: vi.fn(() => ({})),
  callLlm: vi.fn(),
}));

import { commands } from './sourcing-apply-suggestions.ts';

const apply = commands.default;

function makeSuggestion(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 42,
    recordType: 'grant',
    recordId: 'g_test_1',
    fieldName: null,
    entityId: 'anthropic',
    suggestedUrl: 'https://example.com/new-source',
    title: 'New Source',
    snippet: null,
    sourceProvider: 'exa',
    status: 'approved',
    ...overrides,
  };
}

describe('sourcing-apply-suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('option validation', () => {
    it('rejects an unknown --status value', async () => {
      const result = await apply([], { status: 'aproved', 'dry-run': true } as never);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Invalid --status');
      expect(mockListUrlSuggestions).not.toHaveBeenCalled();
    });

    it('accepts multiple comma-separated statuses', async () => {
      mockListUrlSuggestions.mockResolvedValue({
        ok: true,
        data: { suggestions: [], returned: 0 },
      });
      const result = await apply([], {
        status: 'approved,auto_verified',
        'dry-run': true,
      } as never);
      // Both statuses queried — 2 calls total
      expect(result.exitCode).toBe(0);
      expect(mockListUrlSuggestions).toHaveBeenCalledTimes(2);
      expect(mockListUrlSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved' }),
      );
      expect(mockListUrlSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'auto_verified' }),
      );
    });

    it('defaults to approved + auto_verified when --status omitted', async () => {
      mockListUrlSuggestions.mockResolvedValue({
        ok: true,
        data: { suggestions: [], returned: 0 },
      });
      await apply([], { 'dry-run': true } as never);
      expect(mockListUrlSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved' }),
      );
      expect(mockListUrlSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'auto_verified' }),
      );
    });

    it('passes --type through as recordType filter', async () => {
      mockListUrlSuggestions.mockResolvedValue({
        ok: true,
        data: { suggestions: [], returned: 0 },
      });
      await apply([], {
        status: 'approved',
        type: 'grant',
        'dry-run': true,
      } as never);
      expect(mockListUrlSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ recordType: 'grant', status: 'approved' }),
      );
    });
  });

  describe('empty-result handling', () => {
    it('returns a friendly message when no suggestions match', async () => {
      mockListUrlSuggestions.mockResolvedValue({
        ok: true,
        data: { suggestions: [], returned: 0 },
      });
      const result = await apply([], {
        status: 'approved',
        'dry-run': true,
      } as never);
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/No suggestions found/i);
    });

    it('surfaces listUrlSuggestions failures as exit=1', async () => {
      mockListUrlSuggestions.mockResolvedValue({
        ok: false,
        message: 'boom',
        error: { code: 'HTTP_500' },
      });
      const result = await apply([], { 'dry-run': true } as never);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('boom');
    });
  });

  describe('pagination', () => {
    it('paginates when the first page is full', async () => {
      const page1 = Array.from({ length: 200 }, (_, i) =>
        makeSuggestion({ id: i + 1, recordId: `g_${i}` }),
      );
      const page2 = Array.from({ length: 50 }, (_, i) =>
        makeSuggestion({ id: 201 + i, recordId: `g_${200 + i}` }),
      );
      mockListUrlSuggestions
        // first status: approved → 2 pages
        .mockResolvedValueOnce({ ok: true, data: { suggestions: page1, returned: 200 } })
        .mockResolvedValueOnce({ ok: true, data: { suggestions: page2, returned: 50 } })
        // second status: auto_verified → empty
        .mockResolvedValueOnce({ ok: true, data: { suggestions: [], returned: 0 } });

      const result = await apply([], { limit: '500', 'dry-run': true } as never);
      expect(result.exitCode).toBe(0);
      // 2 pages for approved, 1 for auto_verified, total 3 calls
      expect(mockListUrlSuggestions).toHaveBeenCalledTimes(3);
      expect(mockListUrlSuggestions).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ status: 'approved', offset: 0 }),
      );
      expect(mockListUrlSuggestions).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ status: 'approved', offset: 200 }),
      );
    });

    it('stops once itemLimit is satisfied', async () => {
      // Even with a full page of 200 and more behind it, itemLimit=100 stops early.
      const page = Array.from({ length: 100 }, (_, i) => makeSuggestion({ id: i + 1 }));
      mockListUrlSuggestions.mockResolvedValue({
        ok: true,
        data: { suggestions: page, returned: 100 },
      });
      await apply([], {
        status: 'approved',
        limit: '100',
        'dry-run': true,
      } as never);
      expect(mockListUrlSuggestions).toHaveBeenCalledTimes(1);
      expect(mockListUrlSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100, offset: 0 }),
      );
    });
  });

  describe('live apply path', () => {
    beforeEach(() => {
      // Default: LLM verifies as confirmed.
      mockGetVerdictByRecord.mockResolvedValue({
        ok: true,
        data: { verdicts: [{ verdict: 'unverifiable', fieldName: null }] },
      });
      mockCallLlmForSourcing.mockResolvedValue({
        verdict: 'confirmed',
        confidence: 0.9,
        extractedValue: 'The company confirmed 500 employees in 2024',
        reasoning: 'Direct match on the claim',
      });
      mockStoreSourcingEvidence.mockResolvedValue(undefined);
      mockStoreVerdictRpc.mockResolvedValue({ ok: true, data: {} });
      mockUpdateUrlSuggestionStatus.mockResolvedValue({ ok: true, data: { ok: true, id: 42 } });
    });

    it('fetches → LLMs → stores evidence+verdict → marks applied, on success', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [makeSuggestion()], returned: 1 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockFetchSourceContent.mockResolvedValueOnce({
        content: 'Anthropic has 500 employees as of 2024.',
      });

      const result = await apply([], {} as never);
      expect(result.exitCode).toBe(0);

      // Evidence stored with the NEW URL
      expect(mockStoreSourcingEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceUrl: 'https://example.com/new-source',
          verdict: 'confirmed',
        }),
        expect.any(String),
      );

      // Aggregate verdict stored with the new verdict
      expect(mockStoreVerdictRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          recordType: 'grant',
          recordId: 'g_test_1',
          verdict: 'confirmed',
        }),
      );

      // Suggestion marked as applied
      expect(mockUpdateUrlSuggestionStatus).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ status: 'applied' }),
      );

      expect(result.output).toMatch(/unverifiable.*confirmed/);
    });

    it('counts non-transition applies (e.g. still-unverifiable) as applied, not changed', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [makeSuggestion()], returned: 1 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockFetchSourceContent.mockResolvedValueOnce({ content: 'Off-topic text.' });
      mockCallLlmForSourcing.mockResolvedValueOnce({
        verdict: 'unverifiable',
        confidence: 0.3,
        extractedValue: '',
        reasoning: 'Source does not cover this claim',
      });

      const result = await apply([], {} as never);
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/Applied:\s+1/);
      expect(result.output).toMatch(/Changed verdicts:\s+0/);
      // Suggestion still marked applied — we tried, it just didn't help.
      expect(mockUpdateUrlSuggestionStatus).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ status: 'applied' }),
      );
    });

    it('surfaces awaiting-ingest fetch failures without calling LLM or marking applied', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [makeSuggestion()], returned: 1 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockFetchSourceContent.mockResolvedValueOnce({
        content: null,
        errorType: 'not_cached',
        errorMessage: 'not in cache',
        ingestEnqueued: true,
      });

      const result = await apply([], {} as never);
      // awaiting-ingest contributes to errors and non-zero exit — the sweep
      // isn't fully converged yet.
      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/awaiting resource-ingest/i);
      expect(mockCallLlmForSourcing).not.toHaveBeenCalled();
      expect(mockStoreSourcingEvidence).not.toHaveBeenCalled();
      expect(mockUpdateUrlSuggestionStatus).not.toHaveBeenCalled();
    });

    it('treats dead_link fetch failures as errors (no LLM, no apply)', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [makeSuggestion()], returned: 1 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockFetchSourceContent.mockResolvedValueOnce({
        content: null,
        errorType: 'dead_link',
        errorMessage: 'HTTP 404',
        httpStatus: 404,
      });

      const result = await apply([], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('HTTP 404');
      expect(mockCallLlmForSourcing).not.toHaveBeenCalled();
      expect(mockUpdateUrlSuggestionStatus).not.toHaveBeenCalled();
    });

    it('propagates fieldName and entityId through to verdict body', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: {
            suggestions: [
              makeSuggestion({ fieldName: 'amount_usd', entityId: 'sid_abc' }),
            ],
            returned: 1,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockFetchSourceContent.mockResolvedValueOnce({ content: 'text' });

      await apply([], {} as never);

      expect(mockStoreVerdictRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          fieldName: 'amount_usd',
          entityId: 'sid_abc',
        }),
      );
      expect(mockStoreSourcingEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ fieldName: 'amount_usd', entityId: 'sid_abc' }),
        expect.any(String),
      );
    });

    it('does NOT mark applied when verdict storage fails (so next run retries)', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [makeSuggestion()], returned: 1 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockFetchSourceContent.mockResolvedValueOnce({ content: 'text' });
      mockStoreVerdictRpc.mockResolvedValueOnce({
        ok: false,
        message: 'constraint violation',
        error: 'constraint violation',
      });

      const result = await apply([], {} as never);
      expect(result.exitCode).toBe(1);
      expect(mockUpdateUrlSuggestionStatus).not.toHaveBeenCalled();
    });

    it('continues past a status-patch failure but reports non-zero exit', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: {
            suggestions: [
              makeSuggestion(),
              makeSuggestion({ id: 43, recordId: 'g_test_2' }),
            ],
            returned: 2,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockFetchSourceContent.mockResolvedValue({ content: 'text' });
      mockUpdateUrlSuggestionStatus
        .mockResolvedValueOnce({ ok: false, message: 'patch failed' })
        .mockResolvedValueOnce({ ok: true, data: { ok: true, id: 43 } });

      const result = await apply([], {} as never);
      // Applied both but one patch failed → non-zero exit
      expect(result.exitCode).toBe(1);
      expect(mockStoreVerdictRpc).toHaveBeenCalledTimes(2);
      expect(mockUpdateUrlSuggestionStatus).toHaveBeenCalledTimes(2);
      expect(result.output).toMatch(/applied but not marked/i);
    });

    it('records the correct previous verdict from getVerdictByRecord', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [makeSuggestion()], returned: 1 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      // Prior verdict is 'partial' (not the default 'unverifiable')
      mockGetVerdictByRecord.mockResolvedValueOnce({
        ok: true,
        data: { verdicts: [{ verdict: 'partial', fieldName: null }] },
      });
      mockFetchSourceContent.mockResolvedValueOnce({ content: 'text' });

      const result = await apply([], {} as never);
      expect(result.output).toMatch(/partial.*confirmed/);
    });

    it('uses the field-matching prior verdict when multiple exist', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: {
            suggestions: [makeSuggestion({ fieldName: 'amount_usd' })],
            returned: 1,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockGetVerdictByRecord.mockResolvedValueOnce({
        ok: true,
        data: {
          verdicts: [
            { verdict: 'confirmed', fieldName: 'date' },
            { verdict: 'partial', fieldName: 'amount_usd' },
          ],
        },
      });
      mockFetchSourceContent.mockResolvedValueOnce({ content: 'text' });

      const result = await apply([], {} as never);
      // Should pick 'partial' (the amount_usd one), not 'confirmed' (first row)
      expect(result.output).toMatch(/partial.*confirmed/);
    });
  });

  describe('budget cap', () => {
    it('caps applies by --budget before invoking fetch', async () => {
      const suggestions = Array.from({ length: 10 }, (_, i) =>
        makeSuggestion({ id: i + 1, recordId: `g_${i}` }),
      );
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions, returned: 10 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      // $0.03 / $0.01 per = 3 applies max
      const result = await apply([], {
        budget: '0.03',
        'dry-run': true,
      } as never);
      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/3 of 10/);
    });

    it('honors --budget in live execution too', async () => {
      const suggestions = Array.from({ length: 5 }, (_, i) =>
        makeSuggestion({ id: i + 1, recordId: `g_${i}` }),
      );
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions, returned: 5 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      mockGetVerdictByRecord.mockResolvedValue({
        ok: true,
        data: { verdicts: [{ verdict: 'unverifiable', fieldName: null }] },
      });
      mockFetchSourceContent.mockResolvedValue({ content: 'text' });
      mockCallLlmForSourcing.mockResolvedValue({
        verdict: 'confirmed',
        confidence: 0.9,
        extractedValue: '',
        reasoning: '',
      });
      mockStoreSourcingEvidence.mockResolvedValue(undefined);
      mockStoreVerdictRpc.mockResolvedValue({ ok: true, data: {} });
      mockUpdateUrlSuggestionStatus.mockResolvedValue({ ok: true, data: { ok: true, id: 1 } });

      // $0.02 / $0.01 = 2 applies
      await apply([], { budget: '0.02' } as never);
      expect(mockFetchSourceContent).toHaveBeenCalledTimes(2);
      expect(mockCallLlmForSourcing).toHaveBeenCalledTimes(2);
    });
  });

  describe('JSON output', () => {
    it('emits machine-readable JSON on --ci', async () => {
      mockListUrlSuggestions
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [makeSuggestion()], returned: 1 },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: { suggestions: [], returned: 0 },
        });
      const result = await apply([], { ci: true, 'dry-run': true } as never);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.output);
      expect(parsed).toMatchObject({
        totalCandidates: 1,
        selected: 1,
        estimatedCost: expect.any(Number),
        items: expect.any(Array),
      });
      expect(parsed.items[0]).toMatchObject({
        id: 42,
        recordType: 'grant',
        suggestedUrl: 'https://example.com/new-source',
      });
    });
  });
});
