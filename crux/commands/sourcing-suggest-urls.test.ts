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

vi.mock('../lib/sourcing/grade-suggestion.ts', () => ({
  gradeSuggestion: vi.fn(),
  DEFAULT_GRADER_MODEL: 'test-grader-model',
  MAX_REASONING_CHARS: 200,
}));

import { commands } from './sourcing-suggest-urls.ts';
import { suggestUrls } from '../lib/sourcing/suggest-urls.ts';
import { gradeSuggestion } from '../lib/sourcing/grade-suggestion.ts';

const suggest = commands.default;
const mockSuggestUrls = vi.mocked(suggestUrls);
const mockGradeSuggestion = vi.mocked(gradeSuggestion);

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

// ---------------------------------------------------------------------------
// QUA-592: --auto-approve-threshold integration
//
// These tests cover the wiring inside sourcing-suggest-urls (when grader is
// called, how outcomes map to status, summary tracking). The grader's own
// fail-closed behavior on JSON / schema / missing-key errors is covered in
// crux/lib/sourcing/grade-suggestion.test.ts. Here we just confirm that
// gradeSuggestion's `ok: false` outcomes correctly route to status='pending'
// at the call-site, which is the contract the apply-suggestions consumer
// depends on.
// ---------------------------------------------------------------------------

