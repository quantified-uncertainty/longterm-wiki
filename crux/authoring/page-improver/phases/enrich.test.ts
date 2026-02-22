/**
 * Tests for enrich.ts — error handling (#695)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enrichPhase } from './enrich.ts';
import type { PageData, PipelineOptions } from '../types.ts';

// Mock enrichment modules
vi.mock('../../../enrich/enrich-entity-links.ts', () => ({
  enrichEntityLinks: vi.fn(async (content: string) => ({
    content,
    insertedCount: 0,
  })),
}));

vi.mock('../../../enrich/enrich-fact-refs.ts', () => ({
  enrichFactRefs: vi.fn(async (content: string) => ({
    content,
    insertedCount: 0,
  })),
}));

// Mock utils to suppress logging
vi.mock('../utils.ts', () => ({
  ROOT: '/tmp/test',
  log: vi.fn(),
  writeTemp: vi.fn(),
}));

const makePage = (): PageData => ({
  id: 'test-page',
  title: 'Test Page',
  path: 'test-page.mdx',
  content: '## Test\n\nSome content.',
  frontmatter: {},
});

const makeOptions = (): PipelineOptions => ({
  tier: 'standard',
  deep: false,
});

describe('enrichPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enriched content on success', async () => {
    const { enrichEntityLinks } = await import('../../../enrich/enrich-entity-links.ts');
    (enrichEntityLinks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: '## Test\n\n<EntityLink id="miri">MIRI</EntityLink> content.',
      insertedCount: 1,
    });

    const { content, result } = await enrichPhase(makePage(), '## Test\n\nMIRI content.', makeOptions());
    expect(content).toContain('EntityLink');
    expect(result.entityLinks.insertedCount).toBe(1);
  });

  it('continues with original content when entity-link enrichment throws (#695)', async () => {
    const { enrichEntityLinks } = await import('../../../enrich/enrich-entity-links.ts');
    (enrichEntityLinks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('LLM timeout'));

    const input = '## Test\n\nOriginal content.';
    const { content, result } = await enrichPhase(makePage(), input, makeOptions());

    // Should return the original content, not throw
    expect(content).toBe(input);
    expect(result.entityLinks.insertedCount).toBe(0);
  });

  it('continues with current content when fact-ref enrichment throws (#695)', async () => {
    const { enrichFactRefs } = await import('../../../enrich/enrich-fact-refs.ts');
    (enrichFactRefs as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Schema error'));

    const input = '## Test\n\nContent with facts.';
    const { content, result } = await enrichPhase(makePage(), input, makeOptions());

    expect(content).toBe(input);
    expect(result.factRefs.insertedCount).toBe(0);
  });

  it('entity-link failure does not prevent fact-ref enrichment', async () => {
    const { enrichEntityLinks } = await import('../../../enrich/enrich-entity-links.ts');
    const { enrichFactRefs } = await import('../../../enrich/enrich-fact-refs.ts');
    (enrichEntityLinks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('LLM timeout'));
    (enrichFactRefs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: '## Test\n\nContent with <F entity="x" fact="y" />.',
      insertedCount: 1,
    });

    const { content, result } = await enrichPhase(makePage(), '## Test\n\nContent.', makeOptions());

    // Fact-ref should still have run successfully
    expect(content).toContain('<F entity=');
    expect(result.entityLinks.insertedCount).toBe(0); // failed
    expect(result.factRefs.insertedCount).toBe(1); // succeeded
  });
});
