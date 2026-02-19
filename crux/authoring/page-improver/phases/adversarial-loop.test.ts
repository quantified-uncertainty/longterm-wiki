/**
 * Tests for adversarial-loop phase pure functions.
 *
 * Tests mergeResearch (deduplication) and buildGapDirections (formatting),
 * which are the pure logic units in this module.
 *
 * The full loop (adversarialLoopPhase) requires LLM calls and is tested
 * via manual integration testing with `--tier=deep` on real pages.
 */

import { describe, it, expect } from 'vitest';
import type { ResearchResult, AdversarialReviewResult } from '../types.ts';

// ── Inline the pure functions under test ────────────────────────────────────
// These are module-private so we re-implement them here to test the logic.
// If they're ever exported, replace with direct imports.

function mergeResearch(base: ResearchResult, additional: ResearchResult): ResearchResult {
  const seenUrls = new Set<string>((base.sources || []).map(s => s.url));
  const newSources = (additional.sources || []).filter(s => {
    if (seenUrls.has(s.url)) return false;
    seenUrls.add(s.url);
    return true;
  });
  return {
    sources: [...(base.sources || []), ...newSources],
    summary: [base.summary, additional.summary].filter(Boolean).join(' '),
  };
}

function buildGapDirections(adversarialReview: AdversarialReviewResult): string {
  const editGaps = adversarialReview.gaps.filter(g => g.actionType === 'edit');
  const reSearchGaps = adversarialReview.gaps.filter(g => g.actionType === 're-research');

  const parts: string[] = [
    '## Adversarial Review Findings — Address These Gaps\n',
    `Overall: ${adversarialReview.overallAssessment}\n`,
  ];

  if (reSearchGaps.length > 0) {
    parts.push('### Gaps to Fill with New Research');
    reSearchGaps.forEach(g => parts.push(`- [${g.type}] ${g.description}`));
    parts.push('');
  }

  if (editGaps.length > 0) {
    parts.push('### Gaps to Fix by Editing');
    editGaps.forEach(g => parts.push(`- [${g.type}] ${g.description}`));
    parts.push('');
  }

  parts.push('Prioritize fixing these specific gaps. Do not rewrite sections that are already good.');

  return parts.join('\n');
}

// ── Helper factories ─────────────────────────────────────────────────────────

const makeSource = (url: string, topic = 'test') => ({
  topic,
  title: `Source at ${url}`,
  url,
  facts: ['fact 1'],
  relevance: 'high',
});

const emptyReview = (): AdversarialReviewResult => ({
  gaps: [],
  needsReResearch: false,
  reResearchQueries: [],
  overallAssessment: 'No gaps.',
});

// ── mergeResearch tests ──────────────────────────────────────────────────────

