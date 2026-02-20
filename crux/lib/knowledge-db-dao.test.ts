/**
 * Tests for citationQuotes DAO methods.
 *
 * Tests the aggregation queries (getPageStats, getSourceTypeStats,
 * getBrokenQuotes, getPagesWithQuotes) against real SQLite data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, citationQuotes } from './knowledge-db.ts';

/** Wipe citation_quotes table between tests. */
function clearQuotes() {
  getDb().prepare('DELETE FROM citation_quotes').run();
}

/** Seed a citation quote with sensible defaults. */
function seed(overrides: {
  pageId: string;
  footnote: number;
  claimText?: string;
  sourceQuote?: string | null;
  quoteVerified?: boolean;
  verificationScore?: number | null;
  sourceType?: string | null;
  accuracyVerdict?: string | null;
  accuracyScore?: number | null;
}) {
  citationQuotes.upsert({
    pageId: overrides.pageId,
    footnote: overrides.footnote,
    claimText: overrides.claimText ?? `Claim ${overrides.footnote}`,
    sourceQuote: overrides.sourceQuote ?? null,
    quoteVerified: overrides.quoteVerified ?? false,
    verificationScore: overrides.verificationScore ?? null,
    sourceType: overrides.sourceType ?? null,
  });

  // Set accuracy fields directly since upsert doesn't support them
  if (overrides.accuracyVerdict !== undefined) {
    getDb().prepare(`
      UPDATE citation_quotes
      SET accuracy_verdict = ?, accuracy_score = ?
      WHERE page_id = ? AND footnote = ?
    `).run(
      overrides.accuracyVerdict,
      overrides.accuracyScore ?? null,
      overrides.pageId,
      overrides.footnote,
    );
  }
}

// Clean up after all tests to avoid cross-file pollution when vitest runs files concurrently
afterEach(clearQuotes);

describe('citationQuotes.getPageStats', () => {
  beforeEach(clearQuotes);

  it('returns empty array when no data', () => {
    expect(citationQuotes.getPageStats()).toEqual([]);
  });

  it('aggregates correctly for a single page', () => {
    seed({ pageId: 'page-a', footnote: 1, sourceQuote: 'quote text', quoteVerified: true, verificationScore: 0.9, accuracyVerdict: 'accurate', accuracyScore: 0.95 });
    seed({ pageId: 'page-a', footnote: 2, sourceQuote: 'another quote', quoteVerified: true, verificationScore: 0.8, accuracyVerdict: 'inaccurate', accuracyScore: 0.3 });
    seed({ pageId: 'page-a', footnote: 3 }); // no quote

    const stats = citationQuotes.getPageStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].page_id).toBe('page-a');
    expect(stats[0].total).toBe(3);
    expect(stats[0].with_quotes).toBe(2);
    expect(stats[0].verified).toBe(2);
    expect(stats[0].accuracy_checked).toBe(2);
    expect(stats[0].accurate).toBe(1);
    expect(stats[0].inaccurate).toBe(1);
  });

  it('returns pages sorted by total descending', () => {
    seed({ pageId: 'small', footnote: 1 });
    seed({ pageId: 'big', footnote: 1 });
    seed({ pageId: 'big', footnote: 2 });
    seed({ pageId: 'big', footnote: 3 });

    const stats = citationQuotes.getPageStats();
    expect(stats[0].page_id).toBe('big');
    expect(stats[1].page_id).toBe('small');
  });

  it('counts unsupported as inaccurate', () => {
    seed({ pageId: 'p', footnote: 1, sourceQuote: 'q', accuracyVerdict: 'unsupported', accuracyScore: 0.1 });
    const stats = citationQuotes.getPageStats();
    expect(stats[0].inaccurate).toBe(1); // unsupported is in the inaccurate bucket
  });

  it('avg_score is null when no verification scores', () => {
    seed({ pageId: 'p', footnote: 1 });
    const stats = citationQuotes.getPageStats();
    expect(stats[0].avg_score).toBeNull();
  });
});

