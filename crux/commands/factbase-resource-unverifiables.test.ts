/**
 * Tests for `crux fb resource-unverifiables` — QUA-934.
 *
 * Cover:
 *   1. Filter: only unverifiable facts (with sources) are processed.
 *   2. Engine input: existingSourceUrl is passed in.
 *   3. Replace path: actionable best (different from existing) → YAML overwrite,
 *      verify chain runs.
 *   4. Confirm-existing path: best === existing → no write, manual-review entry.
 *   5. No-best path: best === null → no write, manual-review entry.
 *   6. Engine error path: error → manual-review entry, no write.
 *   7. Dry-run: discoveries happen, no writes, no manual-review file written.
 *   8. --apply writes manual-review file by default.
 *   9. --batch path: builds batch requests, submits, polls, parses responses.
 *  10. Verify chain: only triggers on physical replacements (kind === 'replaced').
 *  11. JSON output shape includes summary, results, writes, manualReview.
 *  12. Wiki-server fetch failure surfaces as a non-zero exit with error message.
 *  13. Provenance: notes field is annotated with [auto-replaced by qua-934].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDocument } from 'yaml';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Larger test timeout for cold KB load (~440ms locally, ~5s on CI).
vi.setConfig({ testTimeout: 30_000 });

// ── Engine mocks ─────────────────────────────────────────────────────

const mockDiscoverSourceForFact = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockBuildDiscoveryBatchRequest = vi.fn<(...args: unknown[]) => unknown>(
  (input: unknown, _opts?: unknown) => {
    const fact = (input as { fact: { id: string } }).fact;
    return {
      customId: `discover_${fact.id}`,
      params: { model: 'mock', max_tokens: 100, messages: [{ role: 'user', content: 'mock' }] },
    };
  },
);
const mockExtractTextFromMessage = vi.fn<(...args: unknown[]) => string>((_msg: unknown) => 'mock-text');
const mockParseDiscoveryResponse = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../lib/sourcing/source-discover.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/sourcing/source-discover.ts')>(
    '../lib/sourcing/source-discover.ts',
  );
  return {
    ...actual,
    discoverSourceForFact: (...args: unknown[]) => mockDiscoverSourceForFact(...args),
    buildDiscoveryBatchRequest: (...args: unknown[]) => mockBuildDiscoveryBatchRequest(...args),
    extractTextFromMessage: (...args: unknown[]) => mockExtractTextFromMessage(...args),
    parseDiscoveryResponse: (...args: unknown[]) => mockParseDiscoveryResponse(...args),
    DEFAULT_CONFIDENCE_THRESHOLD: 0.6,
  };
});

// ── Batch API mocks ──────────────────────────────────────────────────

const mockSubmitBatch = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPollBatch = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetBatchResults = vi.fn<(...args: unknown[]) => Promise<Map<string, unknown>>>();

vi.mock('../lib/anthropic-batch.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/anthropic-batch.ts')>(
    '../lib/anthropic-batch.ts',
  );
  return {
    ...actual,
    submitBatch: (...args: unknown[]) => mockSubmitBatch(...args),
    pollBatch: (...args: unknown[]) => mockPollBatch(...args),
    getBatchResults: (...args: unknown[]) => mockGetBatchResults(...args),
  };
});

// ── LLM client mock ──────────────────────────────────────────────────

vi.mock('../lib/llm.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/llm.ts')>('../lib/llm.ts');
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({}) as unknown as object),
  };
});

// ── YAML I/O mocks ───────────────────────────────────────────────────

const fakeFiles = new Map<string, string>();
const readEntityDocumentMock = vi.fn((filepath: string) => {
  const content = fakeFiles.get(filepath) ?? 'facts: []\n';
  return parseDocument(content);
});
const writeEntityDocumentMock = vi.fn((filepath: string, doc: { toString: () => string }) => {
  fakeFiles.set(filepath, doc.toString());
});
const findEntityFilePathMock = vi.fn((slug: string) => `/fake/${slug}.yaml`);

vi.mock('../lib/factbase-writer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/factbase-writer.ts')>();
  return {
    ...actual,
    readEntityDocument: (p: string) => readEntityDocumentMock(p),
    writeEntityDocument: (p: string, d: { toString: () => string }) => writeEntityDocumentMock(p, d),
    findEntityFilePath: (slug: string) => findEntityFilePathMock(slug),
  };
});

// ── Verify-chain mock ────────────────────────────────────────────────

const mockSourcingCommand = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  async () => ({ exitCode: 0, output: 'mock verify output' }),
);

vi.mock('./factbase-sourcing.ts', () => ({
  sourcingCommand: (...args: unknown[]) => mockSourcingCommand(...args),
}));

// ── Wiki-server mock ─────────────────────────────────────────────────

interface FakeVerdictRow {
  recordId: string;
  fieldName: string | null;
}

let fakeVerdictRows: FakeVerdictRow[] = [];
let fakeListVerdictsResponse: { ok: boolean; error?: string; message?: string } = { ok: true };

const mockListVerdicts = vi.fn(
  async (opts?: { recordType?: string; verdict?: string; limit?: number; offset?: number }) => {
    if (!fakeListVerdictsResponse.ok) {
      return {
        ok: false,
        error: fakeListVerdictsResponse.error ?? 'unavailable',
        message: fakeListVerdictsResponse.message ?? 'mock failure',
      };
    }
    // Simulate filtering + paginating.
    const filtered = fakeVerdictRows.filter(() => true); // recordType+verdict filter is simulated by what callers seed.
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 200;
    const page = filtered.slice(offset, offset + limit);
    return {
      ok: true,
      data: {
        verdicts: page.map((r) => ({
          recordType: 'fact',
          recordId: r.recordId,
          fieldName: r.fieldName,
          entityId: null,
          displayName: null,
          entityDisplayName: null,
          verdict: 'unverifiable',
          confidence: 0.5,
          reasoning: null,
          sourcesChecked: 0,
          needsRecheck: false,
          nextCheckDue: null,
          lastComputedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        total: filtered.length,
      },
    };
  },
);

vi.mock('../lib/wiki-server/sourcing-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/wiki-server/sourcing-client.ts')>();
  return {
    ...actual,
    listVerdicts: (...args: unknown[]) => mockListVerdicts(...(args as [Parameters<typeof mockListVerdicts>[0]])),
  };
});

// ── Imports come AFTER the mocks ─────────────────────────────────────

import {
  commands,
  fetchUnverifiableFactIds,
  collectUnverifiableFacts,
  canonicalizeUrl,
  urlsEquivalent,
} from './factbase-resource-unverifiables.ts';
import { loadGraphFull } from '../lib/factbase-loader.ts';

const run = commands.default;

beforeEach(() => {
  mockDiscoverSourceForFact.mockReset();
  mockBuildDiscoveryBatchRequest.mockClear();
  mockExtractTextFromMessage.mockReset();
  mockParseDiscoveryResponse.mockReset();
  mockSubmitBatch.mockReset();
  mockPollBatch.mockReset();
  mockGetBatchResults.mockReset();
  mockSourcingCommand.mockClear();
  readEntityDocumentMock.mockClear();
  writeEntityDocumentMock.mockClear();
  findEntityFilePathMock.mockClear();
  mockListVerdicts.mockClear();
  fakeFiles.clear();
  fakeVerdictRows = [];
  fakeListVerdictsResponse = { ok: true };

  // Default: the engine returns a different (better) URL.
  mockDiscoverSourceForFact.mockImplementation(async (input: unknown) => {
    const fact = (input as { fact: { id: string } }).fact;
    return {
      candidates: [
        { url: `https://better.example.com/${fact.id}`, confidence: 0.85, summary: 'better' },
      ],
      best: `https://better.example.com/${fact.id}`,
      reason: 'high-confidence match',
      costUsd: 0.04,
    };
  });
});

/**
 * Helper: pick a fact from the real KB that has a source URL, then seed the
 * mock verdict store so the wrapper sees that fact as unverifiable.
 */
