import { describe, it, expect } from 'vitest';
import { getCheckStrategy } from './strategies.ts';

describe('getCheckStrategy', () => {
  // ── Unverifiable ────────────────────────────────────────────────────────────

  it('twitter.com → unverifiable', () => {
    expect(getCheckStrategy('https://twitter.com/foo/bar')).toBe('unverifiable');
  });

  it('x.com → unverifiable', () => {
    expect(getCheckStrategy('https://x.com/foo')).toBe('unverifiable');
  });

  it('linkedin.com → unverifiable', () => {
    expect(getCheckStrategy('https://www.linkedin.com/in/someone')).toBe('unverifiable');
  });

  it('facebook.com → unverifiable', () => {
    expect(getCheckStrategy('https://facebook.com/page')).toBe('unverifiable');
  });

  it('t.co short links → unverifiable', () => {
    expect(getCheckStrategy('https://t.co/abc123')).toBe('unverifiable');
  });

  // ── Skip ────────────────────────────────────────────────────────────────────

  it('jstor.org → skip', () => {
    expect(getCheckStrategy('https://www.jstor.org/stable/123')).toBe('skip');
  });

  it('dl.acm.org → skip', () => {
    expect(getCheckStrategy('https://dl.acm.org/doi/10.1145/123')).toBe('skip');
  });

  it('academic.oup.com → skip', () => {
    expect(getCheckStrategy('https://academic.oup.com/brain/article/123')).toBe('skip');
  });

  it('cambridge.org → skip', () => {
    expect(getCheckStrategy('https://www.cambridge.org/core/journals/123')).toBe('skip');
  });

  it('metaculus.com → skip', () => {
    expect(getCheckStrategy('https://www.metaculus.com/questions/123')).toBe('skip');
  });

  it('openphilanthropy.org → skip', () => {
    expect(getCheckStrategy('https://www.openphilanthropy.org/grants/123')).toBe('skip');
  });

  // ── DOI ─────────────────────────────────────────────────────────────────────

  it('nature.com → doi', () => {
    expect(getCheckStrategy('https://www.nature.com/articles/s41586-021-00003-z')).toBe('doi');
  });

  it('science.org → doi', () => {
    expect(getCheckStrategy('https://www.science.org/doi/10.1126/science.abc')).toBe('doi');
  });

  it('springer.com → doi', () => {
    expect(getCheckStrategy('https://link.springer.com/article/10.1007/123')).toBe('doi');
  });

  it('wiley.com → doi', () => {
    expect(getCheckStrategy('https://onlinelibrary.wiley.com/doi/10.1002/123')).toBe('doi');
  });

  it('pnas.org → doi', () => {
    expect(getCheckStrategy('https://www.pnas.org/doi/10.1073/pnas.123')).toBe('doi');
  });

  it('cell.com → doi', () => {
    expect(getCheckStrategy('https://www.cell.com/cell/fulltext/S0092-8674(21)00001-X')).toBe('doi');
  });

  // ── ArXiv ───────────────────────────────────────────────────────────────────

  it('arxiv.org abstract → arxiv', () => {
    expect(getCheckStrategy('https://arxiv.org/abs/2301.12345')).toBe('arxiv');
  });

  it('arxiv.org pdf → arxiv', () => {
    expect(getCheckStrategy('https://arxiv.org/pdf/2301.12345')).toBe('arxiv');
  });

  // ── Forum API ────────────────────────────────────────────────────────────────

  it('lesswrong.com post → forum-api', () => {
    expect(getCheckStrategy('https://www.lesswrong.com/posts/abc123/title')).toBe('forum-api');
  });

  it('alignmentforum.org post → forum-api', () => {
    expect(getCheckStrategy('https://www.alignmentforum.org/posts/def456/title')).toBe('forum-api');
  });

  it('forum.effectivealtruism.org post → forum-api', () => {
    expect(getCheckStrategy('https://forum.effectivealtruism.org/posts/xyz789/title')).toBe('forum-api');
  });

  // ── HTTP (fallthrough) ───────────────────────────────────────────────────────

  it('generic https → http', () => {
    expect(getCheckStrategy('https://example.com/page')).toBe('http');
  });

  it('github.com → http', () => {
    expect(getCheckStrategy('https://github.com/user/repo')).toBe('http');
  });

  it('wikipedia.org → http', () => {
    expect(getCheckStrategy('https://en.wikipedia.org/wiki/Foo')).toBe('http');
  });

  it('youtube.com → http (not unverifiable)', () => {
    expect(getCheckStrategy('https://www.youtube.com/watch?v=abc')).toBe('http');
  });

  // ── Subdomain matching ───────────────────────────────────────────────────────

  it('subdomain of nature.com → doi', () => {
    // link.springer.com is a subdomain of springer.com → doi
    expect(getCheckStrategy('https://link.springer.com/article')).toBe('doi');
  });

  it('subdomain of skip domain → skip', () => {
    // subdomain of cambridge.org should still be skip
    expect(getCheckStrategy('https://journals.cambridge.org/article')).toBe('skip');
  });

  // ── Invalid URLs ─────────────────────────────────────────────────────────────

  it('invalid URL falls through to http', () => {
    // getDomain returns 'unknown' for invalid URLs, which doesn't match any list
    expect(getCheckStrategy('not-a-url')).toBe('http');
  });
});