describe('sourcing-suggest-urls --auto-approve-threshold (QUA-592)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stubSingleCandidateRun(candidates: Array<{ url: string; title: string }>) {
    stubEmptyPrereqs();
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [makeVerdict({ recordId: 'g_a', entityId: 'anthropic' })],
        total: 1,
      },
    });
    mockSuggestUrls.mockResolvedValueOnce({
      candidates: candidates.map((c) => ({
        url: c.url,
        title: c.title,
        snippet: null,
        relevanceScore: null,
        sourceProvider: 'exa' as const,
      })),
      providersUsed: ['exa'],
      providersSkipped: [],
      query: 'q',
      costUsd: 0,
    });
    mockUpsertUrlSuggestions.mockResolvedValueOnce({
      ok: true,
      data: { upserted: candidates.length },
    });
  }

  it('rejects --auto-approve-threshold values outside [0, 1]', async () => {
    for (const bad of ['1.1', '-0.1', '2', 'foo']) {
      const result = await run({ 'auto-approve-threshold': bad });
      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/Invalid --auto-approve-threshold/);
    }
    expect(mockListVerdicts).not.toHaveBeenCalled();
    expect(mockGradeSuggestion).not.toHaveBeenCalled();
  });

  it('accepts --auto-approve-threshold=0 (boundary): every successful grade promotes', async () => {
    // Documenting the corner case: threshold=0 means "any successful grade
    // is good enough to auto-approve". Realistic values are 0.5–0.9 but
    // the contract is `confidence >= threshold` and 0 is a legal value.
    // If we wanted to forbid it, we'd reject in the parser. Currently we
    // don't, so this test pins that 0 means "auto-approve anything that
    // grades successfully" — not "disable auto-approve".
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    mockGradeSuggestion.mockResolvedValueOnce({
      ok: true,
      confidence: 0,
      reasoning: 'totally unrelated',
      costUsd: 0,
    });
    const result = await run({ 'auto-approve-threshold': '0', limit: '10' });
    expect(result.exitCode).toBe(0);
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg[0].status).toBe('auto_verified');
  });

  it('does not call the grader when --auto-approve-threshold is absent (default off)', async () => {
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    const result = await run({ limit: '10' });
    expect(result.exitCode).toBe(0);
    expect(mockGradeSuggestion).not.toHaveBeenCalled();
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg[0].status).toBe('pending');
    expect(upsertArg[0].notes).toBeUndefined();
  });

  it('promotes a candidate to auto_verified when grader confidence >= threshold', async () => {
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    mockGradeSuggestion.mockResolvedValueOnce({
      ok: true,
      confidence: 0.9,
      reasoning: 'title contains the claim verbatim',
      costUsd: 0,
    });
    const result = await run({ 'auto-approve-threshold': '0.8', limit: '10' });
    expect(result.exitCode).toBe(0);
    expect(mockGradeSuggestion).toHaveBeenCalledTimes(1);
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg[0]).toMatchObject({
      status: 'auto_verified',
      suggestedUrl: 'https://example.com/a',
    });
    expect(upsertArg[0].notes).toMatch(/auto-approve.*confidence=0\.90/);
  });

  it('keeps a candidate as pending when confidence < threshold AND emits NO notes', async () => {
    // Audit-trail rule: a below-threshold candidate must not write a notes
    // value, because the server's COALESCE-on-notes clause would overwrite
    // an already-present audit note from a prior auto_verified promotion
    // (the row's status would stay auto_verified per the SQL CASE, but its
    // notes would silently flip to "below-threshold..."). Omitting notes
    // here keeps re-runs idempotent for already-promoted rows.
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    mockGradeSuggestion.mockResolvedValueOnce({
      ok: true,
      confidence: 0.7,
      reasoning: 'maybe related',
      costUsd: 0,
    });
    const result = await run({ 'auto-approve-threshold': '0.8', limit: '10' });
    expect(result.exitCode).toBe(0);
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg[0].status).toBe('pending');
    expect(upsertArg[0].notes).toBeUndefined();
  });

  it('treats >= threshold as inclusive (boundary case)', async () => {
    // Inclusive boundary is the contract: a candidate scoring exactly the
    // threshold value is accepted. This matters because an LLM that returns
    // round numbers (0.5, 0.8) shouldn't be one ulp away from the cutoff.
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    mockGradeSuggestion.mockResolvedValueOnce({
      ok: true,
      confidence: 0.8,
      reasoning: 'right at threshold',
      costUsd: 0,
    });
    const result = await run({ 'auto-approve-threshold': '0.8', limit: '10' });
    expect(result.exitCode).toBe(0);
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg[0].status).toBe('auto_verified');
  });

  it('falls back to pending, counts a grader error, AND emits NO notes', async () => {
    // Same audit-trail rule as the below-threshold case: a grader error
    // must not produce a notes value that could overwrite an existing
    // auto-approve audit note on re-runs. Visibility lives in the
    // run summary's auto_approve_grader_errors counter, not in the row.
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    mockGradeSuggestion.mockResolvedValueOnce({
      ok: false,
      reason: 'JSON parse failed: ...',
      costUsd: 0,
    });
    const result = await run({
      'auto-approve-threshold': '0.8',
      limit: '10',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary.auto_approved_candidates).toBe(0);
    expect(parsed.summary.auto_approve_grader_errors).toBe(1);
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg[0].status).toBe('pending');
    expect(upsertArg[0].notes).toBeUndefined();
  });

  it('grades candidates per-record so mixed batches end up with mixed statuses', async () => {
    // The "two strong + one weak" case is the realistic one. A bug where
    // every candidate inherited the first grade (or the worst grade) would
    // either over-approve weak candidates or block strong ones.
    stubSingleCandidateRun([
      { url: 'https://strong.example.com/exact', title: 'Exact match' },
      { url: 'https://weak.example.com/maybe', title: 'Tangential' },
    ]);
    mockGradeSuggestion
      .mockResolvedValueOnce({ ok: true, confidence: 0.95, reasoning: 'exact', costUsd: 0 })
      .mockResolvedValueOnce({ ok: true, confidence: 0.4, reasoning: 'weak', costUsd: 0 });
    const result = await run({ 'auto-approve-threshold': '0.8', limit: '10' });
    expect(result.exitCode).toBe(0);
    expect(mockGradeSuggestion).toHaveBeenCalledTimes(2);
    const upsertArg = mockUpsertUrlSuggestions.mock.calls[0][0];
    expect(upsertArg).toHaveLength(2);
    const byUrl = Object.fromEntries(
      (upsertArg as Array<{ suggestedUrl: string; status: string }>).map((u) => [
        u.suggestedUrl,
        u.status,
      ]),
    );
    expect(byUrl['https://strong.example.com/exact']).toBe('auto_verified');
    expect(byUrl['https://weak.example.com/maybe']).toBe('pending');
  });

  it('passes the --auto-approve-model override down to gradeSuggestion', async () => {
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    mockGradeSuggestion.mockResolvedValueOnce({
      ok: true,
      confidence: 0.9,
      reasoning: 'ok',
      costUsd: 0,
    });
    await run({
      'auto-approve-threshold': '0.5',
      'auto-approve-model': 'sonnet',
      limit: '10',
    });
    expect(mockGradeSuggestion).toHaveBeenCalledTimes(1);
    const opts = mockGradeSuggestion.mock.calls[0][1];
    expect(opts).toMatchObject({ model: 'sonnet' });
  });

  it('reports auto_approved counts in JSON summary', async () => {
    stubSingleCandidateRun([{ url: 'https://example.com/a', title: 'A' }]);
    mockGradeSuggestion.mockResolvedValueOnce({
      ok: true,
      confidence: 0.95,
      reasoning: 'great',
      costUsd: 0,
    });
    const result = await run({
      'auto-approve-threshold': '0.8',
      limit: '10',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary.auto_approved_candidates).toBe(1);
    expect(parsed.summary.auto_approve_grader_errors).toBe(0);
  });

  it('accumulates grader costUsd into the run-wide cost meter', async () => {
    // Why this matters: --budget would be a fiction if grader spend went
    // untracked. With Haiku at ~$0.001/grade × 3 candidates × 750 records,
    // a sweep can accumulate ~$2 of LLM spend invisibly. The grader
    // returns real costUsd computed from token usage; this test pins
    // that the call site is summing it.
    stubSingleCandidateRun([
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: 'B' },
    ]);
    mockGradeSuggestion
      .mockResolvedValueOnce({ ok: true, confidence: 0.9, reasoning: 'a', costUsd: 0.0007 })
      .mockResolvedValueOnce({ ok: false, reason: 'parse fail', costUsd: 0.0003 });
    const result = await run({
      'auto-approve-threshold': '0.8',
      limit: '10',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    // Search-provider cost from the suggestUrls mock is 0; grader cost is
    // 0.0007 + 0.0003 = 0.001. Anything <= 0 would mean the call site
    // dropped the grader's costUsd field.
    expect(parsed.summary.cost_usd).toBeCloseTo(0.001, 4);
  });
});
