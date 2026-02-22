/**
 * Tests for section-writer.ts
 *
 * Covers:
 *  - formatSourcesForPrompt: source formatting for LLM prompt
 *  - buildSectionWriterPrompt: prompt construction with various constraints
 *  - parseGroundedResult: JSON parsing + claim-map validation
 *  - rewriteSection: integration test with mocked LLM call
 *
 * All LLM calls are mocked — tests run fully offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatSourcesForPrompt,
  buildSectionWriterPrompt,
  parseGroundedResult,
  rewriteSection,
  MAX_SOURCE_CONTENT_CHARS,
  type SourceCacheEntry,
  type GroundedWriteRequest,
  type PageContext,
} from './section-writer.ts';

// ---------------------------------------------------------------------------
// Mock the LLM layer so no network calls are made
// ---------------------------------------------------------------------------

vi.mock('./llm.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm.ts')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({})),
    streamLlmCall: vi.fn(async () =>
      JSON.stringify({
        content: '## Background\n\nThe organization was founded in 2000.[^SRC-1]\n\n[^SRC-1]: MIRI History (https://example.com)',
        claimMap: [
          {
            claim: 'The organization was founded in 2000.',
            factId: 'SRC-1',
            sourceUrl: 'https://example.com',
            quote: 'Founded in 2000 as SIAI',
          },
        ],
        unsourceableClaims: [],
      })
    ),
  };
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makePage = (overrides: Partial<PageContext> = {}): PageContext => ({
  title: 'Machine Intelligence Research Institute',
  type: 'organization',
  entityId: 'miri',
  ...overrides,
});

const makeSrc = (overrides: Partial<SourceCacheEntry> = {}): SourceCacheEntry => ({
  id: 'SRC-1',
  url: 'https://example.com/miri-history',
  title: 'MIRI History',
  content: 'Founded in 2000 as SIAI (Singularity Institute for Artificial Intelligence).',
  facts: ['Founded 2000 as SIAI', 'Renamed MIRI in 2013'],
  ...overrides,
});

const makeRequest = (overrides: Partial<GroundedWriteRequest> = {}): GroundedWriteRequest => ({
  sectionId: 'background',
  sectionContent: '## Background\n\nMIRI is an AI safety organization.',
  pageContext: makePage(),
  sourceCache: [makeSrc()],
  ...overrides,
});

// ---------------------------------------------------------------------------
// formatSourcesForPrompt
// ---------------------------------------------------------------------------

describe('formatSourcesForPrompt', () => {
  it('returns placeholder when no sources provided', () => {
    const result = formatSourcesForPrompt([]);
    expect(result).toContain('No sources provided');
  });

  it('includes source ID header and URL', () => {
    const result = formatSourcesForPrompt([makeSrc()]);
    expect(result).toContain('[SRC-1]');
    expect(result).toContain('https://example.com/miri-history');
  });

  it('shows facts array when provided (not raw content)', () => {
    const src = makeSrc({ facts: ['Fact A', 'Fact B'], content: 'raw text should not appear' });
    const result = formatSourcesForPrompt([src]);
    expect(result).toContain('- Fact A');
    expect(result).toContain('- Fact B');
    // Should prefer facts over raw content
    expect(result).not.toContain('raw text should not appear');
  });

  it('falls back to content excerpt when no facts', () => {
    const src = makeSrc({ facts: undefined, content: 'Some useful content about MIRI.' });
    const result = formatSourcesForPrompt([src]);
    expect(result).toContain('Some useful content about MIRI.');
  });

  it('truncates very long content', () => {
    const longContent = 'A'.repeat(MAX_SOURCE_CONTENT_CHARS + 5_000);
    const src = makeSrc({ facts: undefined, content: longContent });
    const result = formatSourcesForPrompt([src]);
    // Result should be shorter than the full content
    expect(result.length).toBeLessThan(longContent.length);
    expect(result).toContain('...(truncated)');
    // Should include up to MAX_SOURCE_CONTENT_CHARS chars of content
    expect(result).toContain('A'.repeat(50)); // first chars are present
  });

  it('includes author and date when provided', () => {
    const src = makeSrc({ author: 'Jane Doe', date: '2023-01-15' });
    const result = formatSourcesForPrompt([src]);
    expect(result).toContain('Author: Jane Doe');
    expect(result).toContain('Date: 2023-01-15');
  });

  it('formats multiple sources with separators', () => {
    const src1 = makeSrc({ id: 'SRC-1', title: 'First Source' });
    const src2 = makeSrc({ id: 'SRC-2', url: 'https://other.com', title: 'Second Source' });
    const result = formatSourcesForPrompt([src1, src2]);
    expect(result).toContain('[SRC-1]');
    expect(result).toContain('[SRC-2]');
    expect(result).toContain('---');
  });
});

// ---------------------------------------------------------------------------
// buildSectionWriterPrompt
// ---------------------------------------------------------------------------

describe('buildSectionWriterPrompt', () => {
  it('includes page title and section ID', () => {
    const prompt = buildSectionWriterPrompt(makeRequest());
    expect(prompt).toContain('Machine Intelligence Research Institute');
    expect(prompt).toContain('background');
  });

  it('includes the current section content', () => {
    const prompt = buildSectionWriterPrompt(makeRequest());
    expect(prompt).toContain('MIRI is an AI safety organization.');
  });

  it('includes directions when provided', () => {
    const prompt = buildSectionWriterPrompt(makeRequest({
      directions: 'Add founding year and key milestones.',
    }));
    expect(prompt).toContain('Add founding year and key milestones.');
  });

  it('uses strict mode wording when allowTrainingKnowledge is false', () => {
    const prompt = buildSectionWriterPrompt(makeRequest({
      constraints: { allowTrainingKnowledge: false, requireClaimMap: true },
    }));
    expect(prompt).toContain('STRICT MODE');
    expect(prompt).toContain('ONLY add claims');
  });

  it('uses permissive wording when allowTrainingKnowledge is true', () => {
    const prompt = buildSectionWriterPrompt(makeRequest({
      constraints: { allowTrainingKnowledge: true, requireClaimMap: false },
    }));
    expect(prompt).toContain('training knowledge');
    expect(prompt).not.toContain('STRICT MODE');
  });

  it('includes REQUIRED when requireClaimMap is true', () => {
    const prompt = buildSectionWriterPrompt(makeRequest({
      constraints: { allowTrainingKnowledge: true, requireClaimMap: true },
    }));
    expect(prompt).toContain('REQUIRED');
  });

  it('includes maxNewClaims limit when set', () => {
    const prompt = buildSectionWriterPrompt(makeRequest({
      constraints: {
        allowTrainingKnowledge: true,
        requireClaimMap: false,
        maxNewClaims: 3,
      },
    }));
    expect(prompt).toContain('at most 3 new factual claims');
  });

  it('lists valid source IDs in constraint section', () => {
    const src1 = makeSrc({ id: 'SRC-1' });
    const src2 = makeSrc({ id: 'SRC-2', url: 'https://b.com', title: 'B' });
    const prompt = buildSectionWriterPrompt(makeRequest({ sourceCache: [src1, src2] }));
    expect(prompt).toContain('SRC-1');
    expect(prompt).toContain('SRC-2');
  });

  it('mentions no sources when cache is empty', () => {
    const prompt = buildSectionWriterPrompt(makeRequest({ sourceCache: [] }));
    expect(prompt).toContain('No sources provided');
    expect(prompt).toContain('No sources');
  });
});

// ---------------------------------------------------------------------------
// parseGroundedResult
// ---------------------------------------------------------------------------

describe('parseGroundedResult', () => {
  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      content: '## Background\n\nFounded 2000.[^SRC-1]\n\n[^SRC-1]: Title (https://ex.com)',
      claimMap: [{ claim: 'Founded 2000.', factId: 'SRC-1', sourceUrl: 'https://ex.com' }],
      unsourceableClaims: [],
    });

    const result = parseGroundedResult(raw, makeRequest());
    expect(result.content).toContain('Founded 2000.');
    expect(result.claimMap).toHaveLength(1);
    expect(result.claimMap[0].factId).toBe('SRC-1');
    expect(result.unsourceableClaims).toHaveLength(0);
    expect(result.sectionId).toBe('background');
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({
      content: '## Bg\n\nText.',
      claimMap: [],
      unsourceableClaims: [],
    }) + '\n```';

    const result = parseGroundedResult(raw, makeRequest());
    expect(result.content).toContain('Text.');
  });

  it('moves claims with unknown factIds to unsourceableClaims in strict mode', () => {
    const raw = JSON.stringify({
      content: '## Bg\n\nText.[^UNKNOWN]',
      claimMap: [{ claim: 'Text.', factId: 'UNKNOWN', sourceUrl: 'https://nowhere.com' }],
      unsourceableClaims: [],
    });

    const result = parseGroundedResult(raw, makeRequest({
      constraints: { allowTrainingKnowledge: false, requireClaimMap: true },
    }));

    // Unknown factId → moved to unsourceable
    expect(result.claimMap).toHaveLength(0);
    expect(result.unsourceableClaims).toContain('Text.');
  });

  it('keeps claims with unknown factIds in claimMap when training knowledge is allowed', () => {
    const raw = JSON.stringify({
      content: '## Bg\n\nText.[^UNKNOWN]',
      claimMap: [{ claim: 'Text.', factId: 'UNKNOWN', sourceUrl: 'https://nowhere.com' }],
      unsourceableClaims: [],
    });

    const result = parseGroundedResult(raw, makeRequest({
      constraints: { allowTrainingKnowledge: true, requireClaimMap: false },
    }));

    // When training knowledge is allowed, claims with unknown factIds are kept
    // in claimMap as-is (the writer may be citing training knowledge intentionally)
    expect(result.claimMap).toHaveLength(1);
    expect(result.claimMap[0].factId).toBe('UNKNOWN');
    expect(result.unsourceableClaims).toHaveLength(0);
  });

  it('preserves valid claimMap entries alongside invalid ones in strict mode', () => {
    const raw = JSON.stringify({
      content: '## Bg\n\nValid.[^SRC-1] Invalid.[^GHOST]',
      claimMap: [
        { claim: 'Valid.', factId: 'SRC-1', sourceUrl: 'https://example.com/miri-history' },
        { claim: 'Invalid.', factId: 'GHOST', sourceUrl: 'https://ghost.com' },
      ],
      unsourceableClaims: ['Wanted to say X but no source'],
    });

    const result = parseGroundedResult(raw, makeRequest({
      constraints: { allowTrainingKnowledge: false, requireClaimMap: true },
    }));

    expect(result.claimMap).toHaveLength(1);
    expect(result.claimMap[0].factId).toBe('SRC-1');
    expect(result.unsourceableClaims).toContain('Wanted to say X but no source');
    expect(result.unsourceableClaims).toContain('Invalid.'); // promoted from claimMap
  });

  it('handles empty source cache (accepts any factId)', () => {
    const raw = JSON.stringify({
      content: '## Bg\n\nText.[^ANY]',
      claimMap: [{ claim: 'Text.', factId: 'ANY', sourceUrl: 'https://any.com' }],
      unsourceableClaims: [],
    });

    const result = parseGroundedResult(raw, makeRequest({ sourceCache: [] }));
    // With empty cache, no validation can be done — accept all factIds
    expect(result.claimMap).toHaveLength(1);
  });

  it('returns a fallback result when JSON is completely unparseable', () => {
    const raw = 'Sorry, I cannot help with that.';
    const result = parseGroundedResult(raw, makeRequest());
    // Falls back to raw text as content
    expect(result.content).toBeTruthy();
    expect(result.claimMap).toHaveLength(0);
    expect(result.unsourceableClaims).toHaveLength(0);
  });

  it('handles missing claimMap field gracefully', () => {
    const raw = JSON.stringify({ content: '## Bg\n\nText.', unsourceableClaims: [] });
    const result = parseGroundedResult(raw, makeRequest());
    expect(result.claimMap).toEqual([]);
    expect(result.content).toContain('Text.');
  });

  it('handles missing unsourceableClaims field gracefully', () => {
    const raw = JSON.stringify({ content: '## Bg\n\nText.', claimMap: [] });
    const result = parseGroundedResult(raw, makeRequest());
    expect(result.unsourceableClaims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rewriteSection (integration — mocked LLM)
// ---------------------------------------------------------------------------

describe('rewriteSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a GroundedWriteResult with content, claimMap, and sectionId', async () => {
    const result = await rewriteSection(makeRequest());
    expect(result.content).toContain('## Background');
    expect(result.claimMap).toHaveLength(1);
    expect(result.claimMap[0].factId).toBe('SRC-1');
    expect(result.sectionId).toBe('background');
    expect(result.unsourceableClaims).toHaveLength(0);
  });

  it('passes directions through to the prompt', async () => {
    const { streamLlmCall } = await import('./llm.ts');
    await rewriteSection(makeRequest({ directions: 'Focus on funding history.' }));
    const promptArg = vi.mocked(streamLlmCall).mock.calls[0][1] as string;
    expect(promptArg).toContain('Focus on funding history.');
  });

  it('includes strict-mode language when allowTrainingKnowledge is false', async () => {
    const { streamLlmCall } = await import('./llm.ts');
    await rewriteSection(makeRequest({
      constraints: { allowTrainingKnowledge: false, requireClaimMap: true },
    }));
    const promptArg = vi.mocked(streamLlmCall).mock.calls[0][1] as string;
    expect(promptArg).toContain('STRICT MODE');
  });

  it('handles empty source cache gracefully', async () => {
    const result = await rewriteSection(makeRequest({ sourceCache: [] }));
    // Should still return a result (from the mock)
    expect(result.content).toBeTruthy();
    expect(result.sectionId).toBe('background');
  });

  it('propagates model option to streamLlmCall', async () => {
    const { streamLlmCall } = await import('./llm.ts');
    await rewriteSection(makeRequest(), { model: 'claude-haiku-4-5' });
    const opts = vi.mocked(streamLlmCall).mock.calls[0][2];
    expect(opts?.model).toBe('claude-haiku-4-5');
  });

  it('multiple sources — formats all of them in the prompt', async () => {
    const { streamLlmCall } = await import('./llm.ts');
    const src1 = makeSrc({ id: 'SRC-1', title: 'Source One' });
    const src2 = makeSrc({ id: 'SRC-2', url: 'https://b.com', title: 'Source Two' });
    await rewriteSection(makeRequest({ sourceCache: [src1, src2] }));
    const promptArg = vi.mocked(streamLlmCall).mock.calls[0][1] as string;
    expect(promptArg).toContain('[SRC-1]');
    expect(promptArg).toContain('[SRC-2]');
  });
});
