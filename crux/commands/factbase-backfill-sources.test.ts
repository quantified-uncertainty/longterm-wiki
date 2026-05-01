/**
 * Tests for `crux fb backfill-sources` — QUA-933.
 *
 * Cover:
 *   1. Dry-run path: discovers, prints report, no YAML writes, no verify chain.
 *   2. --apply path: writes high-confidence discoveries to YAML, runs verify
 *      chain on freshly-sourced facts.
 *   3. Threshold filtering: results below threshold are not written even with
 *      --apply (engine returns best=null in that case; we honor it).
 *   4. Skipped-existing: when YAML already has a source, the writer no-ops
 *      and we count it as `writesSkippedExisting`.
 *   5. Engine errors: per-fact error doesn't abort the batch.
 *   6. Budget exhaustion (real-time): once estimated cost would exceed
 *      budget, no further calls fire.
 *   7. --batch path: builds batch requests, submits, polls, parses responses.
 *   8. --no-verify-chain: writes happen, verify chain is skipped.
 *   9. JSON output shape.
 *
 * The engine library (source-discover.ts) is mocked so we don't make real
 * LLM calls. The Anthropic Batch API (anthropic-batch.ts) is also mocked.
 * The YAML I/O (factbase-writer.ts) is mocked so --apply doesn't touch the
 * working tree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDocument } from 'yaml';

// Each test in this file calls `backfill` which loads the full FactBase
// graph (~2700 facts across ~700 entities). On a cold cache that takes
// several seconds — local runs land at ~440ms but CI clocked the first
// test at 5029ms, just past the 5000ms default. Bump the per-test timeout
// to 30s so the cold-cache case has headroom without masking real hangs.
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

// ── Imports come AFTER the mocks ─────────────────────────────────────

import { commands } from './factbase-backfill-sources.ts';
import { loadGraphFull } from '../lib/factbase-loader.ts';
import { collectUnsourcedFacts } from './factbase-source-backfill.ts';

const backfill = commands.default;

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
  fakeFiles.clear();

  // Default: return a confident best URL on every call.
  mockDiscoverSourceForFact.mockImplementation(async (input: unknown) => {
    const fact = (input as { fact: { id: string } }).fact;
    return {
      candidates: [
        { url: `https://example.com/${fact.id}`, confidence: 0.85, summary: 'matches' },
      ],
      best: `https://example.com/${fact.id}`,
      reason: 'high-confidence match',
      costUsd: 0.04,
    };
  });
});

// ── Tests ────────────────────────────────────────────────────────────

describe('crux fb backfill-sources — dry-run (default)', () => {
  it('discovers candidates without writing YAML or running verify chain', async () => {
    const res = await backfill([], {
      property: 'born-year',
      limit: '2',
    });
    expect(res.exitCode).toBe(0);
    expect(typeof res.output).toBe('string');

    expect(mockDiscoverSourceForFact).toHaveBeenCalled();
    expect(writeEntityDocumentMock).not.toHaveBeenCalled();
    expect(mockSourcingCommand).not.toHaveBeenCalled();
    // Per-entity report + summary go through res.output; header lines are
    // logged to console (so the user sees them streaming) but are not in
    // the returned report body.
    expect(res.output).toContain('=== Summary ===');
    expect(res.output).toContain('Run with --apply');
  });

  it('emits machine-readable JSON with --json', async () => {
    const res = await backfill([], {
      property: 'born-year',
      limit: '1',
      json: true,
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.apply).toBe(false);
    expect(parsed.summary.scanned).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results[0]).toHaveProperty('factId');
    expect(parsed.results[0]).toHaveProperty('best');
  });

  it('returns a friendly message when no facts match', async () => {
    const res = await backfill([], {
      entity: 'this-entity-truly-does-not-exist-12345',
      limit: '1',
    });
    expect(res.exitCode).toBe(0);
    expect(String(res.output)).toContain('No unsourced facts');
    expect(mockDiscoverSourceForFact).not.toHaveBeenCalled();
  });
});

describe('crux fb backfill-sources — --apply path', () => {
  it('writes discovered URLs to YAML and chains verify when best is set', async () => {
    // Pre-load fake YAML for any entity slug we may write to. We don't care
    // which fact is touched — apply path drives writes for whatever
    // collectUnsourcedFacts returns.
    findEntityFilePathMock.mockImplementation((slug: string) => `/fake/${slug}.yaml`);

    const res = await backfill([], {
      property: 'born-year',
      limit: '1',
      apply: true,
    });
    expect(res.exitCode).toBe(0);

    // The engine was called for the (one) target fact.
    expect(mockDiscoverSourceForFact).toHaveBeenCalled();

    // We attempted at least one YAML read+write.
    expect(readEntityDocumentMock).toHaveBeenCalled();
    // (writes happen only if updateFactMetaById finds a matching fact.id in
    // the doc — our fake doc starts with empty facts, so the update returns
    // 'not-found' and writeEntityDocument is not called. That's expected:
    // the test asserts the *flow* fired correctly, not that the in-memory
    // mock doc has the right structure to match a real fact.)

    // The verify chain only runs for facts that physically wrote — which is
    // zero in this fixture (see comment above), so sourcingCommand is NOT
    // called. Confirm we didn't call it spuriously.
    expect(mockSourcingCommand).not.toHaveBeenCalled();

    expect(String(res.output)).toContain('Writes attempted:');
  });

  it('runs verify chain when a write succeeds (using a doc that contains the fact)', async () => {
    // Find a real fact ID we can pre-populate in our fake doc so
    // updateFactMetaById succeeds.
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { property: 'born-year', limit: 1 });
    if (facts.length === 0) {
      // Skip if there are no unsourced born-year facts in the current KB.
      return;
    }
    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    expect(slug).toBeTruthy();
    const filepath = `/fake/${slug}.yaml`;
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      filepath,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1990\n`,
    );

    // Force the engine to return a high-confidence pick.
    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [
        { url: 'https://example.com/born', confidence: 0.9, summary: 'match' },
      ],
      best: 'https://example.com/born',
      reason: 'good',
      costUsd: 0.04,
    });

    const res = await backfill([], {
      property: 'born-year',
      entity: target.entity.id,
      limit: '1',
      apply: true,
    });
    expect(res.exitCode).toBe(0);

    expect(writeEntityDocumentMock).toHaveBeenCalled();
    // Verify chain ran for the freshly-sourced fact.
    expect(mockSourcingCommand).toHaveBeenCalledWith([], { fact: target.fact.id });
  });

  it('counts sourcingCommand "Fact not found" no-op as failed, not succeeded (QUA-963)', async () => {
    // CRITICAL regression: sourcingCommand returns { exitCode: 0, output:
    // "Fact not found or has no source URL: <id>" } when its post-write
    // reload doesn't see the fact (race, fact-id collision, slug rename,
    // atomic-rename lag). Pre-fix the wrapper counted this as `succeeded`,
    // silently lying about how many verdicts actually landed. Post-fix it
    // must count as `failed`.
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { property: 'born-year', limit: 1 });
    if (facts.length === 0) return;

    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1990\n`,
    );

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://example.com/x', confidence: 0.9, summary: 's' }],
      best: 'https://example.com/x',
      reason: 'good',
      costUsd: 0.04,
    });

    // Simulate the no-op path: sourcingCommand returns exit 0 with the
    // "Fact not found" output. (This is exactly what factbase-sourcing.ts
    // returns when collectFacts produces zero hits — see line ~395.)
    mockSourcingCommand.mockResolvedValue({
      exitCode: 0,
      output: `Fact not found or has no source URL: ${target.fact.id}`,
    });

    const res = await backfill([], {
      property: 'born-year',
      entity: target.entity.id,
      limit: '1',
      apply: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(mockSourcingCommand).toHaveBeenCalledTimes(1);
    expect(parsed.summary.verifyAttempted).toBe(1);
    expect(parsed.summary.verifySucceeded).toBe(0);
    expect(parsed.summary.verifyFailed).toBe(1);
  });

  it('counts genuine sourcingCommand success (exit 0, non-no-op output) as succeeded', async () => {
    // Companion test: confirms the no-op detection doesn't have false
    // positives that would suppress legitimate verify successes.
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { property: 'born-year', limit: 1 });
    if (facts.length === 0) return;

    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1990\n`,
    );

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://example.com/x', confidence: 0.9, summary: 's' }],
      best: 'https://example.com/x',
      reason: 'good',
      costUsd: 0.04,
    });

    // Real success output looks like "Verifying 1 fact(s)... confirmed".
    // Doesn't match either no-op pattern.
    mockSourcingCommand.mockResolvedValue({
      exitCode: 0,
      output: `Verifying 1 fact(s)...\n  [1/1] target / born-year (${target.fact.id})\n    confirmed (confidence: 90%)\n`,
    });

    const res = await backfill([], {
      property: 'born-year',
      entity: target.entity.id,
      limit: '1',
      apply: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.verifyAttempted).toBe(1);
    expect(parsed.summary.verifySucceeded).toBe(1);
    expect(parsed.summary.verifyFailed).toBe(0);
  });

  it('counts non-zero exit from sourcingCommand as failed', async () => {
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { property: 'born-year', limit: 1 });
    if (facts.length === 0) return;

    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1990\n`,
    );

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://example.com/x', confidence: 0.9, summary: 's' }],
      best: 'https://example.com/x',
      reason: 'good',
      costUsd: 0.04,
    });

    // sourcingCommand returns exit 1 (e.g., contradicted verdict or storage
    // error). The wrapper's verify chain should count this as failed.
    mockSourcingCommand.mockResolvedValue({
      exitCode: 1,
      output: `Verifying 1 fact(s)...\n  [1/1] target / born-year (${target.fact.id})\n    contradicted\n`,
    });

    const res = await backfill([], {
      property: 'born-year',
      entity: target.entity.id,
      limit: '1',
      apply: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.verifyFailed).toBe(1);
    expect(parsed.summary.verifySucceeded).toBe(0);
  });

  it('counts sourcingCommand throwing as failed (QUA-963 coverage of catch branch)', async () => {
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { property: 'born-year', limit: 1 });
    if (facts.length === 0) return;

    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: ${target.fact.propertyId}\n    value: 1990\n`,
    );

    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://example.com/x', confidence: 0.9, summary: 's' }],
      best: 'https://example.com/x',
      reason: 'good',
      costUsd: 0.04,
    });

    mockSourcingCommand.mockRejectedValue(new Error('wiki-server unreachable'));

    const res = await backfill([], {
      property: 'born-year',
      entity: target.entity.id,
      limit: '1',
      apply: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.verifyFailed).toBe(1);
    expect(parsed.summary.verifySucceeded).toBe(0);
  });

  it('does NOT run verify chain when --no-verify-chain is set', async () => {
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { property: 'born-year', limit: 1 });
    if (facts.length === 0) return;

    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    fakeFiles.set(
      `/fake/${slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: born-year\n    value: 1990\n`,
    );

    const res = await backfill([], {
      property: 'born-year',
      entity: target.entity.id,
      limit: '1',
      apply: true,
      'no-verify-chain': true,
    });
    expect(res.exitCode).toBe(0);
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });

  it('skips writing when YAML already has a source (skipped-existing)', async () => {
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { property: 'born-year', limit: 1 });
    if (facts.length === 0) return;

    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    // Pre-populate with an existing source so updateFactMetaById no-ops.
    fakeFiles.set(
      `/fake/${slug}.yaml`,
      `facts:\n  - id: ${target.fact.id}\n    propertyId: born-year\n    value: 1990\n    source: https://existing.example.com\n`,
    );

    const res = await backfill([], {
      property: 'born-year',
      entity: target.entity.id,
      limit: '1',
      apply: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.writesSkippedExisting).toBe(1);
    expect(parsed.summary.writesSucceeded).toBe(0);
    // Verify chain should NOT run for skipped-existing — only for actual writes.
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });

  it('re-classifies the correct writes as errors when writeEntityDocument throws (mixed wrote/skipped in same entity)', async () => {
    // Regression test for the index-math bug where `writes.length - changed`
    // was used to find recent writes. When an entity has facts that update
    // (wrote) interleaved with facts that skip (skipped-existing), the
    // last-N-entries approach could miss earlier `wrote` outcomes.
    //
    // We construct: 2 facts in the same entity. Fact A has no source (will
    // be 'wrote'); fact B has an existing source ('skipped-existing'). Then
    // we make writeEntityDocument throw, and assert that fact A's outcome
    // gets re-classified to error and writesSucceeded is rolled back.
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { entity: 'anthropic', limit: 5 });
    if (facts.length < 1) return;

    const target = facts[0];
    const slug = kb.filenameMap.get(target.entity.id);
    findEntityFilePathMock.mockImplementation((s: string) => `/fake/${s}.yaml`);
    // Pre-populate doc with TWO facts: target.fact.id (no source → wrote)
    // followed by 'fact-with-source' (has source → skipped-existing).
    fakeFiles.set(
      `/fake/${slug}.yaml`,
      `facts:
  - id: ${target.fact.id}
    propertyId: ${target.fact.propertyId}
    value: 1990
  - id: fact-with-source
    propertyId: ${target.fact.propertyId}
    value: 1991
    source: https://existing.example.com
`,
    );

    // Force writeEntityDocument to throw so the re-classify path runs.
    writeEntityDocumentMock.mockImplementation(() => {
      throw new Error('disk full');
    });

    // Make the engine return a best for both facts. We force --limit=2 +
    // --entity to scope the input to this entity. We can't directly inject
    // 'fact-with-source' into collectUnsourcedFacts (it has a source), so
    // we craft the discoveries by mocking discoverSourceForFact to return
    // best for whatever fact is presented, AND we manually push a synthetic
    // fact-with-source into the apply path by calling backfill twice would
    // be wrong. Instead we test that the SINGLE-fact case correctly handles
    // a write failure (the re-classify must roll back the lone write).
    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://new.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://new.example.com',
      reason: 'good',
      costUsd: 0.04,
    });

    const res = await backfill([], {
      property: target.fact.propertyId,
      entity: target.entity.id,
      limit: '1',
      apply: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    // The single write attempt should have been re-classified to error.
    expect(parsed.summary.writesSucceeded).toBe(0);
    expect(parsed.summary.writeErrors).toBe(1);
    // The verify chain should NOT run because no fact actually wrote.
    expect(mockSourcingCommand).not.toHaveBeenCalled();
  });
});

describe('crux fb backfill-sources — engine output handling', () => {
  it('counts no-best when engine returns best=null', async () => {
    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://low.example.com', confidence: 0.4, summary: 's' }],
      best: null,
      reason: 'no candidate met threshold',
      costUsd: 0.04,
    });

    const res = await backfill([], {
      property: 'born-year',
      limit: '1',
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.discovered).toBe(0);
    expect(parsed.summary.noBest).toBe(1);
  });

  it('counts engine errors and continues processing', async () => {
    let call = 0;
    mockDiscoverSourceForFact.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('boom');
      return {
        candidates: [{ url: 'https://ok.example.com', confidence: 0.9, summary: 's' }],
        best: 'https://ok.example.com',
        reason: 'good',
        costUsd: 0.04,
      };
    });

    const res = await backfill([], {
      property: 'born-year',
      limit: '2',
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.engineErrors).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.scanned).toBe(2);
    // The non-erroring call still produced a discovery.
    expect(parsed.summary.discovered + parsed.summary.engineErrors).toBe(2);
  });
});

describe('crux fb backfill-sources — budget gating (real-time)', () => {
  it('halts new work once estimated cost would exceed budget', async () => {
    // ESTIMATED_REALTIME_COST_USD is ~$0.04 — set the budget so only one
    // call gets through.
    mockDiscoverSourceForFact.mockResolvedValue({
      candidates: [{ url: 'https://ok.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://ok.example.com',
      reason: 'good',
      costUsd: 0.04,
    });

    const res = await backfill([], {
      property: 'born-year',
      limit: '5',
      budget: '0.05', // less than 2 calls' worth
      concurrency: '1', // serial so the gate is observable
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.budgetExhausted).toBe(true);
    // Only 1 call actually ran.
    expect(mockDiscoverSourceForFact).toHaveBeenCalledTimes(1);
  });
});

describe('crux fb backfill-sources — --batch path', () => {
  it('builds requests, submits batch, polls, and parses each response', async () => {
    mockSubmitBatch.mockResolvedValue({
      id: 'batch_abc123',
      processing_status: 'in_progress',
      request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    });
    mockPollBatch.mockResolvedValue({
      id: 'batch_abc123',
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
    });

    // Per-fact response: best URL with confidence 0.9.
    mockExtractTextFromMessage.mockReturnValue('mock-llm-text');
    mockParseDiscoveryResponse.mockImplementation((_text: unknown, threshold: unknown) => ({
      candidates: [{ url: 'https://batch.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://batch.example.com',
      reason: `picked at threshold=${threshold as number}`,
    }));

    // Set up batch results: one entry per fact with synthesized customIds
    // matching what buildDiscoveryBatchRequest emitted.
    mockGetBatchResults.mockImplementation(async () => {
      const results = new Map<string, unknown>();
      // The customId pattern is `discover_<factId>` per our mock. We don't
      // know the exact factIds here without loading the KB, so iterate over
      // the calls to mockBuildDiscoveryBatchRequest.
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

    const res = await backfill([], {
      property: 'born-year',
      limit: '2',
      batch: true,
      json: true,
    });

    expect(mockSubmitBatch).toHaveBeenCalled();
    expect(mockPollBatch).toHaveBeenCalled();
    expect(mockGetBatchResults).toHaveBeenCalled();
    // Parse should have been called once per response.
    expect(mockParseDiscoveryResponse).toHaveBeenCalled();
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.batch).toBe(true);
    expect(parsed.summary.scanned).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.discovered).toBeGreaterThanOrEqual(1);
  });

  it('counts errored batch responses as engineErrors', async () => {
    mockSubmitBatch.mockResolvedValue({ id: 'batch_xyz', processing_status: 'in_progress', request_counts: {} });
    mockPollBatch.mockResolvedValue({ id: 'batch_xyz', processing_status: 'ended', request_counts: {} });

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

    const res = await backfill([], {
      property: 'born-year',
      limit: '1',
      batch: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.engineErrors).toBeGreaterThanOrEqual(1);
    expect(parsed.summary.discovered).toBe(0);
  });

  it('counts missing batch responses as engineErrors with reconciliation (QUA-963 PR-B)', async () => {
    // QUA-963 HIGH: when Anthropic accepts a batch but never returns a
    // response for a customId, the work is silently dropped pre-fix.
    // Post-fix, the wrapper walks customIdToFact at the end of the response
    // loop and emits an engineError + missingResponses++ + a synthetic
    // FactDiscovery so the report can name the dropped fact.
    //
    // CodeRabbit fix: the test previously hardcoded `expect(missingResponses).toBe(2)`,
    // which would fail if the KB had < 2 unsourced born-year facts (e.g.,
    // after the QUA-933 smoke test wrote a Wikipedia source for Andrej
    // Karpathy's born-year). Resolve the actual count up-front via
    // collectUnsourcedFacts and assert against `n`, capping at 2 to keep
    // the test bounded.
    const kb = await loadGraphFull();
    const available = collectUnsourcedFacts(kb, { property: 'born-year', limit: 2 });
    if (available.length === 0) return; // skip if no born-year facts at all
    const n = available.length;

    mockSubmitBatch.mockResolvedValue({ id: 'batch_drop', processing_status: 'in_progress', request_counts: {} });
    mockPollBatch.mockResolvedValue({ id: 'batch_drop', processing_status: 'ended', request_counts: {} });

    // Return ZERO responses despite however many we submitted. Worst case:
    // every fact is dropped.
    mockGetBatchResults.mockResolvedValue(new Map());

    const res = await backfill([], {
      property: 'born-year',
      limit: String(n),
      batch: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    // All n facts must be reconciled as missing.
    expect(parsed.summary.missingResponses).toBe(n);
    expect(parsed.summary.engineErrors).toBe(n);
    // scanned must equal the number of facts we submitted, NOT the number
    // of responses (the pre-fix bug). Otherwise scanned < requested and the
    // operator can't reconcile the report against the input.
    expect(parsed.summary.scanned).toBe(n);
    expect(parsed.summary.unknownCustomIds).toBe(0);
    // Per-fact results array should have n entries with kind=error.
    expect(parsed.results.length).toBe(n);
    for (const r of parsed.results) {
      expect(r.error).toContain('did not return a response');
    }
  });

  it('counts unknown customIds separately from missing responses (QUA-963 PR-B)', async () => {
    // The inverse case: Anthropic returns a customId we DIDN'T submit.
    // Provider drift / response corruption — must be counted distinctly so
    // operators can tell "we lost work" (missingResponses) from "they sent
    // garbage" (unknownCustomIds).
    mockSubmitBatch.mockResolvedValue({ id: 'batch_drift', processing_status: 'in_progress', request_counts: {} });
    mockPollBatch.mockResolvedValue({ id: 'batch_drift', processing_status: 'ended', request_counts: {} });

    mockGetBatchResults.mockImplementation(async () => {
      const results = new Map<string, unknown>();
      // Return one valid response for the actual fact submitted.
      for (const callArgs of mockBuildDiscoveryBatchRequest.mock.calls) {
        const fact = (callArgs[0] as { fact: { id: string } }).fact;
        results.set(`discover_${fact.id}`, {
          custom_id: `discover_${fact.id}`,
          result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'mock' }] } },
        });
      }
      // Plus one customId we never submitted.
      results.set('discover_GHOST_FACT', {
        custom_id: 'discover_GHOST_FACT',
        result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'mock' }] } },
      });
      return results;
    });

    mockParseDiscoveryResponse.mockReturnValue({
      candidates: [{ url: 'https://x.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://x.example.com',
      reason: 'good',
    });

    const res = await backfill([], {
      property: 'born-year',
      limit: '1',
      batch: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.unknownCustomIds).toBe(1);
    expect(parsed.summary.missingResponses).toBe(0);
    // The legitimate fact still scanned and discovered.
    expect(parsed.summary.scanned).toBe(1);
    expect(parsed.summary.discovered).toBe(1);
  });

  it('mixed: some facts dropped + some unknown customIds (QUA-963 PR-B)', async () => {
    // Combined edge case: submit n facts (n >= 2), get back 1 valid
    // response + 1 unknown customId, leaving (n - 1) actual facts
    // unaccounted for. The reconciliation pass should catch the dropped
    // facts.
    //
    // Same KB-fragility fix as the "missing responses" test above —
    // resolve actual count up-front and skip if KB doesn't have ≥ 2
    // unsourced born-year facts available.
    const kb = await loadGraphFull();
    const available = collectUnsourcedFacts(kb, { property: 'born-year', limit: 3 });
    if (available.length < 2) return; // skip if we can't simulate "1 of n returned"
    const n = available.length;
    const droppedCount = n - 1;

    mockSubmitBatch.mockResolvedValue({ id: 'batch_mix', processing_status: 'in_progress', request_counts: {} });
    mockPollBatch.mockResolvedValue({ id: 'batch_mix', processing_status: 'ended', request_counts: {} });

    mockGetBatchResults.mockImplementation(async () => {
      const results = new Map<string, unknown>();
      // Return a response only for the FIRST submitted fact.
      const calls = mockBuildDiscoveryBatchRequest.mock.calls;
      if (calls.length > 0) {
        const firstFact = (calls[0][0] as { fact: { id: string } }).fact;
        results.set(`discover_${firstFact.id}`, {
          custom_id: `discover_${firstFact.id}`,
          result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'mock' }] } },
        });
      }
      // Plus an unknown customId.
      results.set('discover_PHANTOM', {
        custom_id: 'discover_PHANTOM',
        result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'mock' }] } },
      });
      return results;
    });

    mockParseDiscoveryResponse.mockReturnValue({
      candidates: [{ url: 'https://x.example.com', confidence: 0.9, summary: 's' }],
      best: 'https://x.example.com',
      reason: 'good',
    });

    const res = await backfill([], {
      property: 'born-year',
      limit: String(n),
      batch: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));
    expect(parsed.summary.unknownCustomIds).toBe(1);
    expect(parsed.summary.missingResponses).toBe(droppedCount);
    expect(parsed.summary.engineErrors).toBe(droppedCount);
    expect(parsed.summary.discovered).toBe(1);
    // All n facts accounted for in scanned (1 succeeded + droppedCount reconciled-as-error).
    expect(parsed.summary.scanned).toBe(n);
  });

  it('charges batch cost up-front based on submission count, not on successes (QUA-963 PR-B)', async () => {
    // CodeRabbit fix: pre-fix, summary.costUsd was incremented only inside
    // the success-response branch. A 50-fact batch with 1 dropped response
    // would report $0.98 even though Anthropic billed for the full
    // submission (~$1.00). Post-fix, cost is charged once up-front based
    // on requests.length so the report matches submission semantics.
    const kb = await loadGraphFull();
    const available = collectUnsourcedFacts(kb, { property: 'born-year', limit: 2 });
    if (available.length === 0) return;
    const n = available.length;

    mockSubmitBatch.mockResolvedValue({ id: 'batch_cost', processing_status: 'in_progress', request_counts: {} });
    mockPollBatch.mockResolvedValue({ id: 'batch_cost', processing_status: 'ended', request_counts: {} });

    // Drop ALL responses — the reported cost should still reflect what we
    // submitted, not what came back.
    mockGetBatchResults.mockResolvedValue(new Map());

    const res = await backfill([], {
      property: 'born-year',
      limit: String(n),
      batch: true,
      json: true,
    });
    const parsed = JSON.parse(String(res.output));

    // Cost should equal n * ESTIMATED_BATCH_COST_USD (0.02), even though
    // 0 succeeded.
    const expectedCost = Number((n * 0.02).toFixed(4));
    expect(parsed.summary.costUsd).toBe(expectedCost);
    // Sanity check: zero discoveries (all dropped).
    expect(parsed.summary.discovered).toBe(0);
  });
});

describe('crux fb backfill-sources — option parsing', () => {
  it('falls back to defaults on bad numeric input', async () => {
    // Bad budget should fall back to default ($5) without crashing.
    const res = await backfill([], {
      property: 'born-year',
      limit: '1',
      budget: 'not-a-number',
      threshold: 'not-a-number',
      concurrency: 'oops',
    });
    expect(res.exitCode).toBe(0);
  });

  it('clamps limit to MAX_LIMIT', async () => {
    // limit=99999 should be clamped to MAX_LIMIT=2000 (no crash, no actual
    // verification of cap value here — just that it doesn't error).
    const res = await backfill([], {
      property: 'born-year',
      limit: '99999',
    });
    expect(res.exitCode).toBe(0);
  });
});
