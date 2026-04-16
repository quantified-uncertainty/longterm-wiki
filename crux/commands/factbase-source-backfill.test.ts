/**
 * Tests for `crux fb source-backfill` — QUA-545.
 *
 * These tests exercise:
 *   1. collectUnsourcedFacts — which facts get included/excluded under various
 *      filter combinations (verifiable:false, editorial, --entity, --property).
 *   2. The command wiring through `commands['source-backfill']`, with the
 *      suggestUrls() library mocked so no external HTTP calls happen.
 *   3. The apply path via updateFactMetaById in-memory (no real YAML writes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDocument } from 'yaml';

// Mock suggestUrls before the command module loads so the module-level import
// in factbase-source-backfill.ts resolves to the mock. We also mock the YAML
// read/write helpers so --apply doesn't touch real files.
const mockSuggestUrls = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  candidates: [
    { url: 'https://example.com/src', title: 'Example', snippet: null, sourceProvider: 'exa' },
  ],
  providersUsed: ['exa'],
  providersSkipped: [],
  query: 'test query',
  costUsd: 0.0,
}));

vi.mock('../lib/sourcing/suggest-urls.ts', () => ({
  suggestUrls: (...args: unknown[]) => mockSuggestUrls(...args),
  GENERATOR_MODEL: 'qua-64/suggest-urls-v1',
}));

// Mock YAML file I/O so --apply tests don't mutate the working tree. We keep
// a fake file store keyed by filepath so the read→modify→write round-trip is
// observable.
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

import { commands, collectUnsourcedFacts, buildClaimText } from './factbase-source-backfill.ts';
import { loadGraphFull } from '../lib/factbase-loader.ts';

const backfill = commands.default;

beforeEach(() => {
  mockSuggestUrls.mockClear();
  readEntityDocumentMock.mockClear();
  writeEntityDocumentMock.mockClear();
  findEntityFilePathMock.mockClear();
  fakeFiles.clear();
});

describe('collectUnsourcedFacts', () => {
  it('picks up facts with no source on verifiable properties', async () => {
    const kb = await loadGraphFull();
    const out = collectUnsourcedFacts(kb, { limit: 500 });
    expect(out.length).toBeGreaterThan(0);

    // Every returned fact must lack a source and not be an inverse fact.
    for (const { fact } of out) {
      expect(fact.source).toBeFalsy();
      expect(fact.id.startsWith('inv_')).toBe(false);
    }

    // By default we skip verifiable:false properties, so none should appear.
    for (const { fact } of out) {
      const prop = kb.graph.getProperty(fact.propertyId);
      expect(prop?.verifiable).not.toBe(false);
    }
  });

  it('respects --include-non-verifiable', async () => {
    const kb = await loadGraphFull();
    const strict = collectUnsourcedFacts(kb, { limit: 2000 });
    const loose = collectUnsourcedFacts(kb, { limit: 2000, includeNonVerifiable: true });
    // Loose must include every strict fact plus at least one non-verifiable one.
    expect(loose.length).toBeGreaterThan(strict.length);

    const hasNonVerifiable = loose.some(({ fact }) => {
      const prop = kb.graph.getProperty(fact.propertyId);
      return prop?.verifiable === false;
    });
    expect(hasNonVerifiable).toBe(true);
  });

  it('skips editorial properties (description, notable-for) by default', async () => {
    const kb = await loadGraphFull();
    const out = collectUnsourcedFacts(kb, { limit: 2000 });
    expect(out.some(({ fact }) => fact.propertyId === 'description')).toBe(false);
    expect(out.some(({ fact }) => fact.propertyId === 'notable-for')).toBe(false);
  });

  it('--include-editorial surfaces description facts', async () => {
    const kb = await loadGraphFull();
    const withEd = collectUnsourcedFacts(kb, { limit: 2000, includeEditorial: true });
    expect(withEd.some(({ fact }) => fact.propertyId === 'description')).toBe(true);
  });

  it('--include-property=description picks only description editorial', async () => {
    const kb = await loadGraphFull();
    const out = collectUnsourcedFacts(kb, {
      limit: 2000,
      includeProperty: 'description',
    });
    expect(out.some(({ fact }) => fact.propertyId === 'description')).toBe(true);
    // notable-for is still skipped because it wasn't in the allow list
    expect(out.some(({ fact }) => fact.propertyId === 'notable-for')).toBe(false);
  });

  it('respects --property filter exactly', async () => {
    const kb = await loadGraphFull();
    const out = collectUnsourcedFacts(kb, { property: 'headcount', limit: 50 });
    for (const { fact } of out) {
      expect(fact.propertyId).toBe('headcount');
    }
  });

  it('respects --entity filter', async () => {
    const kb = await loadGraphFull();
    const out = collectUnsourcedFacts(kb, { entity: 'anthropic', limit: 50 });
    for (const { entity } of out) {
      expect(entity.name.toLowerCase()).toContain('anthropic');
    }
  });

  it('returns empty array for unknown entity (not an error)', async () => {
    const kb = await loadGraphFull();
    const out = collectUnsourcedFacts(kb, { entity: 'this-entity-does-not-exist', limit: 10 });
    expect(out).toEqual([]);
  });

  it('enforces the limit cap', async () => {
    const kb = await loadGraphFull();
    const out = collectUnsourcedFacts(kb, { limit: 5 });
    expect(out.length).toBeLessThanOrEqual(5);
  });
});

describe('buildClaimText', () => {
  it('formats entity/property/value/asOf consistently', () => {
    const entity = { id: 'e1', stableId: 'e1', name: 'Anthropic', type: 'organization' };
    const fact = {
      id: 'f_123',
      subjectId: 'e1',
      propertyId: 'headcount',
      value: { type: 'number' as const, value: 500 },
      asOf: '2024-06',
    };
    expect(buildClaimText(entity, fact, 'Headcount', '500')).toBe(
      "Anthropic's Headcount = 500 (as of 2024-06)",
    );
  });

  it('omits asOf when absent', () => {
    const entity = { id: 'e1', stableId: 'e1', name: 'Anthropic', type: 'organization' };
    const fact = {
      id: 'f_123',
      subjectId: 'e1',
      propertyId: 'headcount',
      value: { type: 'number' as const, value: 500 },
    };
    expect(buildClaimText(entity, fact, 'Headcount', '500')).toBe(
      "Anthropic's Headcount = 500",
    );
  });
});

describe('crux fb source-backfill — dry-run (default)', () => {
  it('reports candidates but does not call the YAML writer', async () => {
    const result = await backfill([], {
      entity: 'anthropic',
      limit: '2',
    });
    expect(result.exitCode).toBe(0);
    // Summary is always in the output; the header prints to stdout via log().
    expect(result.output).toContain('=== Summary ===');
    expect(result.output).toContain('Run with --apply');
    expect(mockSuggestUrls).toHaveBeenCalled();
    expect(writeEntityDocumentMock).not.toHaveBeenCalled();
  });

  it('emits JSON in --ci mode with candidates from the mocked suggester', async () => {
    const result = await backfill([], {
      entity: 'anthropic',
      limit: '2',
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data).toHaveProperty('summary');
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
    if (data.results.length > 0) {
      expect(data.results[0]).toHaveProperty('factId');
      expect(data.results[0]).toHaveProperty('candidates');
      // The mock always returns one candidate at example.com/src
      expect(data.results[0].candidates[0].url).toBe('https://example.com/src');
    }
  });

  it('reports "no unsourced facts" when filters match nothing', async () => {
    const result = await backfill([], {
      entity: 'nonexistent-entity-xyz',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No unsourced facts');
  });

  it('warns on invalid --limit and falls back to default', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await backfill([], { entity: 'anthropic', limit: '-1' });
    const combined = errSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(combined).toContain('ignoring --limit');
    errSpy.mockRestore();
  });
});

describe('crux fb source-backfill — --apply', () => {
  it('writes the top candidate to YAML via updateFactMetaById', async () => {
    // Seed the fake file with a pre-existing headcount fact that has NO source.
    fakeFiles.set(
      '/fake/anthropic.yaml',
      `facts:\n  - id: f_FAKEEXAMPLE1\n    property: headcount\n    value:\n      type: number\n      value: 500\n    asOf: '2024-06'\n`,
    );

    // Override collectUnsourcedFacts indirectly by pointing a single entity at
    // a real fact that exists in the KB graph. We use the real KB + real fact
    // IDs; the file write goes into `fakeFiles`.
    const kb = await loadGraphFull();
    const anthropic = kb.graph.getAllEntities().find((e) => e.name === 'Anthropic');
    expect(anthropic).toBeDefined();

    // Pick one real unsourced fact for Anthropic.
    const facts = collectUnsourcedFacts(kb, { entity: 'anthropic', limit: 1 });
    if (facts.length === 0) {
      // If Anthropic has no unsourced facts (shouldn't happen per enumeration
      // but future-proof), skip gracefully.
      return;
    }
    const { fact } = facts[0];
    fakeFiles.set(
      '/fake/anthropic.yaml',
      `facts:\n  - id: ${fact.id}\n    property: ${fact.propertyId}\n    value: something\n`,
    );

    const result = await backfill([], {
      entity: 'anthropic',
      limit: '1',
      apply: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Writes attempted');
    expect(writeEntityDocumentMock).toHaveBeenCalled();

    const written = fakeFiles.get('/fake/anthropic.yaml') ?? '';
    expect(written).toContain('https://example.com/src');
    expect(written).toContain('auto-suggested');
  });

  it('does NOT overwrite an existing source', async () => {
    const kb = await loadGraphFull();
    const facts = collectUnsourcedFacts(kb, { entity: 'anthropic', limit: 1 });
    if (facts.length === 0) return;
    const { fact } = facts[0];

    // Seed the file with the same fact but WITH a pre-existing source URL.
    // updateFactMetaById must no-op and count this as writes_skipped_existing.
    fakeFiles.set(
      '/fake/anthropic.yaml',
      `facts:\n  - id: ${fact.id}\n    property: ${fact.propertyId}\n    value: something\n    source: https://pre-existing.example/\n`,
    );

    const result = await backfill([], {
      entity: 'anthropic',
      limit: '1',
      apply: true,
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.summary.writes_skipped_existing).toBeGreaterThanOrEqual(1);

    const written = fakeFiles.get('/fake/anthropic.yaml') ?? '';
    // Must still have the original URL, not the mocked suggestion.
    expect(written).toContain('https://pre-existing.example/');
    expect(written).not.toContain('https://example.com/src');
  });
});