async function seedOneSourcedFact(): Promise<{
  entity: { id: string; name: string };
  fact: { id: string; propertyId: string; source: string };
  slug: string;
} | null> {
  const kb = await loadGraphFull();
  for (const entity of kb.graph.getAllEntities()) {
    for (const fact of kb.graph.getFacts(entity.id)) {
      if (fact.id.startsWith('inv_')) continue;
      if (!fact.source) continue;
      const slug = kb.filenameMap.get(entity.id);
      if (!slug) continue;
      fakeVerdictRows = [{ recordId: fact.id, fieldName: null }];
      return {
        entity: { id: entity.id, name: entity.name },
        fact: { id: fact.id, propertyId: fact.propertyId, source: fact.source },
        slug,
      };
    }
  }
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('fetchUnverifiableFactIds', () => {
  it('skips per-field verdicts (fieldName != null)', async () => {
    fakeVerdictRows = [
      { recordId: 'f_aaa', fieldName: null },
      { recordId: 'f_bbb', fieldName: 'value' }, // per-field, must be skipped
      { recordId: 'f_ccc', fieldName: null },
    ];
    const ids = await fetchUnverifiableFactIds();
    expect(ids.has('f_aaa')).toBe(true);
    expect(ids.has('f_bbb')).toBe(false);
    expect(ids.has('f_ccc')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('paginates through all rows', async () => {
    // Seed > one page worth (page size is 200).
    const rows: FakeVerdictRow[] = [];
    for (let i = 0; i < 250; i++) {
      rows.push({ recordId: `f_${i.toString().padStart(4, '0')}`, fieldName: null });
    }
    fakeVerdictRows = rows;
    const ids = await fetchUnverifiableFactIds();
    expect(ids.size).toBe(250);
    // Confirm pagination happened (called more than once).
    expect(mockListVerdicts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('throws on wiki-server failure', async () => {
    fakeListVerdictsResponse = { ok: false, error: 'unavailable', message: 'connection refused' };
    await expect(fetchUnverifiableFactIds()).rejects.toThrow(/connection refused/);
  });
});

describe('collectUnverifiableFacts', () => {
  it('only returns facts that (a) have a source AND (b) are in the unverifiable set', async () => {
    const kb = await loadGraphFull();

    // Pick the first fact with a source.
    let firstSourced: { factId: string; propertyId: string; entityId: string } | null = null;
    for (const entity of kb.graph.getAllEntities()) {
      for (const fact of kb.graph.getFacts(entity.id)) {
        if (fact.id.startsWith('inv_')) continue;
        if (!fact.source) continue;
        firstSourced = { factId: fact.id, propertyId: fact.propertyId, entityId: entity.id };
        break;
      }
      if (firstSourced) break;
    }
    expect(firstSourced).toBeTruthy();

    const ids = new Set([firstSourced!.factId]);
    const out = collectUnverifiableFacts(kb, ids, {});
    expect(out.length).toBe(1);
    expect(out[0].fact.id).toBe(firstSourced!.factId);

    // Seeding an empty set yields zero facts.
    expect(collectUnverifiableFacts(kb, new Set(), {}).length).toBe(0);

    // Seeding a fact ID that doesn't exist yields zero facts.
    expect(
      collectUnverifiableFacts(kb, new Set(['f_does_not_exist_in_kb_999']), {}).length,
    ).toBe(0);
  });

  it('respects --limit', async () => {
    const kb = await loadGraphFull();
    const ids = new Set<string>();
    for (const entity of kb.graph.getAllEntities()) {
      for (const fact of kb.graph.getFacts(entity.id)) {
        if (fact.id.startsWith('inv_')) continue;
        if (!fact.source) continue;
        ids.add(fact.id);
        if (ids.size >= 50) break;
      }
      if (ids.size >= 50) break;
    }
    const out = collectUnverifiableFacts(kb, ids, { limit: 5 });
    expect(out.length).toBe(5);
  });
});

describe('crux fb resource-unverifiables — dry-run (default)', () => {
  it('returns gracefully when no unverifiable facts match', async () => {
    fakeVerdictRows = []; // no unverifiable facts
    const res = await run([], { limit: '5' });
    expect(res.exitCode).toBe(0);
    expect(String(res.output)).toContain('No unverifiable facts');
    expect(mockDiscoverSourceForFact).not.toHaveBeenCalled();
  });

  it('discovers without writing to YAML or running verify chain', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    const res = await run([], { limit: '1' });
    expect(res.exitCode).toBe(0);
    expect(mockDiscoverSourceForFact).toHaveBeenCalled();
    expect(writeEntityDocumentMock).not.toHaveBeenCalled();
    expect(mockSourcingCommand).not.toHaveBeenCalled();
    expect(String(res.output)).toContain('=== Summary ===');
    expect(String(res.output)).toContain('Run with --apply');
  });

  it('passes existingSourceUrl to the engine', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    await run([], { limit: '1' });
    const call = mockDiscoverSourceForFact.mock.calls[0]?.[0] as
      | { existingSourceUrl?: string }
      | undefined;
    expect(call).toBeDefined();
    expect(call?.existingSourceUrl).toBe(target.fact.source);
  });
});

describe('crux fb resource-unverifiables — engine output classification', () => {
  it('counts best === existing as bestEqualsExisting (manual-review, no write)', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: target.fact.source, confidence: 0.9, summary: 'matches' }],
      best: target.fact.source, // engine confirms existing URL
      reason: 'existing URL is authoritative',
      costUsd: 0.04,
    });

    const res = await run([], { limit: '1', json: true });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.bestEqualsExisting).toBe(1);
    expect(parsed.summary.betterCandidatesFound).toBe(0);
    expect(parsed.manualReview.length).toBe(1);
    expect(parsed.manualReview[0].reason).toMatch(/existing URL/i);
  });

  it('counts best === null as noBest (manual-review, no write)', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://low.example.com', confidence: 0.4, summary: 'maybe' }],
      best: null,
      reason: 'no candidate met threshold',
      costUsd: 0.04,
    });

    const res = await run([], { limit: '1', json: true });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.noBest).toBe(1);
    expect(parsed.summary.betterCandidatesFound).toBe(0);
    expect(parsed.manualReview.length).toBe(1);
    expect(parsed.manualReview[0].reason).toMatch(/threshold/i);
  });

  it('counts engine errors as engineErrors (manual-review, no write)', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    mockDiscoverSourceForFact.mockRejectedValue(new Error('boom'));

    const res = await run([], { limit: '1', json: true });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.engineErrors).toBe(1);
    expect(parsed.manualReview.length).toBe(1);
    expect(parsed.manualReview[0].reason).toMatch(/engine error/i);
  });

  it('treats different URL with confidence ≥ threshold as actionable', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [
        { url: 'https://better.example.com/x', confidence: 0.9, summary: 'much better' },
      ],
      best: 'https://better.example.com/x',
      reason: 'better candidate found',
      costUsd: 0.04,
    });

    const res = await run([], { limit: '1', json: true });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.betterCandidatesFound).toBe(1);
    expect(parsed.results[0].actionable).toBe(true);
    // No write attempted in dry-run.
    expect(parsed.summary.writesAttempted).toBe(0);
  });
});

