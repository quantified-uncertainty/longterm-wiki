/**
 * Tests for RAND Corporation date enrichment.
 *
 * Tests the pure helper functions (date parsing, URL classification,
 * URL-to-date extraction) without making network requests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock loadResourcesPGFirst before importing the module
vi.mock('../resource-io.ts', () => ({
  loadResourcesPGFirst: vi.fn(),
  saveResources: vi.fn().mockResolvedValue(undefined),
}));

// Mock sleep to not wait during tests
vi.mock('../resource-utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../resource-utils.ts')>();
  return {
    ...original,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

// We need to import after mocks are set up. The module uses these internally.
// Since the pure functions aren't exported, we test them through the command.
import { loadResourcesPGFirst, saveResources } from '../resource-io.ts';
import { enrichRandDatesCommand } from './enrich-rand-dates.ts';
import type { Resource } from '../resource-types.ts';

const mockedLoad = vi.mocked(loadResourcesPGFirst);
const mockedSave = vi.mocked(saveResources);

function makeRandResource(
  id: string,
  url: string,
  title: string,
  publishedDate?: string,
): Resource {
  return {
    id,
    url,
    title,
    type: 'report',
    published_date: publishedDate,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
    } as unknown as Response),
  );
});

describe('enrichRandDatesCommand', () => {
  it('extracts dates from commentary URL paths', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r1',
        'https://www.rand.org/pubs/commentary/2024/10/some-article.html',
        'RAND Commentary',
      ),
    ]);

    await enrichRandDatesCommand([], { 'dry-run': true });

    // No fetch should have been called — date was extracted from URL
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('extracts dates from blog URL paths', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r2',
        'https://www.rand.org/blog/2020/06/the-risks-of-autonomous-weapons.html',
        'RAND Blog',
      ),
    ]);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('Updated 1');
  });

  it('extracts dates from press release URL paths', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r3',
        'https://www.rand.org/news/press/2024/05/30.html',
        'RAND Press Release',
      ),
    ]);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('Updated 1');
  });

  it('skips non-publication pages (topics, about, homepage)', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r4',
        'https://www.rand.org/topics/artificial-intelligence.html',
        'RAND: AI',
      ),
      makeRandResource(
        'r5',
        'https://www.rand.org/about.html',
        'About RAND',
      ),
      makeRandResource('r6', 'https://www.rand.org/', 'RAND Homepage'),
      makeRandResource(
        'r7',
        'https://www.rand.org/about/faq.html',
        'FAQ',
      ),
      makeRandResource(
        'r8',
        'https://www.rand.org/global-and-emerging-risks/centers/ai-security-and-technology.html',
        'Center',
      ),
    ]);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('already have dates');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('skips resources that already have dates', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r9',
        'https://www.rand.org/pubs/research_reports/RRA2680-1.html',
        'Already dated',
        '2024-08-13',
      ),
    ]);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('already have dates');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('falls back to HTML scraping for publication pages without URL dates', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r10',
        'https://www.rand.org/pubs/research_reports/RRA2680-1.html',
        'Some Report',
      ),
    ]);

    // Simulate a successful RAND page fetch with citation_publication_date
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<html><head><meta name="citation_publication_date" content="2024/8/13"></head></html>',
    } as unknown as Response);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('Updated 1');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('parses rand-teaser-date as fallback', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r11',
        'https://www.rand.org/pubs/perspectives/PEA3776-1.html',
        'RAND Perspectives',
      ),
    ]);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<html><head><meta name="rand-teaser-date" content="20250114"></head></html>',
    } as unknown as Response);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('Updated 1');
  });

  it('parses DC.Date year-only as last fallback', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r12',
        'https://www.rand.org/pubs/research_reports/RR1234.html',
        'Some Old Report',
      ),
    ]);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<html><head><meta name="DC.Date" content="2019"></head></html>',
    } as unknown as Response);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('Updated 1');
  });

  it('converts PDF URLs to HTML landing pages for scraping', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r13',
        'https://www.rand.org/content/dam/rand/pubs/perspectives/PEA4100/PEA4155-1/RAND_PEA4155-1.pdf',
        'PDF Report',
      ),
    ]);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<html><head><meta name="citation_publication_date" content="2025/9/24"></head></html>',
    } as unknown as Response);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('Updated 1');

    // Should have fetched the HTML page, not the PDF
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://www.rand.org/pubs/perspectives/PEA4155-1.html',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('skips non-RAND resources', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r14',
        'https://arxiv.org/abs/2301.12345',
        'ArXiv paper',
      ),
    ]);

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.output).toContain('already have dates');
  });

  it('saves resources when not in dry-run mode', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r15',
        'https://www.rand.org/pubs/commentary/2025/01/some-article.html',
        'Saveable Resource',
      ),
    ]);

    await enrichRandDatesCommand([], {});
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'r15',
          published_date: '2025-01-01',
        }),
      ]),
    );
  });

  it('does not save in dry-run mode', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r16',
        'https://www.rand.org/pubs/commentary/2025/01/some-article.html',
        'No Save',
      ),
    ]);

    await enrichRandDatesCommand([], { 'dry-run': true });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('handles fetch errors gracefully (counts as failure, not crash)', async () => {
    mockedLoad.mockResolvedValue([
      makeRandResource(
        'r17',
        'https://www.rand.org/pubs/research_reports/RRA9999-1.html',
        'Erroring Resource',
      ),
    ]);

    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

    const result = await enrichRandDatesCommand([], { 'dry-run': true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Updated 0');
  });
});
