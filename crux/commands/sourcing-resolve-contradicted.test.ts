/**
 * Tests for sourcing-resolve-contradicted (QUA-728).
 *
 * Covers the four classification buckets, the --apply path that calls
 * suggestUrls + upsertUrlSuggestions, and the dry-run / JSON output shapes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListVerdicts = vi.fn();
const mockGetEvidenceByRecords = vi.fn();
const mockUpsertUrlSuggestions = vi.fn();

vi.mock('../lib/wiki-server/sourcing-client.ts', () => ({
  listVerdicts: (...args: unknown[]) => mockListVerdicts(...args),
  getEvidenceByRecords: (...args: unknown[]) => mockGetEvidenceByRecords(...args),
  upsertUrlSuggestions: (...args: unknown[]) => mockUpsertUrlSuggestions(...args),
  evidenceRecordKey: (rt: string, rid: string) => `${rt}|${rid}`,
  MAX_EVIDENCE_BY_RECORDS: 1000,
}));

vi.mock('../lib/sourcing/suggest-urls.ts', () => ({
  suggestUrls: vi.fn(),
  GENERATOR_MODEL: 'test-generator',
}));

vi.mock('../lib/sourcing/entity-wikidata-qid.ts', () => ({
  getEntityWikidataQid: vi.fn(),
}));

import {
  commands,
  classifyContradicted,
  resolveEntitySlug,
  type ClassifiedRecord,
} from './sourcing-resolve-contradicted.ts';
import { suggestUrls } from '../lib/sourcing/suggest-urls.ts';
import { getEntityWikidataQid } from '../lib/sourcing/entity-wikidata-qid.ts';

const resolve = commands.default;
const mockSuggestUrls = vi.mocked(suggestUrls);
const mockGetEntityWikidataQid = vi.mocked(getEntityWikidataQid);

type TestOpts = Record<string, string | boolean | undefined>;
const run = (opts: TestOpts) => resolve([], opts as Parameters<typeof resolve>[1]);

function makeVerdict(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    recordType: 'fact',
    recordId: 'f_test_1',
    fieldName: 'employees',
    entityId: 'anthropic',
    displayName: 'Anthropic employees',
    entityDisplayName: 'Anthropic',
    verdict: 'contradicted',
    confidence: 0.85,
    reasoning: 'Source said 500, fact says 1000',
    sourcesChecked: 1,
    needsRecheck: false,
    nextCheckDue: '2026-05-06',
    lastComputedAt: '2026-04-29',
    createdAt: '2026-04-01',
    updatedAt: '2026-04-29',
    ...overrides,
  };
}

function stubVerdicts(rows: Record<string, unknown>[]) {
  mockListVerdicts.mockResolvedValueOnce({
    ok: true,
    data: { verdicts: rows, total: rows.length },
  });
}

function stubEvidence(byKey: Record<string, Array<{ sourceUrl: string | null; checkerModel: string | null }>>) {
  mockGetEvidenceByRecords.mockResolvedValue({
    ok: true,
    data: { evidenceByKey: byKey },
  });
}

describe('resolveEntitySlug (pure)', () => {
  it('prefers verdict.entityId when populated', () => {
    const v = makeVerdict({ entityId: 'anthropic', recordType: 'fact' }) as never;
    expect(resolveEntitySlug(v)).toBe('anthropic');
  });

  it('parses page:<slug>:<fn> for citation recordIds', () => {
    const v = makeVerdict({
      recordType: 'citation',
      recordId: 'page:nist-ai-rmf:fn8',
      entityId: null,
    }) as never;
    expect(resolveEntitySlug(v)).toBe('nist-ai-rmf');
  });

  it('handles citation slugs with hyphens and digits', () => {
    const v = makeVerdict({
      recordType: 'citation',
      recordId: 'page:openai-2024-10-q3:fn123',
      entityId: null,
    }) as never;
    expect(resolveEntitySlug(v)).toBe('openai-2024-10-q3');
  });

  it('returns null for non-citation records with no entityId', () => {
    const v = makeVerdict({
      recordType: 'personnel',
      recordId: 'sid_personnel123',
      entityId: null,
    }) as never;
    expect(resolveEntitySlug(v)).toBe(null);
  });

  it('returns null for malformed citation recordIds', () => {
    const v = makeVerdict({
      recordType: 'citation',
      recordId: 'not-a-page-format',
      entityId: null,
    }) as never;
    expect(resolveEntitySlug(v)).toBe(null);
  });
});

describe('classifyContradicted (pure)', () => {
  const baseVerdict = makeVerdict() as never;

  it('returns no-source-url when existingUrl is null', () => {
    const c = classifyContradicted({
      verdict: baseVerdict,
      existingUrl: null,
      entityQid: 'Q108542504',
    });
    expect(c.bucket).toBe('no-source-url');
    expect(c.urlQid).toBe(null);
  });

  it('returns indeterminate when URL has no Wikidata QID', () => {
    const c = classifyContradicted({
      verdict: baseVerdict,
      existingUrl: 'https://nytimes.com/article/123',
      entityQid: 'Q108542504',
    });
    expect(c.bucket).toBe('indeterminate');
    expect(c.urlQid).toBe(null);
    expect(c.entityQid).toBe('Q108542504');
  });

  it('returns indeterminate when entity has no QID even if URL does', () => {
    const c = classifyContradicted({
      verdict: baseVerdict,
      existingUrl: 'https://www.wikidata.org/wiki/Q42',
      entityQid: null,
    });
    expect(c.bucket).toBe('indeterminate');
    expect(c.urlQid).toBe('Q42');
    expect(c.entityQid).toBe(null);
  });

  it('returns subject-match when URL QID equals entity QID', () => {
    const c = classifyContradicted({
      verdict: baseVerdict,
      existingUrl: 'https://www.wikidata.org/wiki/Q108542504',
      entityQid: 'Q108542504',
    });
    expect(c.bucket).toBe('subject-match');
    expect(c.urlQid).toBe('Q108542504');
  });

  it('returns subject-mismatch when URL QID differs from entity QID', () => {
    const c = classifyContradicted({
      verdict: baseVerdict,
      existingUrl: 'https://www.wikidata.org/wiki/Q63041604', // xAI
      entityQid: 'Q108542504', // Anthropic
    });
    expect(c.bucket).toBe('subject-mismatch');
    expect(c.urlQid).toBe('Q63041604');
    expect(c.entityQid).toBe('Q108542504');
  });

  it('handles wikidata.org/entity/Q-form URLs', () => {
    const c = classifyContradicted({
      verdict: baseVerdict,
      existingUrl: 'https://www.wikidata.org/entity/Q42',
      entityQid: 'Q42',
    });
    expect(c.bucket).toBe('subject-match');
  });
});

describe('sourcing-resolve-contradicted command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuggestUrls.mockReset();
    mockGetEntityWikidataQid.mockReset();
  });

  it('dry-run by default — does not call suggestUrls or upsertUrlSuggestions', async () => {
    stubVerdicts([
      makeVerdict(),
      makeVerdict({ recordId: 'f_test_2', entityId: 'openai' }),
    ]);
    stubEvidence({
      'fact|f_test_1': [{ sourceUrl: 'https://www.wikidata.org/wiki/Q42', checkerModel: 'haiku' }],
      'fact|f_test_2': [{ sourceUrl: 'https://nytimes.com/x', checkerModel: 'haiku' }],
    });
    mockGetEntityWikidataQid.mockImplementation((slug) => {
      if (slug === 'anthropic') return 'Q108542504';
      if (slug === 'openai') return 'Q108547853';
      return null;
    });

    const result = await run({});
    expect(result.exitCode).toBe(0);
    expect(mockSuggestUrls).not.toHaveBeenCalled();
    expect(mockUpsertUrlSuggestions).not.toHaveBeenCalled();
    // Anthropic record: URL Q42 != entity Q108542504 → subject-mismatch
    // OpenAI record: nytimes URL has no QID → indeterminate
    expect(result.output).toContain('subject-mismatch:     1');
    expect(result.output).toContain('indeterminate:        1');
  });

  it('--apply writes URL suggestions only for subject-mismatch records', async () => {
    stubVerdicts([
      // subject-mismatch: URL Q63041604 vs entity Q108542504
      makeVerdict({ recordId: 'f_mismatch', entityId: 'anthropic' }),
      // subject-match: URL Q42 vs entity Q42
      makeVerdict({ recordId: 'f_match', entityId: 'fortytwo' }),
      // indeterminate: nytimes URL
      makeVerdict({ recordId: 'f_indeterminate', entityId: 'openai' }),
      // no-source-url
      makeVerdict({ recordId: 'f_no_url', entityId: 'mistral' }),
    ]);
    stubEvidence({
      'fact|f_mismatch': [{ sourceUrl: 'https://www.wikidata.org/wiki/Q63041604', checkerModel: 'haiku' }],
      'fact|f_match': [{ sourceUrl: 'https://www.wikidata.org/wiki/Q42', checkerModel: 'haiku' }],
      'fact|f_indeterminate': [{ sourceUrl: 'https://nytimes.com/x', checkerModel: 'haiku' }],
      // f_no_url not present in evidenceByKey
    });
    mockGetEntityWikidataQid.mockImplementation((slug) => {
      if (slug === 'anthropic') return 'Q108542504';
      if (slug === 'fortytwo') return 'Q42';
      if (slug === 'openai') return 'Q108547853';
      return null; // mistral
    });
    mockSuggestUrls.mockResolvedValueOnce({
      candidates: [
        {
          url: 'https://anthropic.com/news/employees',
          title: 'Anthropic employees',
          snippet: 'about 500 employees',
          relevanceScore: null,
          sourceProvider: 'exa',
        },
      ],
      providersUsed: ['exa'],
      providersSkipped: [],
      query: 'q',
      costUsd: 0.01,
      subjectMismatches: [],
    });
    mockUpsertUrlSuggestions.mockResolvedValueOnce({
      ok: true,
      data: { upserted: 1 },
    });

    const result = await run({ apply: true });
    expect(result.exitCode).toBe(0);
    // Only the subject-mismatch record should reach suggestUrls.
    expect(mockSuggestUrls).toHaveBeenCalledTimes(1);
    expect(mockSuggestUrls).toHaveBeenCalledWith(
      expect.objectContaining({
        entityWikidataQid: 'Q108542504',
        existingUrl: 'https://www.wikidata.org/wiki/Q63041604',
      }),
    );
    expect(mockUpsertUrlSuggestions).toHaveBeenCalledTimes(1);
    expect(mockUpsertUrlSuggestions).toHaveBeenCalledWith([
      expect.objectContaining({
        recordType: 'fact',
        recordId: 'f_mismatch',
        suggestedUrl: 'https://anthropic.com/news/employees',
        status: 'pending',
      }),
    ]);
    expect(result.output).toContain('1 suggestion(s) written across 1 record(s)');
  });

  it('--apply with no candidates from suggestUrls counts as no-replacement', async () => {
    stubVerdicts([makeVerdict({ recordId: 'f_mismatch', entityId: 'anthropic' })]);
    stubEvidence({
      'fact|f_mismatch': [{ sourceUrl: 'https://www.wikidata.org/wiki/Q63041604', checkerModel: 'haiku' }],
    });
    mockGetEntityWikidataQid.mockReturnValue('Q108542504');
    mockSuggestUrls.mockResolvedValueOnce({
      candidates: [],
      providersUsed: ['exa'],
      providersSkipped: [],
      query: 'q',
      costUsd: 0,
      subjectMismatches: [
        { url: 'https://example.com/wrong', candidateQid: 'Q9999', entityQid: 'Q108542504' },
      ],
    });

    const result = await run({ apply: true });
    expect(result.exitCode).toBe(0);
    expect(mockSuggestUrls).toHaveBeenCalledTimes(1);
    expect(mockUpsertUrlSuggestions).not.toHaveBeenCalled();
    expect(result.output).toContain('Replaceable URL found:  0');
    expect(result.output).toContain('No replacement:         1');
    expect(result.output).toContain('Provider gate drops:    1');
  });

  it('--type filter passes through to listVerdicts', async () => {
    stubVerdicts([]);
    const result = await run({ type: 'personnel' });
    expect(result.exitCode).toBe(0);
    expect(mockListVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: 'personnel', verdict: 'contradicted' }),
    );
  });

  it('--entity filter trims to one entity', async () => {
    stubVerdicts([
      makeVerdict({ recordId: 'f_a', entityId: 'anthropic', entityDisplayName: 'Anthropic' }),
      makeVerdict({ recordId: 'f_b', entityId: 'openai', entityDisplayName: 'OpenAI' }),
    ]);
    stubEvidence({});
    mockGetEntityWikidataQid.mockReturnValue(null);
    const result = await run({ entity: 'anthropic' });
    expect(result.exitCode).toBe(0);
    // Only f_a should appear in scanned counts.
    expect(result.output).toContain('Scanned:                1');
  });

  it('--json emits machine-readable output with the four buckets', async () => {
    stubVerdicts([
      makeVerdict({ recordId: 'f_mismatch', entityId: 'anthropic' }),
      makeVerdict({ recordId: 'f_match', entityId: 'fortytwo' }),
    ]);
    stubEvidence({
      'fact|f_mismatch': [{ sourceUrl: 'https://www.wikidata.org/wiki/Q63041604', checkerModel: 'haiku' }],
      'fact|f_match': [{ sourceUrl: 'https://www.wikidata.org/wiki/Q42', checkerModel: 'haiku' }],
    });
    mockGetEntityWikidataQid.mockImplementation((slug) => {
      if (slug === 'anthropic') return 'Q108542504';
      if (slug === 'fortytwo') return 'Q42';
      return null;
    });

    const result = await run({ json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary).toMatchObject({
      scanned: 2,
      by_bucket: {
        'subject-mismatch': 1,
        'subject-match': 1,
        indeterminate: 0,
        'no-source-url': 0,
      },
      dry_run: true,
    });
    expect(parsed.records).toHaveLength(2);
    const mismatch = parsed.records.find((r: { record_id: string }) => r.record_id === 'f_mismatch');
    expect(mismatch).toMatchObject({
      bucket: 'subject-mismatch',
      url_qid: 'Q63041604',
      entity_qid: 'Q108542504',
    });
  });

  it('surfaces listVerdicts failures with a clear error', async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: false,
      message: 'connection refused',
      error: { code: 'HTTP_500' },
    });
    const result = await run({});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Failed to fetch contradicted verdicts');
    expect(result.output).toContain('connection refused');
  });

  it('surfaces evidence batch failures with a clear error', async () => {
    stubVerdicts([makeVerdict()]);
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: false,
      message: 'evidence fetch failed',
      error: { code: 'HTTP_500' },
    });
    const result = await run({});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Failed to batch-fetch evidence');
  });

  it('surfaces upsert failures during --apply', async () => {
    stubVerdicts([makeVerdict({ recordId: 'f_mismatch', entityId: 'anthropic' })]);
    stubEvidence({
      'fact|f_mismatch': [{ sourceUrl: 'https://www.wikidata.org/wiki/Q63041604', checkerModel: 'haiku' }],
    });
    mockGetEntityWikidataQid.mockReturnValue('Q108542504');
    mockSuggestUrls.mockResolvedValueOnce({
      candidates: [{
        url: 'https://anthropic.com/news', title: 't', snippet: 's',
        relevanceScore: null, sourceProvider: 'exa',
      }],
      providersUsed: ['exa'], providersSkipped: [],
      query: 'q', costUsd: 0, subjectMismatches: [],
    });
    mockUpsertUrlSuggestions.mockResolvedValueOnce({
      ok: false,
      message: 'duplicate key',
    });

    const result = await run({ apply: true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('upsert failed');
    expect(result.output).toContain('duplicate key');
  });

  it('honors --budget by short-circuiting tasks past the cap', async () => {
    // 8 subject-mismatch records, $0.60 each. With internal concurrency 5,
    // the first batch of 5 all pass the gate (cost=0 at start) and finish
    // with cost=3.0; the remaining 3 short-circuit before calling suggestUrls
    // because the gate trips.
    const verdicts = Array.from({ length: 8 }, (_, i) =>
      makeVerdict({ recordId: `f_${i}`, entityId: 'anthropic', entityDisplayName: 'Anthropic' }),
    );
    stubVerdicts(verdicts);
    const evidenceByKey: Record<string, Array<{ sourceUrl: string; checkerModel: string }>> = {};
    for (const v of verdicts) {
      evidenceByKey[`fact|${v.recordId}`] = [
        { sourceUrl: 'https://www.wikidata.org/wiki/Q63041604', checkerModel: 'haiku' },
      ];
    }
    stubEvidence(evidenceByKey);
    mockGetEntityWikidataQid.mockReturnValue('Q108542504');
    mockSuggestUrls.mockResolvedValue({
      candidates: [],
      providersUsed: ['exa'],
      providersSkipped: [],
      query: 'q',
      costUsd: 0.6,
      subjectMismatches: [],
    });

    const result = await run({ apply: true, budget: '0.5' });
    expect(result.exitCode).toBe(0);
    // First batch runs (5 calls) and exhausts the budget; the remaining 3
    // short-circuit. Exact call count can vary by scheduling but must be
    // strictly less than the 8 records.
    expect(mockSuggestUrls.mock.calls.length).toBeLessThan(verdicts.length);
    expect(result.output).toContain('Budget exhausted:       yes');
  });

  it('resolves citation page slug → entity QID even when verdict.entityId is null', async () => {
    // Citation recordIds carry the wiki page slug (which is the entity slug
    // in this codebase). Without slug-parsing this row would land in
    // 'indeterminate' even when external-links.yaml has a QID.
    stubVerdicts([
      makeVerdict({
        recordType: 'citation',
        recordId: 'page:anthropic:fn3',
        entityId: null,
      }),
    ]);
    stubEvidence({
      'citation|page:anthropic:fn3': [
        { sourceUrl: 'https://www.wikidata.org/wiki/Q63041604', checkerModel: 'haiku' },
      ],
    });
    mockGetEntityWikidataQid.mockImplementation((slug) =>
      slug === 'anthropic' ? 'Q108542504' : null,
    );

    const result = await run({});
    expect(result.exitCode).toBe(0);
    // URL Q63041604 != entity Q108542504 → subject-mismatch
    expect(result.output).toContain('subject-mismatch:     1');
    // Sanity-check: getEntityWikidataQid was called with the parsed slug.
    expect(mockGetEntityWikidataQid).toHaveBeenCalledWith('anthropic');
  });

  it('rejects --limit that is non-positive', async () => {
    stubVerdicts([]);
    const result = await run({ limit: 'abc' });
    expect(result.exitCode).toBe(0);
    // Falls back to default; non-numeric input is logged but not fatal.
    expect(mockListVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });
});

describe('sourcing-resolve-contradicted classification matrix', () => {
  // Sanity matrix to lock in the bucket assignment table from the help text.
  const baseVerdict = makeVerdict() as never;
  const cases: Array<{
    name: string;
    existingUrl: string | null;
    entityQid: string | null;
    expected: ClassifiedRecord['bucket'];
  }> = [
    { name: 'no URL, has entity QID', existingUrl: null, entityQid: 'Q1', expected: 'no-source-url' },
    { name: 'URL no QID, has entity QID', existingUrl: 'https://x.com/a', entityQid: 'Q1', expected: 'indeterminate' },
    { name: 'URL has QID, no entity QID', existingUrl: 'https://www.wikidata.org/wiki/Q1', entityQid: null, expected: 'indeterminate' },
    { name: 'matching QIDs', existingUrl: 'https://www.wikidata.org/wiki/Q1', entityQid: 'Q1', expected: 'subject-match' },
    { name: 'mismatching QIDs', existingUrl: 'https://www.wikidata.org/wiki/Q1', entityQid: 'Q2', expected: 'subject-mismatch' },
  ];
  it.each(cases)('$name → $expected', ({ existingUrl, entityQid, expected }) => {
    const c = classifyContradicted({ verdict: baseVerdict, existingUrl, entityQid });
    expect(c.bucket).toBe(expected);
  });
});
