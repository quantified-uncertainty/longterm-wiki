import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { extractClaimSentence, extractCitationsFromContent, verifyCitationsForPage } from './citation-archive.ts';

// ---------------------------------------------------------------------------
// Mocks for verifyCitationsForPage tests
// ---------------------------------------------------------------------------

// Mock knowledge-db (SQLite) — best-effort local store
vi.mock('./knowledge-db.ts', () => ({
  citationContent: {
    getByUrl: vi.fn(() => null),
    upsert: vi.fn(),
  },
}));

// Mock wiki-server citations client (PostgreSQL)
const mockUpsertCitationContent = vi.fn().mockResolvedValue({ ok: true, data: { url: 'mock' } });
vi.mock('./wiki-server/citations.ts', () => ({
  upsertCitationContent: (...args: unknown[]) => mockUpsertCitationContent(...args),
}));

// Mock fs to prevent YAML archive writes during tests
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        // Allow real existsSync for non-archive paths
        if (typeof p === 'string' && p.includes('citation-archive')) return true;
        return actual.existsSync(p);
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: actual.readFileSync,
      readdirSync: actual.readdirSync,
    },
  };
});

describe('extractClaimSentence', () => {
  const sampleBody = `
# AI Safety Overview

The field of AI safety research has grown rapidly. Global spending on AI safety reached an estimated \\$100 million by 2023.[^1] This represents significant growth from just a few years prior.

Several organizations lead this work. The Center for AI Safety published a statement warning that AI extinction risk should be a global priority.[^2]

Many experts believe that transformative AI could arrive within decades.[^3] However, timelines remain highly uncertain.

[^1]: [AI Safety Funding Report](https://example.com/report)
[^2]: [CAIS Statement](https://example.com/cais)
[^3]: Bostrom (2014). Superintelligence: Paths, Dangers, Strategies.
`.trim();

  it('extracts the sentence containing the footnote reference', () => {
    const claim = extractClaimSentence(sampleBody, 1);
    expect(claim).toContain('Global spending on AI safety');
    expect(claim).toContain('100 million');
    // Should not contain the footnote marker itself
    expect(claim).not.toContain('[^1]');
  });

  it('extracts claim for footnote 2', () => {
    const claim = extractClaimSentence(sampleBody, 2);
    expect(claim).toContain('Center for AI Safety');
    expect(claim).toContain('extinction risk');
  });

  it('extracts claim for footnote 3', () => {
    const claim = extractClaimSentence(sampleBody, 3);
    expect(claim).toContain('transformative AI');
  });

  it('returns empty string for non-existent footnote', () => {
    const claim = extractClaimSentence(sampleBody, 99);
    expect(claim).toBe('');
  });

  it('handles multiple footnotes on the same line', () => {
    const body = `Some fact[^1] and another fact[^2] in the same sentence.

[^1]: [Source 1](https://example.com/1)
[^2]: [Source 2](https://example.com/2)`;

    const claim1 = extractClaimSentence(body, 1);
    expect(claim1).toContain('Some fact');

    const claim2 = extractClaimSentence(body, 2);
    expect(claim2).toContain('another fact');
  });

  it('extracts only the specific list item, not sibling items', () => {
    const body = `## Timeline

- **2016**: Open Philanthropy estimated 10% probability of transformative AI within 20 years[^1]
- **2020**: Metaculus community median moved from 2040 to 2030[^2]
- **2023**: Average forecast shifted to 25% by 2030[^3]

[^1]: [OP Report](https://example.com/op)
[^2]: [Metaculus](https://example.com/meta)
[^3]: [Survey](https://example.com/survey)`;

    const claim1 = extractClaimSentence(body, 1);
    // Should only contain the 2016 item
    expect(claim1).toContain('Open Philanthropy estimated 10%');
    // Should NOT contain sibling list items
    expect(claim1).not.toContain('Metaculus');
    expect(claim1).not.toContain('2023');

    const claim2 = extractClaimSentence(body, 2);
    expect(claim2).toContain('Metaculus community median');
    expect(claim2).not.toContain('Open Philanthropy');
    expect(claim2).not.toContain('2023');
  });

  it('handles list items with continuation lines', () => {
    const body = `## Mentors

- **Alice**: Researcher at Lab A, focuses on
  alignment and interpretability[^1]
- **Bob**: Researcher at Lab B[^2]

[^1]: [Source](https://example.com/1)
[^2]: [Source](https://example.com/2)`;

    const claim1 = extractClaimSentence(body, 1);
    expect(claim1).toContain('Alice');
    expect(claim1).toContain('alignment and interpretability');
    expect(claim1).not.toContain('Bob');
  });

  it('handles numbered list items', () => {
    const body = `## Steps

1. First step with a claim[^1]
2. Second step with another[^2]

[^1]: [Source](https://example.com/1)
[^2]: [Source](https://example.com/2)`;

    const claim1 = extractClaimSentence(body, 1);
    expect(claim1).toContain('First step');
    expect(claim1).not.toContain('Second step');
  });
});