describe('crux fb resource-unverifiables — --apply path', () => {
  it('overwrites the YAML source with the new URL and chains verify', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n`,
    );

    const newUrl = 'https://new-and-better.example.com/x';
    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: newUrl, confidence: 0.95, summary: 's' }],
      best: newUrl,
      reason: 'much better',
      costUsd: 0.04,
    });

    // Use a tmp manual-review path to avoid touching the working tree.
    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const reviewPath = join(tmpDir, 'manual-review.txt');

    const res = await run([], {
      limit: '1',
      apply: true,
      'manual-review': reviewPath,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));

    expect(parsed.summary.writesSucceeded).toBe(1);
    expect(parsed.summary.writesAttempted).toBe(1);
    expect(parsed.writes[0].outcome).toBe('replaced');
    expect(parsed.writes[0].from).toBe(target.fact.source);
    expect(parsed.writes[0].to).toBe(newUrl);

    // Verify chain ran for the freshly-replaced fact.
    expect(mockSourcingCommand).toHaveBeenCalledWith([], { fact: target.fact.id });

    // YAML was actually written.
    expect(writeEntityDocumentMock).toHaveBeenCalled();
    const written = fakeFiles.get(`/fake/${target.slug}.yaml`);
    expect(written).toContain(newUrl);
    // Provenance annotation landed.
    expect(written).toContain('[auto-replaced by qua-934]');
    // Old URL is gone.
    expect(written).not.toContain(target.fact.source);
  });

  it('writes the manual-review file in apply mode (default path)', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n`,
    );

    // Engine confirms existing — manual-review entry expected.
    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: target.fact.source, confidence: 0.9, summary: 's' }],
      best: target.fact.source,
      reason: 'existing is fine',
      costUsd: 0.04,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const reviewPath = join(tmpDir, 'manual-review.txt');

    const res = await run([], { limit: '1', apply: true, 'manual-review': reviewPath });
    expect(res.exitCode).toBe(0);
    expect(existsSync(reviewPath)).toBe(true);
    const content = readFileSync(reviewPath, 'utf-8');
    expect(content).toContain('# QUA-934');
    expect(content).toContain(target.fact.id);
    expect(content).toContain(target.fact.source);
    expect(content).toMatch(/Mode: apply/);
  });

  it('does NOT run verify chain when --no-verify-chain is set', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n`,
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const res = await run([], {
      limit: '1',
      apply: true,
      'no-verify-chain': true,
      'manual-review': join(tmpDir, 'mr.txt'),
    });
    expect(res.exitCode).toBe(0);
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });

  it('does NOT run verify chain on confirm-existing facts (no physical write)', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n`,
    );

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: target.fact.source, confidence: 0.9, summary: 's' }],
      best: target.fact.source,
      reason: 'existing is fine',
      costUsd: 0.04,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const res = await run([], {
      limit: '1',
      apply: true,
      'manual-review': join(tmpDir, 'mr.txt'),
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.writesAttempted).toBe(0);
    expect(parsed.summary.bestEqualsExisting).toBe(1);
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });

  it('counts sourcingCommand "Fact not found" no-op as failed (QUA-963 regression)', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n`,
    );

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://new.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://new.example.com',
      reason: 'good',
      costUsd: 0.04,
    });

    mockSourcingCommand.mockResolvedValue({
      exitCode: 0,
      output: `Fact not found or has no source URL: ${target.fact.id}`,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const res = await run([], {
      limit: '1',
      apply: true,
      'manual-review': join(tmpDir, 'mr.txt'),
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.verifyAttempted).toBe(1);
    expect(parsed.summary.verifySucceeded).toBe(0);
    expect(parsed.summary.verifyFailed).toBe(1);
  });

  it('uses overwriteExisting=true (replaces a YAML source that already exists)', async () => {
    // Direct evidence that the writer actually overwrites — without the
    // overwriteExisting flag, updateFactMetaById would no-op on a fact that
    // already has a source.
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n    notes: existing-note\n`,
    );

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://replacement.example.com', confidence: 0.95, summary: 's' }],
      best: 'https://replacement.example.com',
      reason: 'better',
      costUsd: 0.04,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const res = await run([], {
      limit: '1',
      apply: true,
      'manual-review': join(tmpDir, 'mr.txt'),
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.writesSucceeded).toBe(1);

    const after = fakeFiles.get(`/fake/${target.slug}.yaml`)!;
    expect(after).toContain('https://replacement.example.com');
    expect(after).not.toContain(target.fact.source);
    // Provenance note overwrites the old note.
    expect(after).toContain('[auto-replaced by qua-934]');
  });

  it('records not-found when the YAML doc does not contain the fact ID', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    // Empty doc — fact ID won't be found inside.
    fakeFiles.set(`/fake/${target.slug}.yaml`, `facts: []\n`);

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const res = await run([], {
      limit: '1',
      apply: true,
      'manual-review': join(tmpDir, 'mr.txt'),
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.writesAttempted).toBe(1);
    expect(parsed.summary.writesSucceeded).toBe(0);
    expect(parsed.summary.writesNotFound).toBe(1);
    // Verify chain skipped (no successful write).
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });

  it('re-classifies replaced writes to write-error when writeEntityDocument throws', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n`,
    );

    writeEntityDocumentMock.mockImplementation(() => {
      throw new Error('disk full');
    });

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://x.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://x.example.com',
      reason: 'good',
      costUsd: 0.04,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const res = await run([], {
      limit: '1',
      apply: true,
      'manual-review': join(tmpDir, 'mr.txt'),
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.writesSucceeded).toBe(0);
    expect(parsed.summary.writeErrors).toBe(1);
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });
});

describe('crux fb resource-unverifiables — wiki-server failure', () => {
  it('returns exit 1 with an error message when listVerdicts fails', async () => {
    fakeListVerdictsResponse = { ok: false, error: 'unavailable', message: 'connection refused' };
    const res = await run([], { limit: '1' });
    expect(res.exitCode).toBe(1);
    expect(String(res.output)).toMatch(/failed to fetch unverifiable verdicts/i);
  });
});

describe('crux fb resource-unverifiables — --batch path', () => {
  it('builds requests, submits, polls, parses, then classifies', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    mockSubmitBatch.mockResolvedValue({
      id: 'batch_xyz',
      processing_status: 'in_progress',
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    });
    mockPollBatch.mockResolvedValue({
      id: 'batch_xyz',
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
    });
    mockExtractTextFromMessage.mockReturnValue('mock-text');
    mockParseDiscoveryResponse.mockReturnValue({
      candidates: [{ url: 'https://batch-better.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://batch-better.example.com',
      reason: 'batch picked',
    });

    mockGetBatchResults.mockImplementation(async () => {
      const results = new Map<string, unknown>();
      for (const callArgs of mockBuildDiscoveryBatchRequest.mock.calls) {
        const fact = (callArgs[0] as { fact: { id: string } }).fact;
        results.set(`discover_${fact.id}`, {
          custom_id: `discover_${fact.id}`,
          result: {
            type: 'succeeded',
            message: { content: [{ type: 'text', text: 'mock' }] },
          },
        });
      }
      return results;
    });

    const res = await run([], { limit: '1', batch: true, json: true });
    const parsed = JSON.parse(String(res.output));

    expect(mockSubmitBatch).toHaveBeenCalled();
    expect(mockPollBatch).toHaveBeenCalled();
    expect(mockGetBatchResults).toHaveBeenCalled();
    expect(parsed.summary.batch).toBe(true);
    expect(parsed.summary.scanned).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.betterCandidatesFound).toBeGreaterThanOrEqual(1);
  });

  it('counts errored batch responses as engineErrors', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    mockSubmitBatch.mockResolvedValue({ id: 'batch_e', processing_status: 'in_progress', request_counts: {} });
    mockPollBatch.mockResolvedValue({ id: 'batch_e', processing_status: 'ended', request_counts: {} });

    mockGetBatchResults.mockImplementation(async () => {
      const results = new Map<string, unknown>();
      for (const callArgs of mockBuildDiscoveryBatchRequest.mock.calls) {
        const fact = (callArgs[0] as { fact: { id: string } }).fact;
        results.set(`discover_${fact.id}`, {
          custom_id: `discover_${fact.id}`,
          result: {
            type: 'errored',
            error: { error: { type: 'invalid_request_error', message: 'bad fact' } },
          },
        });
      }
      return results;
    });

    const res = await run([], { limit: '1', batch: true, json: true });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.engineErrors).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.betterCandidatesFound).toBe(0);
  });

  it('passes existingSourceUrl to buildDiscoveryBatchRequest', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    mockSubmitBatch.mockResolvedValue({ id: 'b', processing_status: 'in_progress', request_counts: {} });
    mockPollBatch.mockResolvedValue({ id: 'b', processing_status: 'ended', request_counts: {} });
    mockGetBatchResults.mockResolvedValue(new Map());

    await run([], { limit: '1', batch: true, json: true });
    const buildCall = mockBuildDiscoveryBatchRequest.mock.calls[0]?.[0] as
      | { existingSourceUrl?: string }
      | undefined;
    expect(buildCall?.existingSourceUrl).toBe(target.fact.source);
  });
});

describe('crux fb resource-unverifiables — option parsing', () => {
  it('falls back to defaults on bad numeric input', async () => {
    fakeVerdictRows = [];
    const res = await run([], {
      limit: '1',
      budget: 'not-a-number',
      threshold: 'not-a-number',
      concurrency: 'oops',
    });
    expect(res.exitCode).toBe(0);
  });
});

describe('crux fb resource-unverifiables — budget gating (real-time)', () => {
  it('halts new work once estimated cost would exceed budget', async () => {
    const kb = await loadGraphFull();
    // Seed 5 fact IDs that have sources.
    const idsWithSource: string[] = [];
    for (const entity of kb.graph.getAllEntities()) {
      for (const fact of kb.graph.getFacts(entity.id)) {
        if (fact.id.startsWith('inv_')) continue;
        if (!fact.source) continue;
        idsWithSource.push(fact.id);
        if (idsWithSource.length >= 5) break;
      }
      if (idsWithSource.length >= 5) break;
    }
    if (idsWithSource.length < 2) return;
    fakeVerdictRows = idsWithSource.map((id) => ({ recordId: id, fieldName: null }));

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://different.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://different.example.com',
      reason: 'better',
      costUsd: 0.04,
    });

    const res = await run([], {
      limit: '5',
      budget: '0.05', // less than 2 calls' worth of $0.04 estimates
      concurrency: '1',
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.budgetExhausted).toBe(true);
    expect(mockDiscoverSourceForFact).toHaveBeenCalledTimes(1);
  });

  it('bounds overshoot under concurrency >= 2 (eager-debit gate)', async () => {
    // Regression: pre-fix, the budget gate was racy under concurrency —
    // multiple workers could read costUsd=0, all pass the gate, all spend.
    // Post-fix, the gate eagerly debits the estimate at gate-pass time so
    // only one in-flight call's worth of overshoot is possible.
    const kb = await loadGraphFull();
    const idsWithSource: string[] = [];
    for (const entity of kb.graph.getAllEntities()) {
      for (const fact of kb.graph.getFacts(entity.id)) {
        if (fact.id.startsWith('inv_')) continue;
        if (!fact.source) continue;
        idsWithSource.push(fact.id);
        if (idsWithSource.length >= 8) break;
      }
      if (idsWithSource.length >= 8) break;
    }
    if (idsWithSource.length < 4) return;
    fakeVerdictRows = idsWithSource.map((id) => ({ recordId: id, fieldName: null }));

    // Simulate slow engine calls so multiple workers stay in-flight at once.
    let inFlight = 0;
    let maxInFlight = 0;
    mockDiscoverSourceForFact.mockImplementation(async (input: unknown) => {
      const fact = (input as { fact: { id: string } }).fact;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      return {
        candidates: [{ url: `https://x.example.com/${fact.id}`, confidence: 0.9, summary: 's' }],
        best: `https://x.example.com/${fact.id}`,
        reason: 'good',
        costUsd: 0.04,
      };
    });

    // Budget allows 2 calls' worth; with concurrency=4, the racy gate would
    // let all 4 through. The eager-debit gate must cap calls at 2.
    const res = await run([], {
      limit: '8',
      budget: '0.085', // 2 × 0.04 = 0.08; leaves 0.005 of headroom
      concurrency: '4',
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.budgetExhausted).toBe(true);
    // Confirm we actually exercised concurrency >= 2 (i.e. the test shape
    // is meaningful — if maxInFlight stayed at 1, the gate could be
    // serially safe by accident).
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    // No more than budget/cost calls should have fired.
    expect(mockDiscoverSourceForFact.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('canonicalizeUrl + urlsEquivalent', () => {
  it('treats trailing-slash variants as equivalent', () => {
    expect(urlsEquivalent('https://example.com/path', 'https://example.com/path/')).toBe(true);
  });

  it('treats fragment-only differences as equivalent', () => {
    expect(urlsEquivalent('https://example.com/x', 'https://example.com/x#section')).toBe(true);
  });

  it('treats tracking-param-only differences as equivalent', () => {
    expect(
      urlsEquivalent(
        'https://example.com/x',
        'https://example.com/x?utm_source=foo&utm_medium=bar',
      ),
    ).toBe(true);
    expect(
      urlsEquivalent(
        'https://example.com/x?utm_source=foo&q=keep',
        'https://example.com/x?q=keep',
      ),
    ).toBe(true);
  });

  it('lower-cases the host', () => {
    expect(urlsEquivalent('https://Example.COM/x', 'https://example.com/x')).toBe(true);
  });

  it('strips default ports (80/443)', () => {
    expect(urlsEquivalent('https://example.com:443/x', 'https://example.com/x')).toBe(true);
    expect(urlsEquivalent('http://example.com:80/x', 'http://example.com/x')).toBe(true);
  });

  it('preserves functional query parameters', () => {
    // Different `q` values are real differences; not equivalent.
    expect(
      urlsEquivalent(
        'https://example.com/search?q=alpha',
        'https://example.com/search?q=beta',
      ),
    ).toBe(false);
  });

  it('does NOT collapse http vs https', () => {
    // http and https can be a real site change; conservative answer is that
    // they are different URLs.
    expect(urlsEquivalent('http://example.com/x', 'https://example.com/x')).toBe(false);
  });

  it('does NOT collapse www vs non-www', () => {
    expect(urlsEquivalent('https://www.example.com/x', 'https://example.com/x')).toBe(false);
  });

  it('handles malformed URLs gracefully', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
    expect(urlsEquivalent('not a url', 'not a url')).toBe(true);
  });

  it('classifies a trailing-slash-only LLM response as bestEqualsExisting (HIGH-1 fix)', async () => {
    // Regression for the URL canonicalization HIGH finding: pre-fix, an LLM
    // response of `https://x.com/path` would be classified as a
    // "betterCandidate" against an existing `https://x.com/path/` and the
    // YAML would be cosmetically overwritten. Post-fix, classifyDiscovery
    // and isActionable use urlsEquivalent so the engine's response is
    // recognized as the same URL.
    const target = await seedOneSourcedFact();
    if (!target) return;

    // Force the engine to return the existing URL with a trailing slash
    // toggled — the most common LLM canonicalization difference.
    const flipped = target.fact.source.endsWith('/')
      ? target.fact.source.slice(0, -1)
      : target.fact.source + '/';
    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: flipped, confidence: 0.9, summary: 'matches' }],
      best: flipped,
      reason: 'existing URL is fine (different formatting)',
      costUsd: 0.04,
    });

    const res = await run([], { limit: '1', json: true });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.bestEqualsExisting).toBe(1);
    expect(parsed.summary.betterCandidatesFound).toBe(0);
    expect(parsed.results[0].actionable).toBe(false);
  });
});

