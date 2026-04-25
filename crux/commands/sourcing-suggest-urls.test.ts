/**
 * Tests for the --verdict flag added in QUA-587 — extends URL suggestion
 * sweeps from unverifiable-only to also cover partial verdicts. Focused on
 * the code paths that differ by flag: allowlist validation, default
 * behaviour, and wiring through to listVerdicts + log/empty-result messages.
 *
 * Uses --dry-run so the search-provider layer doesn't need stubbing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListVerdicts = vi.fn();
const mockListUrlSuggestions = vi.fn();
const mockGetEvidenceByRecords = vi.fn();
const mockUpsertUrlSuggestions = vi.fn();

vi.mock('../lib/wiki-server/sourcing-client.ts', () => ({
  listVerdicts: (...args: unknown[]) => mockListVerdicts(...args),
  listUrlSuggestions: (...args: unknown[]) => mockListUrlSuggestions(...args),
  getEvidenceByRecords: (...args: unknown[]) => mockGetEvidenceByRecords(...args),
  upsertUrlSuggestions: (...args: unknown[]) => mockUpsertUrlSuggestions(...args),
  evidenceRecordKey: (rt: string, rid: string) => `${rt}|${rid}`,
  MAX_EVIDENCE_BY_RECORDS: 1000,
}));

vi.mock('../lib/sourcing/suggest-urls.ts', () => ({
  suggestUrls: vi.fn(),
  GENERATOR_MODEL: 'test-generator',
}));

import { commands } from './sourcing-suggest-urls.ts';
import { suggestUrls } from '../lib/sourcing/suggest-urls.ts';

const suggest = commands.default;
const mockSuggestUrls = vi.mocked(suggestUrls);

// Typed helper so tests don't pass options through an `as never` escape hatch.
// Accepts any subset of the command's option flags.
type TestOpts = Record<string, string | boolean | undefined>;
const run = (opts: TestOpts) => suggest([], opts as Parameters<typeof suggest>[1]);

function makeVerdict(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    recordType: 'grant',
    recordId: 'g_test_1',
    fieldName: null,
    entityId: 'anthropic',
    displayName: 'Test grant',
    entityDisplayName: 'Anthropic',
    verdict: 'partial',
    confidence: 0.6,
    reasoning: 'Source partially confirms amount',
    sourcesChecked: 1,
    needsRecheck: false,
    nextCheckDue: '2026-05-17',
    lastComputedAt: '2026-04-16',
    createdAt: '2026-04-01',
    updatedAt: '2026-04-16',
    ...overrides,
  };
}

function stubEmptyPrereqs() {
  // Pre-fetch of pending suggestions returns empty (no dedup skips).
  mockListUrlSuggestions.mockResolvedValue({
    ok: true,
    data: { suggestions: [] },
  });
  // Batch evidence fetch returns no existing URLs.
  mockGetEvidenceByRecords.mockResolvedValue({
    ok: true,
    data: { evidenceByKey: {} },
  });
}

describe('sourcing-suggest-urls --verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unknown verdict values before any API calls', async () => {
    const result = await run({ verdict: 'typo', 'dry-run': true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid --verdict');
    expect(mockListVerdicts).not.toHaveBeenCalled();
    expect(mockListUrlSuggestions).not.toHaveBeenCalled();
    expect(mockGetEvidenceByRecords).not.toHaveBeenCalled();
  });

  it('rejects allowed-elsewhere verdicts that URL-replacement does not address', async () => {
    // Includes `unchecked` — which is a legitimate verdict elsewhere but
    // doesn't make sense here (no verdict yet to remediate). Listed
    // explicitly so a future widening of the allowlist has to update the test.
    for (const verdict of ['confirmed', 'contradicted', 'outdated', 'unchecked']) {
      mockListVerdicts.mockClear();
      const result = await run({ verdict, 'dry-run': true });
      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/Invalid --verdict/);
      expect(result.output).toContain('unverifiable');
      expect(result.output).toContain('partial');
      expect(mockListVerdicts).not.toHaveBeenCalled();
    }
  });

  it('defaults to verdict=unverifiable when --verdict is omitted (back-compat)', async () => {
    stubEmptyPrereqs();
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict({ verdict: 'unverifiable' })], total: 1 },
    });
    const result = await run({ 'dry-run': true });
    expect(result.exitCode).toBe(0);
    expect(mockListVerdicts).toHaveBeenCalledTimes(1);
    expect(mockListVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'unverifiable' }),
    );
  });

  it('passes --verdict=partial through to listVerdicts (QUA-587)', async () => {
    stubEmptyPrereqs();
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict()], total: 1 },
    });
    const result = await run({ verdict: 'partial', 'dry-run': true });
    expect(result.exitCode).toBe(0);
    expect(mockListVerdicts).toHaveBeenCalledTimes(1);
    expect(mockListVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'partial' }),
    );
  });

  it('normalizes case in --verdict (PARTIAL -> partial)', async () => {
    stubEmptyPrereqs();
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0 },
    });
    const result = await run({ verdict: 'PARTIAL', 'dry-run': true });
    expect(result.exitCode).toBe(0);
    expect(mockListVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'partial' }),
    );
  });

  it('empty-result message names the active verdict', async () => {
    stubEmptyPrereqs();
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0 },
    });
    const result = await run({ verdict: 'partial', 'dry-run': true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/No partial verdicts matched/i);
  });

  it('surfaces listVerdicts failures with the active verdict in the error', async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: false,
      message: 'boom',
      error: { code: 'HTTP_500' },
    });
    const result = await run({ verdict: 'partial', 'dry-run': true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/Failed to list partial verdicts/i);
    expect(result.output).toContain('boom');
  });

  it('emits JSON when --json is set (no human log lines in output)', async () => {
    stubEmptyPrereqs();
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [], total: 0 },
    });
    const result = await run({
      verdict: 'partial',
      'dry-run': true,
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.dry_run).toBe(true);
    expect(parsed.summary.scanned).toBe(0);
  });

  it('upserts candidates for --verdict=partial in the non-dry-run path', async () => {
    // Not dry-run: proves the full pipeline (list -> evidence -> suggest
    // -> upsert) still runs correctly once the verdict flag is threaded
    // through. Without this, a bug where `verdict=partial` silently
    // bypassed upsert would not be caught by the dry-run tests above.
    stubEmptyPrereqs();
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict({ recordId: 'g_a', entityId: 'anthropic' })], total: 1 },
    });
    mockSuggestUrls.mockResolvedValueOnce({
      candidates: [
        { url: 'https://example.com/a', title: 'A', snippet: null, relevanceScore: null, sourceProvider: 'exa' },
      ],
      providersUsed: ['exa'],
      providersSkipped: [],
      query: 'test',
      costUsd: 0,
    });
    mockUpsertUrlSuggestions.mockResolvedValueOnce({
      ok: true,
      data: { upserted: 1 },
    });

    const result = await run({ verdict: 'partial', limit: '10' });

    expect(result.exitCode).toBe(0);
    expect(mockSuggestUrls).toHaveBeenCalledTimes(1);
    expect(mockUpsertUrlSuggestions).toHaveBeenCalledTimes(1);
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg).toHaveLength(1);
    expect(upsertArg[0]).toMatchObject({
      recordType: 'grant',
      recordId: 'g_a',
      entityId: 'anthropic',
      suggestedUrl: 'https://example.com/a',
      status: 'pending',
    });
  });
});
