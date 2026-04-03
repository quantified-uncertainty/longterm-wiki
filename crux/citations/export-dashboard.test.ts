import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDashboardExport } from './export-dashboard.ts';

// Mock the wiki-server citations client
vi.mock('../lib/wiki-server/citations.ts', () => ({
  getAllQuotes: vi.fn(),
  getAccuracyDashboard: vi.fn(),
}));

import { getAllQuotes } from '../lib/wiki-server/citations.ts';
const mockGetAllQuotes = vi.mocked(getAllQuotes);

/**
 * Helper to build a mock quote row matching the API shape (camelCase).
 */
function makeQuote(overrides: {
  pageId: number;
  footnote: number;
  claimText: string;
  url?: string;
  sourceQuote?: string;
  accuracyVerdict?: string;
  accuracyScore?: number;
  accuracyIssues?: string;
  verificationDifficulty?: string;
  sourceTitle?: string;
  accuracyCheckedAt?: string;
}) {
  return {
    id: Math.floor(Math.random() * 100000),
    pageId: overrides.pageId,
    pageSlug: null as string | null,
    pageIdInt: null as number | null,
    footnote: overrides.footnote,
    url: overrides.url ?? null,
    resourceId: null,
    claimText: overrides.claimText,
    claimContext: null,
    sourceQuote: overrides.sourceQuote ?? null,
    sourceLocation: null,
    quoteVerified: false,
    verificationMethod: null,
    verificationScore: null,
    verifiedAt: null,
    sourceTitle: overrides.sourceTitle ?? null,
    sourceType: null,
    extractionModel: null,
    claimId: null,
    accuracyVerdict: overrides.accuracyVerdict ?? null,
    accuracyIssues: overrides.accuracyIssues ?? null,
    accuracyScore: overrides.accuracyScore ?? null,
    accuracyCheckedAt: overrides.accuracyCheckedAt ?? null,
    accuracySupportingQuotes: null,
    verificationDifficulty: overrides.verificationDifficulty ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mockQuotes(quotes: ReturnType<typeof makeQuote>[]) {
  mockGetAllQuotes.mockResolvedValue({
    ok: true as const,
    data: { quotes, total: quotes.length, limit: 5000, offset: 0 },
  });
}

describe('buildDashboardExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no quotes exist', async () => {
    mockQuotes([]);
    const result = await buildDashboardExport();
    expect(result).toBeNull();
  });

  it('returns correct summary for basic data', async () => {
    mockQuotes([
      makeQuote({ pageId: 100, footnote: 1, claimText: 'Claim A', accuracyVerdict: 'accurate', accuracyScore: 0.95 }),
      makeQuote({ pageId: 100, footnote: 2, claimText: 'Claim B', accuracyVerdict: 'inaccurate', accuracyScore: 0.2 }),
      makeQuote({ pageId: 100, footnote: 3, claimText: 'Claim C' }), // unchecked
    ]);

    const result = (await buildDashboardExport())!;
    expect(result).not.toBeNull();
    expect(result.summary.totalCitations).toBe(3);
    expect(result.summary.checkedCitations).toBe(2);
    expect(result.summary.accurateCitations).toBe(1);
    expect(result.summary.inaccurateCitations).toBe(1);
    expect(result.summary.uncheckedCitations).toBe(1);
  });

  it('computes per-page accuracy rate correctly', async () => {
    mockQuotes([
      makeQuote({ pageId: 200, footnote: 1, claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
      makeQuote({ pageId: 200, footnote: 2, claimText: 'C2', accuracyVerdict: 'accurate', accuracyScore: 0.8 }),
      makeQuote({ pageId: 200, footnote: 3, claimText: 'C3', accuracyVerdict: 'inaccurate', accuracyScore: 0.3 }),
      makeQuote({ pageId: 201, footnote: 1, claimText: 'C4', accuracyVerdict: 'accurate', accuracyScore: 1.0 }),
    ]);

    const result = (await buildDashboardExport())!;
    const pageA = result.pages.find(p => p.pageId === '200')!;
    const pageB = result.pages.find(p => p.pageId === '201')!;

    expect(pageA.checked).toBe(3);
    expect(pageA.accurate).toBe(2);
    expect(pageA.inaccurate).toBe(1);
    // accuracy rate = (accurate + minorIssues) / checked = 2/3
    expect(pageA.accuracyRate).toBeCloseTo(2 / 3);

    expect(pageB.checked).toBe(1);
    expect(pageB.accuracyRate).toBe(1.0);
  });

  it('handles minor_issues and unsupported verdicts', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, claimText: 'C1', accuracyVerdict: 'minor_issues', accuracyScore: 0.7 }),
      makeQuote({ pageId: 300, footnote: 2, claimText: 'C2', accuracyVerdict: 'unsupported', accuracyScore: 0.1 }),
    ]);

    const result = (await buildDashboardExport())!;
    expect(result.summary.minorIssueCitations).toBe(1);
    expect(result.summary.unsupportedCitations).toBe(1);

    const page = result.pages.find(p => p.pageId === '300')!;
    expect(page.minorIssues).toBe(1);
    expect(page.unsupported).toBe(1);
    // accuracy rate includes minor_issues as "acceptable"
    expect(page.accuracyRate).toBe(0.5); // (0 accurate + 1 minor) / 2 checked
  });

  it('flags inaccurate and unsupported citations', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, claimText: 'Good claim', accuracyVerdict: 'accurate', accuracyScore: 0.95 }),
      makeQuote({ pageId: 300, footnote: 2, claimText: 'Bad claim', accuracyVerdict: 'inaccurate', accuracyScore: 0.2, accuracyIssues: 'Wrong number' }),
      makeQuote({ pageId: 300, footnote: 3, claimText: 'Unsourced claim', accuracyVerdict: 'unsupported', accuracyScore: 0.1 }),
    ]);

    const result = (await buildDashboardExport())!;
    expect(result.flaggedCitations).toHaveLength(2);
    expect(result.flaggedCitations[0].verdict).toBe('unsupported'); // sorted by score, lowest first
    expect(result.flaggedCitations[1].verdict).toBe('inaccurate');
  });

  it('computes verdict distribution', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
      makeQuote({ pageId: 300, footnote: 2, claimText: 'C2', accuracyVerdict: 'accurate', accuracyScore: 0.8 }),
      makeQuote({ pageId: 300, footnote: 3, claimText: 'C3', accuracyVerdict: 'inaccurate', accuracyScore: 0.3 }),
    ]);

    const result = (await buildDashboardExport())!;
    expect(result.verdictDistribution).toEqual({
      accurate: 2,
      inaccurate: 1,
    });
  });

  it('computes difficulty distribution', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9, verificationDifficulty: 'easy' }),
      makeQuote({ pageId: 300, footnote: 2, claimText: 'C2', accuracyVerdict: 'accurate', accuracyScore: 0.8, verificationDifficulty: 'hard' }),
      makeQuote({ pageId: 300, footnote: 3, claimText: 'C3', accuracyVerdict: 'inaccurate', accuracyScore: 0.3, verificationDifficulty: 'hard' }),
    ]);

    const result = (await buildDashboardExport())!;
    expect(result.difficultyDistribution).toEqual({
      easy: 1,
      hard: 2,
    });
  });

  it('computes domain analysis correctly', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, url: 'https://arxiv.org/abs/1', claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
      makeQuote({ pageId: 300, footnote: 2, url: 'https://arxiv.org/abs/2', claimText: 'C2', accuracyVerdict: 'inaccurate', accuracyScore: 0.3 }),
      makeQuote({ pageId: 301, footnote: 1, url: 'https://arxiv.org/abs/3', claimText: 'C3', accuracyVerdict: 'unsupported', accuracyScore: 0.1 }),
      makeQuote({ pageId: 301, footnote: 2, url: 'https://example.com/1', claimText: 'C4', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
    ]);

    const result = (await buildDashboardExport())!;
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

  it('strips www. from domains', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, url: 'https://www.example.com/a', claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
      makeQuote({ pageId: 300, footnote: 2, url: 'https://www.example.com/b', claimText: 'C2', accuracyVerdict: 'accurate', accuracyScore: 0.8 }),
    ]);

    const result = (await buildDashboardExport())!;
    expect(result.domainAnalysis[0].domain).toBe('example.com');
  });

  it('sorts pages by inaccuracy rate (worst first)', async () => {
    mockQuotes([
      // page-good: 100% accurate
      makeQuote({ pageId: 400, footnote: 1, claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
      makeQuote({ pageId: 400, footnote: 2, claimText: 'C2', accuracyVerdict: 'accurate', accuracyScore: 0.8 }),
      // page-bad: 50% inaccurate
      makeQuote({ pageId: 401, footnote: 1, claimText: 'C3', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
      makeQuote({ pageId: 401, footnote: 2, claimText: 'C4', accuracyVerdict: 'inaccurate', accuracyScore: 0.2 }),
    ]);

    const result = (await buildDashboardExport())!;
    expect(result.pages[0].pageId).toBe('401');
    expect(result.pages[1].pageId).toBe('400');
  });

  it('handles average score with null scores', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
      makeQuote({ pageId: 300, footnote: 2, claimText: 'C2', accuracyVerdict: 'accurate' }), // no score
    ]);

    const result = (await buildDashboardExport())!;
    // Only one score counted
    expect(result.summary.averageScore).toBe(0.9);
  });

  it('includes exportedAt timestamp', async () => {
    mockQuotes([
      makeQuote({ pageId: 300, footnote: 1, claimText: 'C1', accuracyVerdict: 'accurate', accuracyScore: 0.9 }),
    ]);

    const result = (await buildDashboardExport())!;
    expect(result.exportedAt).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(result.exportedAt).getTime()).not.toBeNaN();
  });

  it('returns null when API call fails', async () => {
    mockGetAllQuotes.mockResolvedValue({
      ok: false as const,
      error: 'unavailable',
      message: 'Server unavailable',
    });
    const result = await buildDashboardExport();
    expect(result).toBeNull();
  });
});
