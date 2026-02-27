/**
 * Tests for page-rankings.mjs extracted module
 */

import { describe, it, expect } from 'vitest';
import { computePageRankings, computeRecommendedScores, buildUpdateSchedule } from '../page-rankings.mjs';

describe('computePageRankings', () => {
  it('assigns readerRank in descending importance order', () => {
    const pages = [
      { id: 'a', readerImportance: 30 },
      { id: 'b', readerImportance: 90 },
      { id: 'c', readerImportance: 60 },
    ];
    const { readerRanked } = computePageRankings(pages);
    expect(readerRanked).toBe(3);
    expect(pages.find(p => p.id === 'b').readerRank).toBe(1);
    expect(pages.find(p => p.id === 'c').readerRank).toBe(2);
    expect(pages.find(p => p.id === 'a').readerRank).toBe(3);
  });

  it('assigns researchRank separately from readerRank', () => {
    const pages = [
      { id: 'x', readerImportance: 10, researchImportance: 80 },
      { id: 'y', readerImportance: 80, researchImportance: 10 },
    ];
    computePageRankings(pages);
    expect(pages.find(p => p.id === 'x').researchRank).toBe(1);
    expect(pages.find(p => p.id === 'y').researchRank).toBe(2);
    expect(pages.find(p => p.id === 'x').readerRank).toBe(2);
    expect(pages.find(p => p.id === 'y').readerRank).toBe(1);
  });

  it('skips pages without importance scores', () => {
    const pages = [
      { id: 'a', readerImportance: 50 },
      { id: 'b' }, // no importance
    ];
    const { readerRanked } = computePageRankings(pages);
    expect(readerRanked).toBe(1);
    expect(pages.find(p => p.id === 'b').readerRank).toBeUndefined();
  });
});

describe('computeRecommendedScores', () => {
  it('assigns a recommendedScore to each page', () => {
    const pages = [
      { id: 'a', quality: 8, readerImportance: 70, wordCount: 2000 },
      { id: 'b', quality: 3, readerImportance: 20, wordCount: 100 },
    ];
    const now = Date.now();
    computeRecommendedScores(pages, now);
    expect(pages[0].recommendedScore).toBeGreaterThan(pages[1].recommendedScore);
    expect(typeof pages[0].recommendedScore).toBe('number');
  });

  it('gives recency boost to recently updated pages', () => {
    const now = Date.now();
    const pages = [
      { id: 'recent', quality: 5, readerImportance: 50, lastUpdated: new Date(now - 86_400_000).toISOString() },
      { id: 'old', quality: 5, readerImportance: 50, lastUpdated: new Date(now - 365 * 86_400_000).toISOString() },
    ];
    computeRecommendedScores(pages, now);
    expect(pages[0].recommendedScore).toBeGreaterThan(pages[1].recommendedScore);
  });
});

describe('buildUpdateSchedule', () => {
  it('sorts by priority descending', () => {
    const pages = [
      { id: 'low', title: 'Low', updateFrequency: 90, lastUpdated: '2026-02-01', readerImportance: 20 },
      { id: 'high', title: 'High', updateFrequency: 30, lastUpdated: '2025-01-01', readerImportance: 80 },
    ];
    const now = new Date('2026-02-27').getTime();
    const items = buildUpdateSchedule(pages, { low: 'E1', high: 'E2' }, now);
    expect(items.length).toBe(2);
    expect(items[0].id).toBe('high');
    expect(items[0].priority).toBeGreaterThan(items[1].priority);
  });

  it('skips pages without updateFrequency', () => {
    const pages = [
      { id: 'a', title: 'A' }, // no updateFrequency
    ];
    const items = buildUpdateSchedule(pages, {}, Date.now());
    expect(items.length).toBe(0);
  });

  it('skips non-evergreen pages', () => {
    const pages = [
      { id: 'a', title: 'A', updateFrequency: 30, evergreen: false },
    ];
    const items = buildUpdateSchedule(pages, {}, Date.now());
    expect(items.length).toBe(0);
  });
});