describe('crux fb resource-unverifiables — --dry-run honor (M4 fix)', () => {
  it('honors --dry-run even when --apply is also passed', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${target.slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1\n    source: ${target.fact.source}\n`,
    );

    const res = await run([], {
      limit: '1',
      apply: true,
      'dry-run': true, // explicit force-dry-run, should win
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    // No physical writes attempted because the explicit dry-run flag wins.
    expect(parsed.summary.apply).toBe(false);
    expect(parsed.summary.writesAttempted).toBe(0);
    expect(writeEntityDocumentMock).not.toHaveBeenCalled();
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });
});

describe('crux fb resource-unverifiables — --entity typo warning (M5 fix)', () => {
  it('errors clearly when --entity does not resolve', async () => {
    fakeVerdictRows = [{ recordId: 'f_anything', fieldName: null }];
    const res = await run([], {
      entity: 'this-entity-truly-does-not-exist-xyzzy',
      limit: '1',
    });
    expect(res.exitCode).toBe(1);
    expect(String(res.output)).toMatch(/did not resolve/i);
    // Engine should NOT have been called.
    expect(mockDiscoverSourceForFact).not.toHaveBeenCalled();
  });
});

describe('crux fb resource-unverifiables — manual-review failed-writes (M3 fix)', () => {
  it('includes write-failed actionable facts in the manual-review file', async () => {
    const target = await seedOneSourcedFact();
    if (!target) return;

    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    // Empty doc — fact ID won't be found; write fails as not-found.
    fakeFiles.set(`/fake/${target.slug}.yaml`, `facts: []\n`);

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://x.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://x.example.com',
      reason: 'better',
      costUsd: 0.04,
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'qua934-'));
    const reviewPath = join(tmpDir, 'mr.txt');

    const res = await run([], {
      limit: '1',
      apply: true,
      'manual-review': reviewPath,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    // The fact was actionable but write failed; manual-review must surface it.
    expect(parsed.summary.writesNotFound).toBe(1);
    expect(parsed.summary.writesSucceeded).toBe(0);
    expect(parsed.manualReview.length).toBe(1);
    expect(parsed.manualReview[0].factId).toBe(target.fact.id);
    expect(parsed.manualReview[0].reason).toMatch(/write failed/i);
    // The file was actually written and contains the fact.
    expect(existsSync(reviewPath)).toBe(true);
    const content = readFileSync(reviewPath, 'utf-8');
    expect(content).toContain(target.fact.id);
    expect(content).toMatch(/write failed/i);
  });
});

describe('crux fb resource-unverifiables — path traversal in --manual-review (HIGH-3 fix)', () => {
  it('refuses absolute paths outside the allowed roots', async () => {
    fakeVerdictRows = [];
    const res = await run([], {
      limit: '1',
      'manual-review': '/etc/qua-934-out-of-bounds.txt',
    });
    expect(res.exitCode).toBe(1);
    expect(String(res.output)).toMatch(/outside the allowed roots/i);
  });

  it('accepts paths inside the system tmp dir', async () => {
    fakeVerdictRows = [];
    const tmpFile = join(tmpdir(), 'qua-934-allowed.txt');
    const res = await run([], {
      limit: '1',
      'manual-review': tmpFile,
    });
    // No facts to process → exit 0 with the friendly message; the path
    // resolver did NOT throw.
    expect(res.exitCode).toBe(0);
  });
});