describe('mergeResearch', () => {
  it('concatenates non-overlapping sources', () => {
    const base: ResearchResult = { sources: [makeSource('https://a.com')] };
    const additional: ResearchResult = { sources: [makeSource('https://b.com')] };
    const merged = mergeResearch(base, additional);
    expect(merged.sources).toHaveLength(2);
    expect(merged.sources.map(s => s.url)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('deduplicates sources with the same URL', () => {
    const base: ResearchResult = { sources: [makeSource('https://a.com')] };
    const additional: ResearchResult = { sources: [makeSource('https://a.com'), makeSource('https://b.com')] };
    const merged = mergeResearch(base, additional);
    expect(merged.sources).toHaveLength(2);
    expect(merged.sources.map(s => s.url)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('deduplicates when additional has multiple copies of the same URL', () => {
    const base: ResearchResult = { sources: [] };
    const additional: ResearchResult = {
      sources: [makeSource('https://dup.com'), makeSource('https://dup.com'), makeSource('https://other.com')],
    };
    const merged = mergeResearch(base, additional);
    expect(merged.sources).toHaveLength(2);
    expect(merged.sources.map(s => s.url)).toEqual(['https://dup.com', 'https://other.com']);
  });

  it('handles empty base', () => {
    const base: ResearchResult = { sources: [] };
    const additional: ResearchResult = { sources: [makeSource('https://a.com')] };
    const merged = mergeResearch(base, additional);
    expect(merged.sources).toHaveLength(1);
  });

  it('handles empty additional', () => {
    const base: ResearchResult = { sources: [makeSource('https://a.com')] };
    const additional: ResearchResult = { sources: [] };
    const merged = mergeResearch(base, additional);
    expect(merged.sources).toHaveLength(1);
  });

  it('handles both empty', () => {
    const merged = mergeResearch({ sources: [] }, { sources: [] });
    expect(merged.sources).toHaveLength(0);
  });

  it('concatenates summaries', () => {
    const base: ResearchResult = { sources: [], summary: 'Found X.' };
    const additional: ResearchResult = { sources: [], summary: 'Found Y.' };
    const merged = mergeResearch(base, additional);
    expect(merged.summary).toBe('Found X. Found Y.');
  });

  it('handles missing summary gracefully', () => {
    const base: ResearchResult = { sources: [], summary: 'Found X.' };
    const additional: ResearchResult = { sources: [] };
    const merged = mergeResearch(base, additional);
    expect(merged.summary).toBe('Found X.');
  });
});

// ── buildGapDirections tests ─────────────────────────────────────────────────

describe('buildGapDirections', () => {
  it('includes overall assessment', () => {
    const review: AdversarialReviewResult = {
      ...emptyReview(),
      overallAssessment: 'Two problems found.',
    };
    const directions = buildGapDirections(review);
    expect(directions).toContain('Two problems found.');
  });

  it('includes re-research gap under correct header', () => {
    const review: AdversarialReviewResult = {
      gaps: [{ type: 'fact-density', description: 'Missing founding year', actionType: 're-research', reResearchQuery: 'founding year X' }],
      needsReResearch: true,
      reResearchQueries: ['founding year X'],
      overallAssessment: 'Needs data.',
    };
    const directions = buildGapDirections(review);
    expect(directions).toContain('Gaps to Fill with New Research');
    expect(directions).toContain('[fact-density] Missing founding year');
    expect(directions).not.toContain('Gaps to Fix by Editing');
  });

  it('includes edit gap under correct header', () => {
    const review: AdversarialReviewResult = {
      gaps: [{ type: 'redundancy', description: 'Sections 2 and 3 overlap', actionType: 'edit' }],
      needsReResearch: false,
      reResearchQueries: [],
      overallAssessment: 'Minor edit needed.',
    };
    const directions = buildGapDirections(review);
    expect(directions).toContain('Gaps to Fix by Editing');
    expect(directions).toContain('[redundancy] Sections 2 and 3 overlap');
    expect(directions).not.toContain('Gaps to Fill with New Research');
  });

  it('includes both re-research and edit sections when both present', () => {
    const review: AdversarialReviewResult = {
      gaps: [
        { type: 'speculation', description: 'Claim X unsourced', actionType: 're-research', reResearchQuery: 'q' },
        { type: 'redundancy', description: 'Duplicate intro', actionType: 'edit' },
      ],
      needsReResearch: true,
      reResearchQueries: ['q'],
      overallAssessment: 'Multiple issues.',
    };
    const directions = buildGapDirections(review);
    expect(directions).toContain('Gaps to Fill with New Research');
    expect(directions).toContain('Gaps to Fix by Editing');
  });

  it('omits advisory (none) gaps from directions', () => {
    const review: AdversarialReviewResult = {
      gaps: [{ type: 'source-gap', description: 'Could include more context', actionType: 'none' }],
      needsReResearch: false,
      reResearchQueries: [],
      overallAssessment: 'Minor advisory.',
    };
    const directions = buildGapDirections(review);
    // advisory gap should not appear in either section
    expect(directions).not.toContain('Could include more context');
    expect(directions).not.toContain('Gaps to Fill with New Research');
    expect(directions).not.toContain('Gaps to Fix by Editing');
    // but the overall assessment and footer should still appear
    expect(directions).toContain('Minor advisory.');
    expect(directions).toContain('Prioritize fixing these specific gaps');
  });

  it('always includes the footer reminder', () => {
    const directions = buildGapDirections(emptyReview());
    expect(directions).toContain('Prioritize fixing these specific gaps. Do not rewrite sections that are already good.');
  });
});
