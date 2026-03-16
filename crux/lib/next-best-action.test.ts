import { describe, it, expect } from 'vitest';
import { computeNBA, computeNBABatch, type PageInput } from './next-best-action.ts';

function makePage(overrides: Partial<PageInput> = {}): PageInput {
  return {
    id: 'test-page',
    numericId: 'E1',
    title: 'Test Page',
    entityType: 'concept',
    quality: 50,
    readerImportance: 80,
    researchImportance: 60,
    lastUpdated: new Date(Date.now() - 90 * 86400000).toISOString(), // 90 days ago
    hallucinationRisk: null,
    wordCount: 2000,
    contentFormat: 'article',
    subcategory: null,
    ...overrides,
  };
}

describe('computeNBA', () => {
  it('returns higher priority for high-importance, low-quality pages', () => {
    const highPriority = computeNBA(makePage({ quality: 20, readerImportance: 90 }));
    const lowPriority = computeNBA(makePage({ quality: 80, readerImportance: 30 }));
    expect(highPriority.priority).toBeGreaterThan(lowPriority.priority);
  });

  it('returns higher priority for stale pages', () => {
    const stale = computeNBA(makePage({
      lastUpdated: new Date(Date.now() - 400 * 86400000).toISOString(),
    }));
    const fresh = computeNBA(makePage({
      lastUpdated: new Date(Date.now() - 10 * 86400000).toISOString(),
    }));
    expect(stale.priority).toBeGreaterThan(fresh.priority);
  });

  it('boosts priority for high hallucination risk', () => {
    const risky = computeNBA(makePage({
      hallucinationRisk: { level: 'high', score: 80, factors: ['no-citations'] },
    }));
    const safe = computeNBA(makePage({
      hallucinationRisk: { level: 'low', score: 10, factors: [] },
    }));
    expect(risky.priority).toBeGreaterThan(safe.priority);
  });

  it('returns 0 priority for pages with 0 importance', () => {
    const noImportance = computeNBA(makePage({
      readerImportance: 0,
      researchImportance: 0,
    }));
    expect(noImportance.priority).toBe(0);
  });

  it('returns 0 priority for perfect quality (100)', () => {
    const perfect = computeNBA(makePage({ quality: 100 }));
    expect(perfect.priority).toBe(0);
  });

  it('uses researchImportance when it exceeds readerImportance', () => {
    const result = computeNBA(makePage({
      readerImportance: 30,
      researchImportance: 90,
    }));
    expect(result.importance).toBe(0.9);
  });

  it('caps staleness factor at 2.0', () => {
    const veryStale = computeNBA(makePage({
      lastUpdated: new Date(Date.now() - 1000 * 86400000).toISOString(),
    }));
    expect(veryStale.stalenessFactor).toBe(2);
  });

  it('includes reasons for high importance', () => {
    const result = computeNBA(makePage({ readerImportance: 80 }));
    expect(result.reasons).toContain('high importance');
  });

  it('includes reasons for low quality', () => {
    const result = computeNBA(makePage({ quality: 20 }));
    expect(result.reasons.some(r => r.includes('low quality'))).toBe(true);
  });

  it('includes reasons for high hallucination risk', () => {
    const result = computeNBA(makePage({
      hallucinationRisk: { level: 'high', score: 80, factors: [] },
    }));
    expect(result.reasons).toContain('high hallucination risk');
  });
});

describe('computeNBABatch', () => {
  it('sorts results by priority descending', () => {
    const pages = [
      makePage({ id: 'low', quality: 80, readerImportance: 30 }),
      makePage({ id: 'high', quality: 20, readerImportance: 90 }),
      makePage({ id: 'mid', quality: 50, readerImportance: 60 }),
    ];
    const results = computeNBABatch(pages);
    expect(results[0].id).toBe('high');
    expect(results[results.length - 1].id).toBe('low');
  });

  it('filters out dashboard pages', () => {
    const pages = [
      makePage({ id: 'article', contentFormat: 'article' }),
      makePage({ id: 'dashboard', contentFormat: 'dashboard' }),
    ];
    const results = computeNBABatch(pages);
    expect(results.map(r => r.id)).toEqual(['article']);
  });

  it('filters out pages with no importance by default', () => {
    const pages = [
      makePage({ id: 'important', readerImportance: 80, researchImportance: 0 }),
      makePage({ id: 'unimportant', readerImportance: 0, researchImportance: 0 }),
    ];
    const results = computeNBABatch(pages);
    expect(results.map(r => r.id)).toEqual(['important']);
  });

  it('includes no-importance pages when opted in', () => {
    const pages = [
      makePage({ id: 'important', readerImportance: 80 }),
      makePage({ id: 'unimportant', readerImportance: 0, researchImportance: 0 }),
    ];
    const results = computeNBABatch(pages, { includeNoImportance: true });
    expect(results.map(r => r.id)).toContain('unimportant');
  });

  it('filters by entity type', () => {
    const pages = [
      makePage({ id: 'person', entityType: 'person' }),
      makePage({ id: 'org', entityType: 'organization' }),
    ];
    const results = computeNBABatch(pages, { entityType: 'person' });
    expect(results.map(r => r.id)).toEqual(['person']);
  });
});
