/**
 * Tests for sourcing-filter.ts
 *
 * Focus: the filterBySourcingVerdicts function correctly skips pages
 * with contradicted verdicts and passes all others through.
 *
 * Uses the deps injection parameter for clean testing without module mocks.
 */

import { describe, it, expect, vi } from 'vitest';
import { filterBySourcingVerdicts, type SourcingFilterDeps } from './sourcing-filter.ts';
import type { PageUpdate } from './types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeUpdate(overrides: Partial<PageUpdate> & { pageId: string }): PageUpdate {
  return {
    pageTitle: overrides.pageTitle ?? overrides.pageId,
    reason: 'test reason',
    suggestedTier: 'standard',
    relevantNews: [],
    directions: 'Update the page.',
    ...overrides,
  };
}

/** Standard entity mappings for tests: 3 orgs with slug→stableId. */
function standardMappings() {
  return {
    slugToStableId: new Map([
      ['anthropic', 'mK9pX3rQ7n'],
      ['openai', 'xY2zW4vB8m'],
      ['deepmind', 'aB3cD5eF7g'],
    ]),
    stableIdToSlug: new Map([
      ['mK9pX3rQ7n', 'anthropic'],
      ['xY2zW4vB8m', 'openai'],
      ['aB3cD5eF7g', 'deepmind'],
    ]),
  };
}

function makeDeps(overrides: Partial<SourcingFilterDeps> = {}): SourcingFilterDeps {
  return {
    getContradictedEntityIds: overrides.getContradictedEntityIds ?? (async () => new Set<string>()),
    loadEntityMappings: overrides.loadEntityMappings ?? (() => standardMappings()),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('filterBySourcingVerdicts', () => {
  it('returns empty result for empty input', async () => {
    const getIds = vi.fn();
    const result = await filterBySourcingVerdicts([], false, makeDeps({ getContradictedEntityIds: getIds }));
    expect(result.passed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    // Should not call API for empty input
    expect(getIds).not.toHaveBeenCalled();
  });

  it('passes all pages when no contradicted verdicts exist', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(),
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),
      makeUpdate({ pageId: 'openai' }),
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);
    expect(result.passed).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips pages whose entities have contradicted verdicts', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n']), // anthropic
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic', pageTitle: 'Anthropic' }),
      makeUpdate({ pageId: 'openai', pageTitle: 'OpenAI' }),
      makeUpdate({ pageId: 'deepmind', pageTitle: 'DeepMind' }),
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);

    expect(result.passed).toHaveLength(2);
    expect(result.passed.map(u => u.pageId)).toEqual(['openai', 'deepmind']);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].pageUpdate.pageId).toBe('anthropic');
  });

  it('skips multiple pages with contradicted verdicts', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n', 'aB3cD5eF7g']),
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),
      makeUpdate({ pageId: 'openai' }),
      makeUpdate({ pageId: 'deepmind' }),
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0].pageId).toBe('openai');
    expect(result.skipped).toHaveLength(2);
  });

  it('passes pages without entity mappings (no stableId for their slug)', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n']), // anthropic
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),   // has mapping, is contradicted → skipped
      makeUpdate({ pageId: 'unknown-page' }), // no mapping → passes through
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0].pageId).toBe('unknown-page');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].pageUpdate.pageId).toBe('anthropic');
  });

  it('passes all pages when getContradictedEntityIds throws (best-effort)', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => { throw new Error('network error'); },
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),
      makeUpdate({ pageId: 'openai' }),
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);
    expect(result.passed).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('passes all pages when entity mappings are empty (best-effort)', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n']),
      loadEntityMappings: () => ({
        slugToStableId: new Map(),
        stableIdToSlug: new Map(),
      }),
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);
    // With empty mappings, the filter can't resolve slugs → stableIds,
    // so it returns all pages (passes through).
    expect(result.passed).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('passes all pages when loadEntityMappings throws (best-effort)', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n']),
      loadEntityMappings: () => { throw new Error('file system error'); },
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);
    expect(result.passed).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('does not mutate the input array', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n']),
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),
      makeUpdate({ pageId: 'openai' }),
    ];
    const originalLength = updates.length;

    await filterBySourcingVerdicts(updates, false, deps);
    expect(updates).toHaveLength(originalLength);
  });

  it('preserves order of passed pages', async () => {
    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['xY2zW4vB8m']), // openai
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic' }),
      makeUpdate({ pageId: 'openai' }),
      makeUpdate({ pageId: 'deepmind' }),
    ];

    const result = await filterBySourcingVerdicts(updates, false, deps);
    expect(result.passed.map(u => u.pageId)).toEqual(['anthropic', 'deepmind']);
  });

  it('logs skip message for each skipped page', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n', 'xY2zW4vB8m']),
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic', pageTitle: 'Anthropic' }),
      makeUpdate({ pageId: 'openai', pageTitle: 'OpenAI' }),
    ];

    await filterBySourcingVerdicts(updates, false, deps);

    const logCalls = consoleSpy.mock.calls.map(c => c[0]);
    expect(logCalls).toContainEqual(
      expect.stringContaining('Skipping page "Anthropic" (anthropic)')
    );
    expect(logCalls).toContainEqual(
      expect.stringContaining('Skipping page "OpenAI" (openai)')
    );

    consoleSpy.mockRestore();
  });

  it('logs verbose details when verbose=true and pages are skipped', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(['mK9pX3rQ7n']),
    });

    const updates = [
      makeUpdate({ pageId: 'anthropic', pageTitle: 'Anthropic' }),
      makeUpdate({ pageId: 'openai', pageTitle: 'OpenAI' }),
    ];

    await filterBySourcingVerdicts(updates, true, deps);

    const logCalls = consoleSpy.mock.calls.map(c => c[0]);
    expect(logCalls).toContainEqual(
      expect.stringContaining('1 entities with contradicted verdicts')
    );
    expect(logCalls).toContainEqual(
      expect.stringContaining('1 page(s) skipped, 1 page(s) passed')
    );

    consoleSpy.mockRestore();
  });

  it('logs verbose "all pages pass" when verbose=true and no contradictions', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const deps = makeDeps({
      getContradictedEntityIds: async () => new Set(),
    });

    const updates = [makeUpdate({ pageId: 'anthropic' })];

    await filterBySourcingVerdicts(updates, true, deps);

    const logCalls = consoleSpy.mock.calls.map(c => c[0]);
    expect(logCalls).toContainEqual(
      expect.stringContaining('no contradicted verdicts found, all pages pass')
    );

    consoleSpy.mockRestore();
  });
});
