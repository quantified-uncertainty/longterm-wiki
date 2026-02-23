import { describe, it, expect } from 'vitest';
import { SaveArtifactsSchema } from './api-types.js';

describe('SaveArtifactsSchema', () => {
  it('accepts minimal valid input', () => {
    const result = SaveArtifactsSchema.safeParse({
      pageId: 'test-page',
      engine: 'v2',
      tier: 'standard',
      startedAt: '2026-02-23T10:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts full valid input with all fields', () => {
    const result = SaveArtifactsSchema.safeParse({
      pageId: 'anthropic',
      engine: 'v1',
      tier: 'deep',
      directions: 'Add recent funding data',
      startedAt: '2026-02-23T10:00:00.000Z',
      completedAt: '2026-02-23T10:05:00.000Z',
      durationS: 300.5,
      totalCost: 12.50,
      sourceCache: [
        { id: 'SRC-1', url: 'https://example.com', title: 'Test Source' },
        { id: 'SRC-2', url: 'https://example.com/2', title: 'Another Source', author: 'Author', date: '2024-01-01', facts: ['Fact 1'] },
      ],
      researchSummary: 'Found 3 relevant sources about recent developments.',
      citationAudit: { total: 10, verified: 8, failed: 1, unchecked: 1 },
      costEntries: [
        { toolName: 'web_search', estimatedCost: 0.05, timestamp: 1708678800000 },
      ],
      costBreakdown: { web_search: 0.10, rewrite_section: 2.40 },
      sectionDiffs: [
        { sectionId: 'overview', before: '## Overview\nOld content', after: '## Overview\nNew improved content' },
      ],
      qualityMetrics: { wordCount: 2500, footnoteCount: 15 },
      qualityGatePassed: true,
      qualityGaps: [],
      toolCallCount: 12,
      refinementCycles: 1,
      phasesRun: ['analyze', 'research', 'improve', 'review'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid engine', () => {
    const result = SaveArtifactsSchema.safeParse({
      pageId: 'test-page',
      engine: 'v3',
      tier: 'standard',
      startedAt: '2026-02-23T10:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid tier', () => {
    const result = SaveArtifactsSchema.safeParse({
      pageId: 'test-page',
      engine: 'v2',
      tier: 'premium',
      startedAt: '2026-02-23T10:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = SaveArtifactsSchema.safeParse({
      pageId: 'test-page',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null for optional jsonb fields', () => {
    const result = SaveArtifactsSchema.safeParse({
      pageId: 'test-page',
      engine: 'v2',
      tier: 'polish',
      startedAt: '2026-02-23T10:00:00.000Z',
      sourceCache: null,
      citationAudit: null,
      costEntries: null,
      costBreakdown: null,
      sectionDiffs: null,
      qualityMetrics: null,
      qualityGatePassed: null,
      qualityGaps: null,
    });
    expect(result.success).toBe(true);
  });
});