describe('citationQuotes.getSourceTypeStats', () => {
  beforeEach(clearQuotes);

  it('returns empty array when no data', () => {
    expect(citationQuotes.getSourceTypeStats()).toEqual([]);
  });

  it('groups by source type', () => {
    seed({ pageId: 'p', footnote: 1, sourceType: 'article', sourceQuote: 'q' });
    seed({ pageId: 'p', footnote: 2, sourceType: 'article' });
    seed({ pageId: 'p', footnote: 3, sourceType: 'book', sourceQuote: 'q' });

    const stats = citationQuotes.getSourceTypeStats();
    const article = stats.find(s => s.source_type === 'article');
    const book = stats.find(s => s.source_type === 'book');

    expect(article).toBeDefined();
    expect(article!.count).toBe(2);
    expect(article!.with_quotes).toBe(1);
    expect(book).toBeDefined();
    expect(book!.count).toBe(1);
    expect(book!.with_quotes).toBe(1);
  });

  it('uses "unknown" for null source type', () => {
    seed({ pageId: 'p', footnote: 1, sourceType: null });
    const stats = citationQuotes.getSourceTypeStats();
    expect(stats[0].source_type).toBe('unknown');
  });

  it('sorts by count descending', () => {
    seed({ pageId: 'p', footnote: 1, sourceType: 'rare' });
    seed({ pageId: 'p', footnote: 2, sourceType: 'common' });
    seed({ pageId: 'p', footnote: 3, sourceType: 'common' });

    const stats = citationQuotes.getSourceTypeStats();
    expect(stats[0].source_type).toBe('common');
  });
});

describe('citationQuotes.getBrokenQuotes', () => {
  beforeEach(clearQuotes);

  it('returns empty array when no data', () => {
    expect(citationQuotes.getBrokenQuotes()).toEqual([]);
  });

  it('returns quotes with low verification score that are unverified', () => {
    // Broken: has quote, not verified, low score
    seed({ pageId: 'p', footnote: 1, sourceQuote: 'bad quote', quoteVerified: false, verificationScore: 0.2 });
    // Not broken: verified
    seed({ pageId: 'p', footnote: 2, sourceQuote: 'good quote', quoteVerified: true, verificationScore: 0.9 });
    // Not broken: score above threshold
    seed({ pageId: 'p', footnote: 3, sourceQuote: 'ok quote', quoteVerified: false, verificationScore: 0.5 });
    // Not broken: no quote
    seed({ pageId: 'p', footnote: 4, quoteVerified: false, verificationScore: 0.1 });

    const broken = citationQuotes.getBrokenQuotes();
    expect(broken).toHaveLength(1);
    expect(broken[0].footnote).toBe(1);
    expect(broken[0].verification_score).toBe(0.2);
  });

  it('sorts by verification_score ascending', () => {
    seed({ pageId: 'p', footnote: 1, sourceQuote: 'q1', quoteVerified: false, verificationScore: 0.3 });
    seed({ pageId: 'p', footnote: 2, sourceQuote: 'q2', quoteVerified: false, verificationScore: 0.1 });

    const broken = citationQuotes.getBrokenQuotes();
    expect(broken[0].verification_score).toBe(0.1);
    expect(broken[1].verification_score).toBe(0.3);
  });

  it('excludes quotes with null verification score', () => {
    seed({ pageId: 'p', footnote: 1, sourceQuote: 'q', quoteVerified: false, verificationScore: null });
    expect(citationQuotes.getBrokenQuotes()).toHaveLength(0);
  });
});

describe('citationQuotes.getPagesWithQuotes', () => {
  beforeEach(clearQuotes);

  it('returns empty array when no data', () => {
    expect(citationQuotes.getPagesWithQuotes()).toEqual([]);
  });

  it('only includes pages with non-empty source quotes', () => {
    seed({ pageId: 'has-quotes', footnote: 1, sourceQuote: 'some evidence' });
    seed({ pageId: 'no-quotes', footnote: 1 }); // no sourceQuote

    const pages = citationQuotes.getPagesWithQuotes();
    expect(pages).toHaveLength(1);
    expect(pages[0].page_id).toBe('has-quotes');
    expect(pages[0].quote_count).toBe(1);
  });

  it('counts quotes per page correctly', () => {
    seed({ pageId: 'p1', footnote: 1, sourceQuote: 'q1' });
    seed({ pageId: 'p1', footnote: 2, sourceQuote: 'q2' });
    seed({ pageId: 'p1', footnote: 3 }); // no quote — shouldn't count
    seed({ pageId: 'p2', footnote: 1, sourceQuote: 'q3' });

    const pages = citationQuotes.getPagesWithQuotes();
    const p1 = pages.find(p => p.page_id === 'p1');
    const p2 = pages.find(p => p.page_id === 'p2');
    expect(p1!.quote_count).toBe(2);
    expect(p2!.quote_count).toBe(1);
  });

  it('sorts by quote_count descending', () => {
    seed({ pageId: 'small', footnote: 1, sourceQuote: 'q' });
    seed({ pageId: 'big', footnote: 1, sourceQuote: 'q1' });
    seed({ pageId: 'big', footnote: 2, sourceQuote: 'q2' });
    seed({ pageId: 'big', footnote: 3, sourceQuote: 'q3' });

    const pages = citationQuotes.getPagesWithQuotes();
    expect(pages[0].page_id).toBe('big');
    expect(pages[0].quote_count).toBe(3);
  });
});
