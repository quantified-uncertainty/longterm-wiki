import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../lib/knowledge-db.ts';
import { buildDashboardExport } from './export-dashboard.ts';

/**
 * Seed the DB with citation quote rows for testing.
 * Uses getDb() which creates an in-memory test DB.
 */
function seedQuotes(
  rows: Array<{
    page_id: string;
    footnote: number;
    url?: string;
    claim_text: string;
    source_quote?: string;
    accuracy_verdict?: string;
    accuracy_score?: number;
    accuracy_issues?: string;
    verification_difficulty?: string;
    source_title?: string;
  }>,
) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO citation_quotes (
      page_id, footnote, url, claim_text, source_quote,
      accuracy_verdict, accuracy_score, accuracy_issues,
      verification_difficulty, source_title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.page_id,
      r.footnote,
      r.url ?? null,
      r.claim_text,
      r.source_quote ?? null,
      r.accuracy_verdict ?? null,
      r.accuracy_score ?? null,
      r.accuracy_issues ?? null,
      r.verification_difficulty ?? null,
      r.source_title ?? null,
    );
  }
}

function clearQuotes() {
  getDb().prepare('DELETE FROM citation_quotes').run();
}

describe('buildDashboardExport', () => {
  beforeEach(() => {
    clearQuotes();
  });

  it('returns null when no quotes exist', () => {
    const result = buildDashboardExport();
    expect(result).toBeNull();
  });

  it('returns correct summary for basic data', () => {
    seedQuotes([
      { page_id: 'test-page', footnote: 1, claim_text: 'Claim A', accuracy_verdict: 'accurate', accuracy_score: 0.95 },
      { page_id: 'test-page', footnote: 2, claim_text: 'Claim B', accuracy_verdict: 'inaccurate', accuracy_score: 0.2 },
      { page_id: 'test-page', footnote: 3, claim_text: 'Claim C' }, // unchecked
    ]);

    const result = buildDashboardExport()!;
    expect(result).not.toBeNull();
    expect(result.summary.totalCitations).toBe(3);
    expect(result.summary.checkedCitations).toBe(2);
    expect(result.summary.accurateCitations).toBe(1);
    expect(result.summary.inaccurateCitations).toBe(1);
    expect(result.summary.uncheckedCitations).toBe(1);
  });

  it('computes per-page accuracy rate correctly', () => {
    seedQuotes([
      { page_id: 'page-a', footnote: 1, claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
      { page_id: 'page-a', footnote: 2, claim_text: 'C2', accuracy_verdict: 'accurate', accuracy_score: 0.8 },
      { page_id: 'page-a', footnote: 3, claim_text: 'C3', accuracy_verdict: 'inaccurate', accuracy_score: 0.3 },
      { page_id: 'page-b', footnote: 1, claim_text: 'C4', accuracy_verdict: 'accurate', accuracy_score: 1.0 },
    ]);

    const result = buildDashboardExport()!;
    const pageA = result.pages.find(p => p.pageId === 'page-a')!;
    const pageB = result.pages.find(p => p.pageId === 'page-b')!;

    expect(pageA.checked).toBe(3);
    expect(pageA.accurate).toBe(2);
    expect(pageA.inaccurate).toBe(1);
    // accuracy rate = (accurate + minorIssues) / checked = 2/3
    expect(pageA.accuracyRate).toBeCloseTo(2 / 3);

    expect(pageB.checked).toBe(1);
    expect(pageB.accuracyRate).toBe(1.0);
  });

  it('handles minor_issues and unsupported verdicts', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, claim_text: 'C1', accuracy_verdict: 'minor_issues', accuracy_score: 0.7 },
      { page_id: 'p1', footnote: 2, claim_text: 'C2', accuracy_verdict: 'unsupported', accuracy_score: 0.1 },
    ]);

    const result = buildDashboardExport()!;
    expect(result.summary.minorIssueCitations).toBe(1);
    expect(result.summary.unsupportedCitations).toBe(1);

    const page = result.pages.find(p => p.pageId === 'p1')!;
    expect(page.minorIssues).toBe(1);
    expect(page.unsupported).toBe(1);
    // accuracy rate includes minor_issues as "acceptable"
    expect(page.accuracyRate).toBe(0.5); // (0 accurate + 1 minor) / 2 checked
  });

  it('flags inaccurate and unsupported citations', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, claim_text: 'Good claim', accuracy_verdict: 'accurate', accuracy_score: 0.95 },
      { page_id: 'p1', footnote: 2, claim_text: 'Bad claim', accuracy_verdict: 'inaccurate', accuracy_score: 0.2, accuracy_issues: 'Wrong number' },
      { page_id: 'p1', footnote: 3, claim_text: 'Unsourced claim', accuracy_verdict: 'unsupported', accuracy_score: 0.1 },
    ]);

    const result = buildDashboardExport()!;
    expect(result.flaggedCitations).toHaveLength(2);
    expect(result.flaggedCitations[0].verdict).toBe('unsupported'); // sorted by score, lowest first
    expect(result.flaggedCitations[1].verdict).toBe('inaccurate');
  });

  it('computes verdict distribution', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
      { page_id: 'p1', footnote: 2, claim_text: 'C2', accuracy_verdict: 'accurate', accuracy_score: 0.8 },
      { page_id: 'p1', footnote: 3, claim_text: 'C3', accuracy_verdict: 'inaccurate', accuracy_score: 0.3 },
    ]);

    const result = buildDashboardExport()!;
    expect(result.verdictDistribution).toEqual({
      accurate: 2,
      inaccurate: 1,
    });
  });

  it('computes difficulty distribution', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9, verification_difficulty: 'easy' },
      { page_id: 'p1', footnote: 2, claim_text: 'C2', accuracy_verdict: 'accurate', accuracy_score: 0.8, verification_difficulty: 'hard' },
      { page_id: 'p1', footnote: 3, claim_text: 'C3', accuracy_verdict: 'inaccurate', accuracy_score: 0.3, verification_difficulty: 'hard' },
    ]);

    const result = buildDashboardExport()!;
    expect(result.difficultyDistribution).toEqual({
      easy: 1,
      hard: 2,
    });
  });

  it('computes domain analysis correctly', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, url: 'https://arxiv.org/abs/1', claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
      { page_id: 'p1', footnote: 2, url: 'https://arxiv.org/abs/2', claim_text: 'C2', accuracy_verdict: 'inaccurate', accuracy_score: 0.3 },
      { page_id: 'p2', footnote: 1, url: 'https://arxiv.org/abs/3', claim_text: 'C3', accuracy_verdict: 'unsupported', accuracy_score: 0.1 },
      { page_id: 'p2', footnote: 2, url: 'https://example.com/1', claim_text: 'C4', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
    ]);

    const result = buildDashboardExport()!;
    // example.com only has 1 citation, so it's excluded (MIN_DOMAIN_CITATIONS = 2)
    expect(result.domainAnalysis).toHaveLength(1);

    const arxiv = result.domainAnalysis[0];
    expect(arxiv.domain).toBe('arxiv.org');
    expect(arxiv.totalCitations).toBe(3);
    expect(arxiv.checked).toBe(3);
    expect(arxiv.accurate).toBe(1);
    expect(arxiv.inaccurate).toBe(1);
    expect(arxiv.unsupported).toBe(1);
    // inaccuracyRate = (inaccurate + unsupported) / checked = 2/3
    expect(arxiv.inaccuracyRate).toBeCloseTo(2 / 3);
  });

  it('strips www. from domains', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, url: 'https://www.example.com/a', claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
      { page_id: 'p1', footnote: 2, url: 'https://www.example.com/b', claim_text: 'C2', accuracy_verdict: 'accurate', accuracy_score: 0.8 },
    ]);

    const result = buildDashboardExport()!;
    expect(result.domainAnalysis[0].domain).toBe('example.com');
  });

  it('sorts pages by inaccuracy rate (worst first)', () => {
    seedQuotes([
      // page-good: 100% accurate
      { page_id: 'page-good', footnote: 1, claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
      { page_id: 'page-good', footnote: 2, claim_text: 'C2', accuracy_verdict: 'accurate', accuracy_score: 0.8 },
      // page-bad: 50% inaccurate
      { page_id: 'page-bad', footnote: 1, claim_text: 'C3', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
      { page_id: 'page-bad', footnote: 2, claim_text: 'C4', accuracy_verdict: 'inaccurate', accuracy_score: 0.2 },
    ]);

    const result = buildDashboardExport()!;
    expect(result.pages[0].pageId).toBe('page-bad');
    expect(result.pages[1].pageId).toBe('page-good');
  });

  it('handles average score with null scores', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
      { page_id: 'p1', footnote: 2, claim_text: 'C2', accuracy_verdict: 'accurate' }, // no score
    ]);

    const result = buildDashboardExport()!;
    // Only one score counted
    expect(result.summary.averageScore).toBe(0.9);
  });

  it('includes exportedAt timestamp', () => {
    seedQuotes([
      { page_id: 'p1', footnote: 1, claim_text: 'C1', accuracy_verdict: 'accurate', accuracy_score: 0.9 },
    ]);

    const result = buildDashboardExport()!;
    expect(result.exportedAt).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(result.exportedAt).getTime()).not.toBeNaN();
  });
});
