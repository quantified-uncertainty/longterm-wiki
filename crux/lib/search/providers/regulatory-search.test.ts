import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFederalRegisterProvider } from './regulatory-search.ts';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('regulatory-search', () => {
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
      const provider = createFederalRegisterProvider();
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('search', () => {
    it('searches for regulatory documents', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 1,
        results: [{
          title: 'Safe, Secure, and Trustworthy Development and Use of AI',
          html_url: 'https://www.federalregister.gov/documents/2023/10/30/2023-24283/safe-secure-ai',
          abstract: 'Executive order on AI safety and security requirements.',
          publication_date: '2023-10-30',
          document_type: 'Presidential Document',
          agencies: [{ name: 'Executive Office of the President', raw_name: 'EOP' }],
          document_number: '2023-24283',
        }],
      }));

      const provider = createFederalRegisterProvider();
      const results = await provider.search('AI safety executive order', 5, 'policy');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Safe, Secure, and Trustworthy Development and Use of AI');
      expect(results[0].provider).toBe('federal-register');
      expect(results[0].snippet).toContain('2023-10-30');
      expect(results[0].snippet).toContain('Presidential Document');
    });

    it('adds executive order filter for EO queries', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));

      const provider = createFederalRegisterProvider();
      await provider.search('Executive Order 14110', 5, 'policy');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('presidential_document_type');
      expect(url).toContain('executive_order');
    });

    it('adds executive order filter for EO number format', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));

      const provider = createFederalRegisterProvider();
      await provider.search('EO 14110', 5, 'policy');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('presidential_document_type');
    });

    it('does not add executive order filter for general policy queries', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));

      const provider = createFederalRegisterProvider();
      await provider.search('California SB 1047', 5, 'policy');

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain('presidential_document_type');
    });

    it('handles API error gracefully', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, 400));

      const provider = createFederalRegisterProvider();
      await expect(provider.search('test', 5, 'policy')).rejects.toThrow('Federal Register API error 400');
    });

    it('returns empty array when no results', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));

      const provider = createFederalRegisterProvider();
      const results = await provider.search('completely-obscure-query-xyz', 5, 'policy');

      expect(results).toEqual([]);
    });

    it('includes agency names in snippet', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 1,
        results: [{
          title: 'AI Risk Management Framework',
          html_url: 'https://www.federalregister.gov/documents/2024/01/01/2024-00001/ai-risk',
          abstract: null,
          publication_date: '2024-01-01',
          document_type: 'Notice',
          agencies: [
            { name: 'National Institute of Standards and Technology' },
            { name: 'Department of Commerce' },
          ],
        }],
      }));

      const provider = createFederalRegisterProvider();
      const results = await provider.search('NIST AI framework', 5, 'policy');

      expect(results[0].snippet).toContain('National Institute of Standards and Technology');
    });

    it('filters out documents with missing title or URL', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 3,
        results: [
          {
            title: 'Good Document',
            html_url: 'https://fr.gov/d/1',
            publication_date: '2024-01-01',
          },
          {
            title: '',
            html_url: 'https://fr.gov/d/2',
            publication_date: '2024-01-01',
          },
          {
            title: 'Missing URL',
            html_url: '',
            publication_date: '2024-01-01',
          },
        ],
      }));

      const provider = createFederalRegisterProvider();
      const results = await provider.search('test', 5, 'policy');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Good Document');
    });
  });
});
