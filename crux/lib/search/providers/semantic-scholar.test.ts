import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSemanticScholarProvider } from './semantic-scholar.ts';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('semantic-scholar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function jsonResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    } as Response;
  }

  describe('isAvailable', () => {
    it('always returns true (no auth required)', () => {
      const provider = createSemanticScholarProvider();
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('search', () => {
    it('searches papers for concept entity type', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        total: 1,
        data: [{
          paperId: 'abc123',
          title: 'Constitutional AI: Harmlessness from AI Feedback',
          abstract: 'We study a method for training harmless AI systems.',
          year: 2022,
          citationCount: 500,
          url: 'https://www.semanticscholar.org/paper/abc123',
          authors: [
            { authorId: '1', name: 'Yuntao Bai' },
            { authorId: '2', name: 'Saurav Kadavath' },
          ],
        }],
      }));

      const provider = createSemanticScholarProvider();
      const results = await provider.search('constitutional AI', 5, 'concept');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Constitutional AI: Harmlessness from AI Feedback');
      expect(results[0].provider).toBe('semantic-scholar');
      expect(results[0].snippet).toContain('2022');
      expect(results[0].snippet).toContain('500 citations');
    });

    it('searches author then papers for person entity type', async () => {
      // Author search
      mockFetch.mockResolvedValueOnce(jsonResponse({
        total: 1,
        data: [{
          authorId: '12345',
          name: 'Stuart Russell',
          url: 'https://www.semanticscholar.org/author/12345',
          paperCount: 300,
          citationCount: 80000,
          hIndex: 95,
          affiliations: ['UC Berkeley'],
        }],
      }));

      // Author papers (4 papers = 1 author profile + 4 papers = 5 = maxResults)
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [
          {
            paperId: 'paper1',
            title: 'Artificial Intelligence: A Modern Approach',
            year: 2020,
            citationCount: 50000,
            url: 'https://www.semanticscholar.org/paper/paper1',
            authors: [
              { authorId: '12345', name: 'Stuart Russell' },
              { authorId: '67890', name: 'Peter Norvig' },
            ],
          },
          {
            paperId: 'paper2',
            title: 'Human Compatible',
            year: 2019,
            citationCount: 3000,
            url: 'https://www.semanticscholar.org/paper/paper2',
            authors: [{ authorId: '12345', name: 'Stuart Russell' }],
          },
          {
            paperId: 'paper3',
            title: 'Research Priorities for Robust AI',
            year: 2015,
            citationCount: 2000,
            url: 'https://www.semanticscholar.org/paper/paper3',
            authors: [{ authorId: '12345', name: 'Stuart Russell' }],
          },
          {
            paperId: 'paper4',
            title: 'Provably Beneficial AI',
            year: 2017,
            citationCount: 1500,
            url: 'https://www.semanticscholar.org/paper/paper4',
            authors: [{ authorId: '12345', name: 'Stuart Russell' }],
          },
        ],
      }));

      const provider = createSemanticScholarProvider();
      const results = await provider.search('Stuart Russell', 5, 'person');

      expect(results).toHaveLength(5);
      // First hit should be the author profile
      expect(results[0].title).toBe('Stuart Russell');
      expect(results[0].snippet).toContain('UC Berkeley');
      expect(results[0].snippet).toContain('h-index: 95');
      // Second hit should be a paper (sorted by citation count)
      expect(results[1].title).toBe('Artificial Intelligence: A Modern Approach');
    });

    it('falls back to paper search when author search returns empty', async () => {
      // Author search returns empty
      mockFetch.mockResolvedValueOnce(jsonResponse({
        total: 0,
        data: [],
      }));

      // Paper search
      mockFetch.mockResolvedValueOnce(jsonResponse({
        total: 1,
        data: [{
          paperId: 'p1',
          title: 'Some Paper by Unknown Author',
          year: 2023,
          citationCount: 10,
          url: 'https://www.semanticscholar.org/paper/p1',
          authors: [],
        }],
      }));

      const provider = createSemanticScholarProvider();
      const results = await provider.search('Unknown Researcher', 5, 'person');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Some Paper by Unknown Author');
    });

    it('handles API error gracefully', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(
        { error: 'rate limited' },
        429,
      ));

      const provider = createSemanticScholarProvider();
      await expect(provider.search('test', 5, 'concept')).rejects.toThrow('Semantic Scholar API error 429');
    });

    it('filters out papers with missing title or URL', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        total: 3,
        data: [
          { paperId: 'p1', title: 'Good Paper', url: 'https://s2.org/p1', year: 2023, citationCount: 10 },
          { paperId: 'p2', title: '', url: 'https://s2.org/p2', year: 2023, citationCount: 5 },
          { paperId: 'p3', title: 'Another Paper', url: '', year: 2023, citationCount: 3 },
        ],
      }));

      const provider = createSemanticScholarProvider();
      const results = await provider.search('test', 5, 'concept');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Good Paper');
    });

    it('respects maxResults limit', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        total: 10,
        data: Array.from({ length: 10 }, (_, i) => ({
          paperId: `p${i}`,
          title: `Paper ${i}`,
          url: `https://s2.org/p${i}`,
          year: 2023,
          citationCount: 100 - i,
        })),
      }));

      const provider = createSemanticScholarProvider();
      const results = await provider.search('test', 3, 'concept');

      expect(results).toHaveLength(3);
    });
  });
});
