/**
 * Tests for sourcing-retro-scan-subjects (QUA-650).
 *
 * Focus:
 *   - prompt construction (subject-identity only, no value re-verification)
 *   - LLM response parsing (schema validation, malformed input)
 *   - classifyEvidence (deterministic skip logic)
 *   - applyDowngrade (verdict + reasoning prefix + needsRecheck + evidence row)
 *   - end-to-end dry-run path (no LLM call)
 *   - end-to-end apply path (mismatch triggers downgrade)
 *
 * Uses mocks so no real wiki-server / LLM calls occur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

const mockListVerdicts = vi.fn();
const mockStoreVerdict = vi.fn();
const mockGetEvidenceByRecords = vi.fn();

vi.mock('../lib/wiki-server/sourcing-client.ts', () => ({
  listVerdicts: (...args: unknown[]) => mockListVerdicts(...args),
  storeVerdict: (...args: unknown[]) => mockStoreVerdict(...args),
  getEvidenceByRecords: (...args: unknown[]) => mockGetEvidenceByRecords(...args),
  evidenceRecordKey: (rt: string, rid: string) => `${rt}|${rid}`,
  MAX_EVIDENCE_BY_RECORDS: 1000,
}));

const mockCallLlm = vi.fn();
vi.mock('../lib/llm.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/llm.ts')>('../lib/llm.ts');
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({})),
    callLlm: (...args: unknown[]) => mockCallLlm(...args),
  };
});

const mockFetchSourceContent = vi.fn();
const mockStoreSourcingEvidence = vi.fn();
vi.mock('../lib/sourcing/index.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/sourcing/index.ts')>(
    '../lib/sourcing/index.ts',
  );
  return {
    ...actual,
    fetchSourceContent: (...args: unknown[]) => mockFetchSourceContent(...args),
    storeSourcingEvidence: (...args: unknown[]) => mockStoreSourcingEvidence(...args),
  };
});

import {
  commands,
  buildSubjectIdentityPrompt,
  callSubjectIdentityCheck,
  classifyEvidence,
  applyDowngrade,
  SubjectCheckSchema,
} from './sourcing-retro-scan-subjects.ts';

const retroScan = commands.default;

function makeVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordType: 'fact',
    recordId: 'f_QYAnAj3qg6',
    fieldName: null,
    entityId: 'microsoft',
    displayName: 'Microsoft CEO fact',
    entityDisplayName: 'Microsoft Corporation',
    verdict: 'confirmed',
    confidence: 0.95,
    reasoning: 'Source directly states that Mustafa Süleyman is CEO of Microsoft AI.',
    sourcesChecked: 1,
    needsRecheck: false,
    nextCheckDue: '2026-07-16',
    lastComputedAt: '2026-04-16',
    createdAt: '2026-04-10',
    updatedAt: '2026-04-16',
    ...overrides,
  };
}

function makeEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    recordType: 'fact',
    recordId: 'f_QYAnAj3qg6',
    sourceUrl: 'https://www.wikidata.org/wiki/Q125891217',
    checkerModel: 'claude-haiku-4-5-20251001',
    verdict: 'confirmed',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Unit tests ───────────────────────────────────────────────────────

describe('buildSubjectIdentityPrompt', () => {
  it('includes the claim subject, source URL, and truncated source content', () => {
    const prompt = buildSubjectIdentityPrompt({
      claimSubjectLabel: 'Microsoft Corporation',
      recordType: 'fact',
      fieldName: null,
      recordLabel: 'ceo = Mustafa Süleyman',
      sourceUrl: 'https://wikidata.org/wiki/Q125891217',
      sourceContent: 'A'.repeat(20_000),
      previousReasoning: 'Old reasoning',
      maxContentChars: 1000,
    });
    expect(prompt).toContain('Microsoft Corporation');
    expect(prompt).toContain('https://wikidata.org/wiki/Q125891217');
    expect(prompt).toContain('"subjects_match": true | false');
    expect(prompt).toContain('Old reasoning');
    // Source content was truncated to 1000
    const aRun = prompt.match(/A{1000,}/);
    expect(aRun?.[0].length).toBeLessThanOrEqual(1000);
  });

  it('escapes XML-special chars in interpolated fields (prompt injection defense)', () => {
    const prompt = buildSubjectIdentityPrompt({
      claimSubjectLabel: 'Evil <script>alert("x")</script>',
      recordType: 'fact',
      fieldName: 'ceo & cfo',
      recordLabel: 'mal <bogus> label',
      sourceUrl: 'https://example.com',
      sourceContent: '<malicious>injection</malicious>',
      previousReasoning: 'Prior <eval>',
      maxContentChars: 1000,
    });
    expect(prompt).not.toContain('<script>alert');
    expect(prompt).toContain('&lt;script&gt;');
    expect(prompt).toContain('&lt;malicious&gt;');
    expect(prompt).toContain('ceo &amp; cfo');
  });

  it('omits previous reasoning block when none is supplied', () => {
    const prompt = buildSubjectIdentityPrompt({
      claimSubjectLabel: 'X',
      recordType: 'fact',
      fieldName: null,
      recordLabel: 'r',
      sourceUrl: 'https://u',
      sourceContent: 'c',
      previousReasoning: null,
      maxContentChars: 500,
    });
    expect(prompt).toContain('(none recorded)');
  });
});

describe('SubjectCheckSchema', () => {
  it('parses a valid LLM response', () => {
    const parsed = SubjectCheckSchema.safeParse({
      source_subject: 'Microsoft AI',
      subjects_match: false,
      confidence: 0.9,
      reasoning: 'Source is about Microsoft AI subsidiary.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subjects_match).toBe(false);
      expect(parsed.data.source_subject).toBe('Microsoft AI');
    }
  });

  it('rejects a response missing subjects_match (required)', () => {
    const parsed = SubjectCheckSchema.safeParse({
      source_subject: 'Foo',
      confidence: 0.5,
      reasoning: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults optional fields when absent', () => {
    const parsed = SubjectCheckSchema.safeParse({ subjects_match: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source_subject).toBe('');
      expect(parsed.data.confidence).toBe(0.5);
      expect(parsed.data.reasoning).toBe('');
    }
  });
});

describe('callSubjectIdentityCheck', () => {
  it('returns ok on a well-formed JSON response', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: '{"source_subject":"Microsoft AI","subjects_match":false,"confidence":0.95,"reasoning":"Source is Microsoft AI, not Microsoft Corp."}',
    });
    const res = await callSubjectIdentityCheck({} as never, 'prompt', 'label');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.subjects_match).toBe(false);
      expect(res.data.source_subject).toBe('Microsoft AI');
    }
  });

  it('returns an error when LLM throws', async () => {
    mockCallLlm.mockRejectedValueOnce(new Error('Anthropic 500'));
    const res = await callSubjectIdentityCheck({} as never, 'prompt', 'label');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('LLM call failed');
      expect(res.error).toContain('Anthropic 500');
    }
  });

  it('returns an error when the response fails schema validation', async () => {
    mockCallLlm.mockResolvedValueOnce({ text: '{"source_subject":"X"}' }); // missing subjects_match
    const res = await callSubjectIdentityCheck({} as never, 'prompt', 'label');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('failed validation');
  });
});

describe('classifyEvidence', () => {
  it('marks rows whose every evidence is from a deterministic checker as skip', async () => {
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: {
        evidenceByKey: {
          'fact|f_detA': [
            makeEvidence({ checkerModel: 'wikidata-api' }),
            makeEvidence({ checkerModel: 'deterministic-row-match' }),
          ],
          'fact|f_llmA': [makeEvidence({ checkerModel: 'claude-haiku-4-5-20251001' })],
        },
      },
    });
    const res = await classifyEvidence([
      makeVerdict({ recordId: 'f_detA' }) as never,
      makeVerdict({ recordId: 'f_llmA' }) as never,
    ]);
    expect(res.get('fact|f_detA')).toEqual({ skip: 'deterministic' });
    expect(res.get('fact|f_llmA')).toEqual({ sourceUrl: 'https://www.wikidata.org/wiki/Q125891217' });
  });

  it('omits records with no evidence entirely (caller treats as skip:no-source-url)', async () => {
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: { evidenceByKey: {} },
    });
    const res = await classifyEvidence([makeVerdict() as never]);
    expect(res.size).toBe(0);
  });

  it('prefers the most recent non-deterministic evidence when both exist', async () => {
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: {
        evidenceByKey: {
          'fact|f_mixed': [
            makeEvidence({ checkerModel: 'wikidata-api', sourceUrl: 'https://wd/deterministic' }),
            makeEvidence({ checkerModel: 'claude-haiku-4-5-20251001', sourceUrl: 'https://llm/source' }),
          ],
        },
      },
    });
    const res = await classifyEvidence([makeVerdict({ recordId: 'f_mixed' }) as never]);
    // Picks the first non-deterministic row — the LLM-sourced URL, since
    // the wikidata-api row is filtered out as deterministic. That's the
    // target we want: the row with the subject-identity defect potential.
    expect(res.get('fact|f_mixed')).toEqual({ sourceUrl: 'https://llm/source' });
  });

  it('throws on batch evidence fetch failure (fail-loud, per QUA-331 rationale)', async () => {
    mockGetEvidenceByRecords.mockResolvedValueOnce({ ok: false, message: 'boom' });
    await expect(classifyEvidence([makeVerdict() as never])).rejects.toThrow(/boom/);
  });

  it('returns empty map without API call when verdict list is empty', async () => {
    const res = await classifyEvidence([]);
    expect(res.size).toBe(0);
    expect(mockGetEvidenceByRecords).not.toHaveBeenCalled();
  });

  it('chunks requests larger than MAX_EVIDENCE_BY_RECORDS (1000)', async () => {
    // 2500 verdicts → 3 chunks (1000, 1000, 500).
    const bigList = Array.from({ length: 2500 }, (_, i) =>
      makeVerdict({ recordId: `f_${i}` }),
    );
    mockGetEvidenceByRecords.mockResolvedValue({
      ok: true,
      data: { evidenceByKey: {} },
    });
    const res = await classifyEvidence(bigList as never);
    expect(res.size).toBe(0);
    expect(mockGetEvidenceByRecords).toHaveBeenCalledTimes(3);
    const callArgLengths = mockGetEvidenceByRecords.mock.calls.map(
      (c) => (c[0] as Array<unknown>).length,
    );
    expect(callArgLengths).toEqual([1000, 1000, 500]);
  });
});

describe('applyDowngrade', () => {
  it('persists verdict=partial + needsRecheck=true + prefixed reasoning', async () => {
    mockStoreVerdict.mockResolvedValueOnce({ ok: true, data: { ok: true } });
    mockStoreSourcingEvidence.mockResolvedValueOnce(undefined);

    const verdict = makeVerdict();
    await applyDowngrade(
      verdict as never,
      {
        source_subject: 'Microsoft AI',
        subjects_match: false,
        confidence: 0.9,
        reasoning: 'Wikidata page is Microsoft AI (Q125891217), not Microsoft Corp (Q2283).',
      },
      'Microsoft Corporation',
      'https://www.wikidata.org/wiki/Q125891217',
    );

    expect(mockStoreVerdict).toHaveBeenCalledOnce();
    const body = mockStoreVerdict.mock.calls[0][0] as Record<string, unknown>;
    expect(body.verdict).toBe('partial');
    expect(body.needsRecheck).toBe(true);
    expect(body.recordType).toBe('fact');
    expect(body.recordId).toBe('f_QYAnAj3qg6');
    expect(body.entityId).toBe('microsoft');
    expect(body.displayName).toBe('Microsoft CEO fact');
    expect(body.entityDisplayName).toBe('Microsoft Corporation');
    expect(body.sourcesChecked).toBe(1);
    expect(String(body.reasoning)).toMatch(/^\[retro-scan QUA-650: subject-mismatch/);
    expect(String(body.reasoning)).toContain('Microsoft AI');
    // Original reasoning preserved after the prefix
    expect(String(body.reasoning)).toContain('Mustafa Süleyman');

    expect(mockStoreSourcingEvidence).toHaveBeenCalledOnce();
    const evBody = mockStoreSourcingEvidence.mock.calls[0][0] as Record<string, unknown>;
    expect(evBody.checkerModel).toBe('qua650-retro-scan-subject-identity');
    expect(evBody.verdict).toBe('partial');
    expect(evBody.extractedValue).toContain('Microsoft AI');
  });

  it('throws when the verdict-upsert API reports !ok', async () => {
    mockStoreVerdict.mockResolvedValueOnce({ ok: false, error: 'db down' });
    await expect(
      applyDowngrade(
        makeVerdict() as never,
        { source_subject: 's', subjects_match: false, confidence: 0.5, reasoning: 'r' },
        'Claim',
        'https://u',
      ),
    ).rejects.toThrow(/db down/);
    expect(mockStoreSourcingEvidence).not.toHaveBeenCalled();
  });

  it('sanitizes newlines and quotes in the mismatch prefix (parseability)', async () => {
    mockStoreVerdict.mockResolvedValueOnce({ ok: true, data: { ok: true } });
    mockStoreSourcingEvidence.mockResolvedValueOnce(undefined);

    // LLM hands us a source_subject with newlines and a stray quote — naïve
    // interpolation would break any regex trying to extract the retro-scan
    // marker from the reasoning field later.
    await applyDowngrade(
      makeVerdict() as never,
      {
        source_subject: 'Microsoft AI\n(subsidiary "A")\n— ref Q125891217',
        subjects_match: false,
        confidence: 0.9,
        reasoning: 'r',
      },
      'Microsoft Corporation',
      'https://u',
    );
    const body = mockStoreVerdict.mock.calls[0][0] as Record<string, unknown>;
    const reasoning = String(body.reasoning);
    // No raw newlines inside the bracketed prefix
    const prefix = reasoning.split(']')[0] + ']';
    expect(prefix).not.toContain('\n');
    // Double-quotes replaced with single quotes so the literal delimiters stay unambiguous
    expect(prefix).not.toMatch(/"[A-Za-z]+\s*"[A-Za-z]+/);
    expect(prefix).toContain("Microsoft AI (subsidiary 'A')");
  });

  it('does not throw when evidence write fails (best-effort audit row)', async () => {
    mockStoreVerdict.mockResolvedValueOnce({ ok: true, data: { ok: true } });
    mockStoreSourcingEvidence.mockRejectedValueOnce(new Error('evidence table down'));

    await expect(
      applyDowngrade(
        makeVerdict() as never,
        { source_subject: 's', subjects_match: false, confidence: 0.5, reasoning: 'r' },
        'Claim',
        'https://u',
      ),
    ).resolves.toBeUndefined();
  });
});

// ── End-to-end (command invocation) ─────────────────────────────────

describe('retroScan command', () => {
  const tempReports: string[] = [];
  afterEach(() => {
    for (const p of tempReports) {
      if (existsSync(p)) unlinkSync(p);
    }
    tempReports.length = 0;
  });

  it('dry-run returns a preview without calling the LLM', async () => {
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict()], total: 9578 },
    });
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: { evidenceByKey: { 'fact|f_QYAnAj3qg6': [makeEvidence()] } },
    });

    const result = await retroScan([], { limit: '1', 'dry-run': true, ci: true } as never);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.totalMatching).toBe(9578);
    expect(parsed.wouldCheck).toBe(1);
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('--apply path downgrades a mismatched confirmed verdict', async () => {
    const reportPath = `/tmp/qua650-test-${Date.now()}.jsonl`;
    tempReports.push(reportPath);

    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict()], total: 1 },
    });
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: { evidenceByKey: { 'fact|f_QYAnAj3qg6': [makeEvidence()] } },
    });
    mockFetchSourceContent.mockResolvedValueOnce({
      content: 'Microsoft AI is led by Mustafa Süleyman as of March 2024.',
    });
    mockCallLlm.mockResolvedValueOnce({
      text: '{"source_subject":"Microsoft AI","subjects_match":false,"confidence":0.95,"reasoning":"Source is about Microsoft AI, not Microsoft Corp."}',
    });
    mockStoreVerdict.mockResolvedValueOnce({ ok: true, data: { ok: true } });
    mockStoreSourcingEvidence.mockResolvedValueOnce(undefined);

    const result = await retroScan([], {
      limit: '1',
      apply: true,
      concurrency: '1',
      report: reportPath,
      ci: true,
    } as never);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary.mismatches).toBe(1);
    expect(parsed.summary.downgraded).toBe(1);
    expect(parsed.summary.errors).toBe(0);

    expect(mockStoreVerdict).toHaveBeenCalledOnce();
    const body = mockStoreVerdict.mock.calls[0][0] as Record<string, unknown>;
    expect(body.verdict).toBe('partial');
    expect(body.needsRecheck).toBe(true);

    // JSONL report written
    expect(existsSync(reportPath)).toBe(true);
    const lines = readFileSync(reportPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + outcome + trailer
    const header = JSON.parse(lines[0]);
    expect(header.kind).toBe('qua650-retro-scan-header');
    const trailer = JSON.parse(lines[lines.length - 1]);
    expect(trailer.kind).toBe('qua650-retro-scan-trailer');
    expect(trailer.summary.downgraded).toBe(1);
  });

  it('--scan-only runs LLM but does not persist downgrades', async () => {
    const reportPath = `/tmp/qua650-test-scan-only-${Date.now()}.jsonl`;
    tempReports.push(reportPath);

    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict()], total: 1 },
    });
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: { evidenceByKey: { 'fact|f_QYAnAj3qg6': [makeEvidence()] } },
    });
    mockFetchSourceContent.mockResolvedValueOnce({ content: 'Microsoft AI content' });
    mockCallLlm.mockResolvedValueOnce({
      text: '{"source_subject":"Microsoft AI","subjects_match":false,"confidence":0.9,"reasoning":"r"}',
    });

    const result = await retroScan([], {
      limit: '1',
      'scan-only': true,
      concurrency: '1',
      report: reportPath,
      ci: true,
    } as never);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary.mismatches).toBe(1);
    expect(parsed.summary.downgraded).toBe(0);
    // CRITICAL: no writes in scan-only mode even when mismatches found.
    expect(mockStoreVerdict).not.toHaveBeenCalled();
    expect(mockStoreSourcingEvidence).not.toHaveBeenCalled();
  });

  it('leaves matching subjects alone (no downgrade)', async () => {
    const reportPath = `/tmp/qua650-test-match-${Date.now()}.jsonl`;
    tempReports.push(reportPath);

    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict()], total: 1 },
    });
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: { evidenceByKey: { 'fact|f_QYAnAj3qg6': [makeEvidence()] } },
    });
    mockFetchSourceContent.mockResolvedValueOnce({ content: 'Microsoft Corp is a software company.' });
    mockCallLlm.mockResolvedValueOnce({
      text: '{"source_subject":"Microsoft Corporation","subjects_match":true,"confidence":0.92,"reasoning":"Page is about MSFT."}',
    });

    const result = await retroScan([], {
      limit: '1',
      apply: true,
      concurrency: '1',
      report: reportPath,
      ci: true,
    } as never);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary.matches).toBe(1);
    expect(parsed.summary.mismatches).toBe(0);
    expect(parsed.summary.downgraded).toBe(0);
    expect(mockStoreVerdict).not.toHaveBeenCalled();
  });

  it('skips rows whose only claim subject is a raw sid_ (display-name leak, QUA-407)', async () => {
    const reportPath = `/tmp/qua650-test-sid-${Date.now()}.jsonl`;
    tempReports.push(reportPath);

    // entityDisplayName / displayName both fall back to entityId, which is a raw sid_.
    // The LLM would always say "mismatch" ("X is an opaque id") if we ran this — so
    // we must skip to avoid false-downgrading verdicts whose only defect is the
    // stale *_display_name cache.
    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: {
        verdicts: [
          makeVerdict({
            recordId: 'f_sid_leak',
            entityId: 'sid_GLXKjYAEKw',
            displayName: null,
            entityDisplayName: null,
          }),
        ],
        total: 1,
      },
    });
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: {
        evidenceByKey: {
          'fact|f_sid_leak': [makeEvidence({ checkerModel: 'claude-haiku-4-5-20251001' })],
        },
      },
    });

    const result = await retroScan([], {
      limit: '1',
      apply: true,
      concurrency: '1',
      report: reportPath,
      ci: true,
    } as never);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary.skipped).toBe(1);
    expect(parsed.summary.scanned).toBe(0);
    expect(mockFetchSourceContent).not.toHaveBeenCalled();
    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(mockStoreVerdict).not.toHaveBeenCalled();
  });

  it('skips deterministic-checker rows without fetching source or calling LLM', async () => {
    const reportPath = `/tmp/qua650-test-det-${Date.now()}.jsonl`;
    tempReports.push(reportPath);

    mockListVerdicts.mockResolvedValueOnce({
      ok: true,
      data: { verdicts: [makeVerdict({ recordId: 'f_det' })], total: 1 },
    });
    mockGetEvidenceByRecords.mockResolvedValueOnce({
      ok: true,
      data: {
        evidenceByKey: {
          'fact|f_det': [makeEvidence({ checkerModel: 'wikidata-api' })],
        },
      },
    });

    const result = await retroScan([], {
      limit: '1',
      apply: true,
      concurrency: '1',
      report: reportPath,
      ci: true,
    } as never);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.summary.skipped).toBe(1);
    expect(parsed.summary.scanned).toBe(0);
    expect(mockFetchSourceContent).not.toHaveBeenCalled();
    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(mockStoreVerdict).not.toHaveBeenCalled();
  });

  it('rejects invalid --limit / --budget / --max-content', async () => {
    const tests: Array<[Record<string, unknown>, string]> = [
      [{ limit: '0' }, '--limit'],
      [{ limit: 'abc' }, '--limit'],
      [{ offset: '-1' }, '--offset'],
      [{ budget: '0' }, '--budget'],
      [{ 'max-content': '100' }, '--max-content'],
    ];
    for (const [opts, needle] of tests) {
      const result = await retroScan([], { apply: true, ...opts } as never);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(needle);
    }
  });

  it('caps effective limit by --budget (cost control)', async () => {
    // budget=$0.003 → max 1 call at $0.003/check
    mockListVerdicts.mockResolvedValueOnce({ ok: true, data: { verdicts: [], total: 0 } });

    await retroScan([], { limit: '100', budget: '0.003', 'dry-run': true, ci: true } as never);
    // listVerdicts should have been called with limit <= 1 on the first page
    const firstCall = mockListVerdicts.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.limit).toBeLessThanOrEqual(1);
  });
});