describe('extractCitationsFromContent', () => {
  it('extracts titled link citations', () => {
    const body = `
Some claim here.[^1]

[^1]: [Report Title](https://example.com/report)
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe(1);
    expect(citations[0].url).toBe('https://example.com/report');
    expect(citations[0].linkText).toBe('Report Title');
  });

  it('extracts academic-style embedded link citations', () => {
    const body = `
AI timelines are uncertain.[^1]

[^1]: Holden Karnofsky, "[Some Background on Our Views Regarding Advanced AI](https://example.com/karnofsky)," Open Philanthropy, 2016.
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe(1);
    expect(citations[0].url).toBe('https://example.com/karnofsky');
    expect(citations[0].linkText).toContain('Some Background on Our Views');
    expect(citations[0].linkText).toContain('Holden Karnofsky');
  });

  it('extracts bare URL citations', () => {
    const body = `
Some claim here.[^1]

[^1]: https://example.com/bare
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].url).toBe('https://example.com/bare');
    expect(citations[0].linkText).toBe('');
  });

  it('captures claim context from surrounding text', () => {
    const body = `
AI safety is important. The field has grown to \\$100M in funding.[^1] Growth continues.

[^1]: [Funding Report](https://example.com/funding)
`;
    const citations = extractCitationsFromContent(body);
    expect(citations[0].claimContext).toContain('100M');
  });

  it('extracts text-then-bare-URL citations', () => {
    const body = `
TransformerLens is a key tool.[^1] It was built for mechanistic interpretability.[^2]

[^1]: TransformerLens GitHub repository: https://github.com/neelnanda-io/TransformerLens
[^2]: Elhage, N., Nanda, N., et al. (2021). "A Mathematical Framework for Transformer Circuits." Transformer Circuits Thread. https://transformer-circuits.pub/2021/framework/index.html
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(2);

    expect(citations[0].footnote).toBe(1);
    expect(citations[0].url).toBe('https://github.com/neelnanda-io/TransformerLens');
    expect(citations[0].linkText).toBe('TransformerLens GitHub repository');

    expect(citations[1].footnote).toBe(2);
    expect(citations[1].url).toBe('https://transformer-circuits.pub/2021/framework/index.html');
    expect(citations[1].linkText).toContain('Mathematical Framework');
  });

  it('skips footnotes without URLs', () => {
    const body = `
Some claim.[^1] Another claim.[^2]

[^1]: [Report](https://example.com/report)
[^2]: Based on statements in blog posts discussing limitations
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe(1);
  });

  it('handles mixed footnote formats in the same page', () => {
    const body = `
Claim A.[^1] Claim B.[^2] Claim C.[^3] Claim D.[^4]

[^1]: [Titled Link](https://example.com/titled)
[^2]: Author, "[Embedded Link](https://example.com/embedded)," Journal, 2024.
[^3]: Description text: https://example.com/text-url
[^4]: https://example.com/bare
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(4);
    expect(citations[0].url).toBe('https://example.com/titled');
    expect(citations[1].url).toBe('https://example.com/embedded');
    expect(citations[2].url).toBe('https://example.com/text-url');
    expect(citations[3].url).toBe('https://example.com/bare');
  });
});

// ---------------------------------------------------------------------------
// verifyCitationsForPage — PostgreSQL integration tests
// ---------------------------------------------------------------------------

const SAMPLE_HTML = `<html><head><title>Test Page</title></head><body><p>Hello world content for testing</p></body></html>`;

describe('verifyCitationsForPage — PostgreSQL writes', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    mockUpsertCitationContent.mockClear();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('calls upsertCitationContent for verified URLs with content', async () => {
    fetchSpy.mockResolvedValue(new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Test Source](https://example.com/test-page)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(mockUpsertCitationContent).toHaveBeenCalledTimes(1);
    const call = mockUpsertCitationContent.mock.calls[0][0];
    expect(call.url).toBe('https://example.com/test-page');
    expect(call.httpStatus).toBe(200);
    expect(call.fullText).toContain('Hello world content');
    expect(call.pageTitle).toBe('Test Page');
    expect(call.contentLength).toBeGreaterThan(0);
    expect(call.fetchedAt).toBeTruthy();
  });

  it('does NOT call upsertCitationContent for broken URLs (4xx)', async () => {
    fetchSpy.mockResolvedValue(new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Dead Link](https://example.com/missing)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(mockUpsertCitationContent).not.toHaveBeenCalled();
  });

  it('does NOT call upsertCitationContent for unverifiable domains', async () => {
    const body = `Some claim.[^1]\n\n[^1]: [Tweet](https://twitter.com/user/status/123)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(mockUpsertCitationContent).not.toHaveBeenCalled();
    // fetch should not even be called for unverifiable domains
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls upsertCitationContent for each URL when page has multiple citations', async () => {
    // Must return a fresh Response each call (body can only be consumed once)
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));

    const body = `Claim A.[^1] Claim B.[^2]\n\n[^1]: [Source A](https://example.com/a)\n[^2]: [Source B](https://example.com/b)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(mockUpsertCitationContent).toHaveBeenCalledTimes(2);
    const urls = mockUpsertCitationContent.mock.calls.map((c: unknown[]) => (c[0] as { url: string }).url);
    expect(urls).toContain('https://example.com/a');
    expect(urls).toContain('https://example.com/b');
  });

  it('gracefully handles wiki-server failure (does not throw)', async () => {
    mockUpsertCitationContent.mockRejectedValue(new Error('Connection refused'));

    fetchSpy.mockResolvedValue(new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/server-down)`;
    // Should not throw even though PG write fails
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(archive.verified).toBe(1);
    expect(archive.citations[0].status).toBe('verified');
  });

  it('does NOT call upsertCitationContent for PDFs (no text content)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': '12345' },
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Paper](https://example.com/paper.pdf)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(mockUpsertCitationContent).not.toHaveBeenCalled();
  });

  it('does NOT call upsertCitationContent for non-HTML content types', async () => {
    fetchSpy.mockResolvedValue(new Response('plain text data', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Data File](https://example.com/data.txt)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    // Non-HTML responses don't have fullHtml/fullText extracted
    expect(mockUpsertCitationContent).not.toHaveBeenCalled();
  });

  it('passes correct field types to upsertCitationContent', async () => {
    fetchSpy.mockResolvedValue(new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/types-check)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    const call = mockUpsertCitationContent.mock.calls[0][0];
    // Verify field types match UpsertCitationContentSchema expectations
    expect(typeof call.url).toBe('string');
    expect(typeof call.fetchedAt).toBe('string');
    expect(typeof call.httpStatus).toBe('number');
    expect(typeof call.fullText).toBe('string');
    expect(typeof call.contentLength).toBe('number');
    // contentType and pageTitle can be string or null
    expect(call.contentType === null || typeof call.contentType === 'string').toBe(true);
    expect(call.pageTitle === null || typeof call.pageTitle === 'string').toBe(true);
  });

  it('fetchedAt is a valid ISO 8601 datetime (matches Zod .datetime())', async () => {
    fetchSpy.mockResolvedValue(new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/datetime-test)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    const call = mockUpsertCitationContent.mock.calls[0][0];
    // Zod .datetime() expects ISO 8601: 2026-02-22T09:16:34.123Z
    expect(call.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it('does NOT call upsertCitationContent on fetch timeout', async () => {
    // Use fake timers so retry delays resolve instantly
    vi.useFakeTimers();

    fetchSpy.mockImplementation(() => {
      throw new Error('The operation was aborted due to timeout');
    });

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/slow-site)`;
    const promise = verifyCitationsForPage('test-page', body, { delayMs: 0 });

    // Advance past all retry delays (2s + 4s)
    await vi.advanceTimersByTimeAsync(10_000);
    const archive = await promise;

    expect(mockUpsertCitationContent).not.toHaveBeenCalled();
    // Timeout should mark as unverifiable, not broken
    expect(archive.citations[0].status).toBe('unverifiable');

    vi.useRealTimers();
  });

  it('does NOT call upsertCitationContent on network error', async () => {
    fetchSpy.mockImplementation(() => {
      throw new Error('ECONNREFUSED');
    });

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/down-host)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(mockUpsertCitationContent).not.toHaveBeenCalled();
    expect(archive.citations[0].status).toBe('broken');
  });

  it('handles page with mix of verifiable and unverifiable citations', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));

    const body = `Claim A.[^1] Claim B.[^2] Claim C.[^3]\n\n[^1]: [Source](https://example.com/good)\n[^2]: [Tweet](https://twitter.com/user/123)\n[^3]: [Source](https://example.com/also-good)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    // Only 2 PG writes: example.com/good and example.com/also-good (not twitter)
    expect(mockUpsertCitationContent).toHaveBeenCalledTimes(2);
    const urls = mockUpsertCitationContent.mock.calls.map((c: unknown[]) => (c[0] as { url: string }).url);
    expect(urls).toContain('https://example.com/good');
    expect(urls).toContain('https://example.com/also-good');
    expect(urls).not.toContain('https://twitter.com/user/123');
  });
});
