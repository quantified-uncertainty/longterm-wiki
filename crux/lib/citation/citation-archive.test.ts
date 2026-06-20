import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractClaimSentence, extractCitationsFromContent, verifyCitationsForPage } from './citation-archive.ts';
import { hostMatches } from '@longterm-wiki/url-utils';

// ---------------------------------------------------------------------------
// Mocks for verifyCitationsForPage tests
// ---------------------------------------------------------------------------

// Mock source-fetcher (the unified fetch layer that citation-archive delegates to)
const mockFetchSource = vi.fn();
vi.mock('../search/source-fetcher.ts', () => ({
  fetchSource: (...args: unknown[]) => mockFetchSource(...args),
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

// ---------------------------------------------------------------------------
// Helper to create a FetchedSource mock
// ---------------------------------------------------------------------------

function makeFetchedSource(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/test',
    title: 'Test Page',
    fetchedAt: new Date().toISOString(),
    content: 'Hello world content for testing',
    relevantExcerpts: [],
    status: 'ok',
    httpStatus: 200,
    contentType: 'html',
    ...overrides,
  };
}

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

  it('extracts claim sentence for [^rc-XXXX] references', () => {
    const body = `
AI capex-revenue gap is 6-14x.[^rc-fec0] Revenue estimates vary widely.

[^rc-fec0]: [Goldman Sachs AI Report](https://example.com/report)
`;
    const claim = extractClaimSentence(body, 'rc-fec0');
    expect(claim).toContain('capex-revenue gap');
    expect(claim).not.toContain('[^rc-fec0]');
  });

  it('accepts both string and number footnote IDs', () => {
    const body = `
Some fact here.[^1] Another fact.[^rc-abc1]

[^1]: [Source](https://example.com/1)
[^rc-abc1]: [Resource](https://example.com/resource)
`;
    // Number still works
    const claim1 = extractClaimSentence(body, 1);
    expect(claim1).toContain('Some fact here');

    // String works too
    const claim2 = extractClaimSentence(body, 'rc-abc1');
    expect(claim2).toContain('Another fact');
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
    expect(citations[0].footnote).toBe('1');
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
    expect(citations[0].footnote).toBe('1');
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

    expect(citations[0].footnote).toBe('1');
    expect(citations[0].url).toBe('https://github.com/neelnanda-io/TransformerLens');
    expect(citations[0].linkText).toBe('TransformerLens GitHub repository');

    expect(citations[1].footnote).toBe('2');
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
    expect(citations[0].footnote).toBe('1');
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

  it('extracts [^rc-XXXX] resource citations', () => {
    const body = `
AI capex-revenue gap is 6-14x.[^rc-fec0] Revenue estimates vary widely.[^rc-4bd8]

[^rc-fec0]: [Goldman Sachs AI Report](https://example.com/goldman-ai)
[^rc-4bd8]: [McKinsey AI Revenue Analysis](https://example.com/mckinsey)
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(2);
    expect(citations[0].footnote).toBe('rc-4bd8');
    expect(citations[0].url).toBe('https://example.com/mckinsey');
    expect(citations[1].footnote).toBe('rc-fec0');
    expect(citations[1].url).toBe('https://example.com/goldman-ai');
    expect(citations[1].claimContext).toContain('capex-revenue gap');
  });

  it('extracts [^kb-...] knowledge base citations', () => {
    const body = `
Anthropic revenue reached \\$1B.[^kb-mK9pX3rQ7n]

[^kb-mK9pX3rQ7n]: [Anthropic Financial Data](https://example.com/anthropic-finances)
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe('kb-mK9pX3rQ7n');
    expect(citations[0].url).toBe('https://example.com/anthropic-finances');
  });

  it('handles mixed numeric and rc/kb citations', () => {
    const body = `
Fact one.[^1] Fact two.[^rc-abc1] Fact three.[^2] Fact four.[^kb-xyz]

[^1]: [Source One](https://example.com/one)
[^rc-abc1]: [Resource Citation](https://example.com/resource)
[^2]: [Source Two](https://example.com/two)
[^kb-xyz]: [KB Citation](https://example.com/kb)
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(4);
    // Numeric first, then alphabetical
    expect(citations[0].footnote).toBe('1');
    expect(citations[1].footnote).toBe('2');
    expect(citations[2].footnote).toBe('kb-xyz');
    expect(citations[3].footnote).toBe('rc-abc1');
  });

  it('extracts [^rc-XXXX] with bare URL format', () => {
    const body = `
Some claim.[^rc-dead]

[^rc-dead]: https://example.com/bare-resource
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe('rc-dead');
    expect(citations[0].url).toBe('https://example.com/bare-resource');
    expect(citations[0].linkText).toBe('');
  });

  it('extracts [^rc-XXXX] with text-then-URL format', () => {
    const body = `
Some claim.[^rc-beef]

[^rc-beef]: Goldman Sachs AI Infrastructure Report: https://example.com/gs-report
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe('rc-beef');
    expect(citations[0].url).toBe('https://example.com/gs-report');
    expect(citations[0].linkText).toBe('Goldman Sachs AI Infrastructure Report');
  });
});

// ---------------------------------------------------------------------------
// verifyCitationsForPage — tests via source-fetcher mock
// ---------------------------------------------------------------------------

describe('verifyCitationsForPage', () => {
  beforeEach(() => {
    mockFetchSource.mockReset();
  });

  it('marks verified for successful fetches (HTTP 200 with content)', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      url: 'https://example.com/test-page',
      title: 'Test Page',
      content: 'Hello world content for testing',
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Test Source](https://example.com/test-page)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(archive.verified).toBe(1);
    expect(archive.citations[0].status).toBe('verified');
    expect(archive.citations[0].httpStatus).toBe(200);
    expect(archive.citations[0].pageTitle).toBe('Test Page');
    expect(archive.citations[0].contentSnippet).toContain('Hello world');
  });

  it('marks broken for dead URLs (HTTP 404)', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      url: 'https://example.com/missing',
      status: 'dead',
      httpStatus: 404,
      content: '',
      title: '',
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Dead Link](https://example.com/missing)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(archive.broken).toBe(1);
    expect(archive.citations[0].status).toBe('broken');
  });

  it('marks unverifiable for unverifiable domains (social media)', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      url: 'https://twitter.com/user/status/123',
      status: 'error',
      httpStatus: 0,
      content: '',
      title: '',
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Tweet](https://twitter.com/user/status/123)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    // Unverifiable domains return httpStatus 0, which maps to 'unverifiable'
    expect(archive.citations[0].status).toBe('unverifiable');
    // fetchSource is called (it handles unverifiable domains internally)
    expect(mockFetchSource).toHaveBeenCalledTimes(1);
  });

  it('handles multiple citations on a page', async () => {
    mockFetchSource.mockImplementation(({ url }: { url: string }) =>
      Promise.resolve(makeFetchedSource({ url, content: `Content for ${url}` })),
    );

    const body = `Claim A.[^1] Claim B.[^2]\n\n[^1]: [Source A](https://example.com/a)\n[^2]: [Source B](https://example.com/b)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(archive.verified).toBe(2);
    expect(archive.totalCitations).toBe(2);
    expect(mockFetchSource).toHaveBeenCalledTimes(2);
  });

  it('gracefully handles fetch errors (does not throw)', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      status: 'error',
      httpStatus: 0,
      content: '',
      title: '',
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/server-down)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    // Should not throw — httpStatus 0 maps to 'unverifiable' (covers timeouts and network errors)
    expect(archive.citations[0].status).toBe('unverifiable');
  });

  it('marks unverifiable for timeout errors (httpStatus 0)', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource({
      status: 'error',
      httpStatus: 0,
      content: '',
      title: '',
    }));

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/slow-site)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    // httpStatus 0 (timeout, network error, unverifiable domain) → 'unverifiable'
    expect(archive.citations[0].status).toBe('unverifiable');
  });

  it('handles mixed verifiable and unverifiable citations', async () => {
    mockFetchSource.mockImplementation(({ url }: { url: string }) => {
      if (hostMatches(url, 'twitter.com')) {
        return Promise.resolve(makeFetchedSource({
          url,
          status: 'error',
          httpStatus: 0,
          content: '',
          title: '',
        }));
      }
      return Promise.resolve(makeFetchedSource({
        url,
        content: 'Real content',
      }));
    });

    const body = `Claim A.[^1] Claim B.[^2] Claim C.[^3]\n\n[^1]: [Source](https://example.com/good)\n[^2]: [Tweet](https://twitter.com/user/123)\n[^3]: [Source](https://example.com/also-good)`;
    const archive = await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(archive.verified).toBe(2);
    expect(archive.unverifiable).toBe(1); // twitter.com → httpStatus 0 → unverifiable
    expect(mockFetchSource).toHaveBeenCalledTimes(3);
  });

  it('delegates to fetchSource with extractMode full', async () => {
    mockFetchSource.mockResolvedValue(makeFetchedSource());

    const body = `Some claim.[^1]\n\n[^1]: [Source](https://example.com/test)`;
    await verifyCitationsForPage('test-page', body, { delayMs: 0 });

    expect(mockFetchSource).toHaveBeenCalledWith({
      url: 'https://example.com/test',
      extractMode: 'full',
    });
  });
});
