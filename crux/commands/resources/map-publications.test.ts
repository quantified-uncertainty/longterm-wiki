import { describe, it, expect } from 'vitest';
import { extractDomain, buildDomainIndex, matchPublication } from './map-publications.ts';

describe('extractDomain', () => {
  it('extracts hostname from a full URL', () => {
    expect(extractDomain('https://arxiv.org/abs/2301.00001')).toBe('arxiv.org');
  });

  it('strips www prefix', () => {
    expect(extractDomain('https://www.nature.com/articles/123')).toBe('nature.com');
  });

  it('lowercases the domain', () => {
    expect(extractDomain('https://WWW.OpenAI.COM/research')).toBe('openai.com');
  });

  it('returns null for invalid URLs', () => {
    expect(extractDomain('not-a-url')).toBeNull();
    expect(extractDomain('')).toBeNull();
  });

  it('handles URLs with ports', () => {
    expect(extractDomain('http://localhost:3000/api')).toBe('localhost');
  });
});

const makePub = (id: string, name: string, domains: string[]) => ({
  id,
  name,
  domains,
  type: 'journal',
  credibility: 5,
});

describe('buildDomainIndex', () => {
  it('indexes publications by domain', () => {
    const pubs = [makePub('p1', 'Nature', ['nature.com'])];
    const index = buildDomainIndex(pubs);
    expect(index.get('nature.com')?.id).toBe('p1');
  });

  it('strips www and lowercases domain entries', () => {
    const pubs = [makePub('p1', 'Nature', ['www.Nature.COM'])];
    const index = buildDomainIndex(pubs);
    expect(index.get('nature.com')?.id).toBe('p1');
  });

  it('indexes multiple domains per publication', () => {
    const pubs = [makePub('p1', 'Nature', ['nature.com', 'nature.org'])];
    const index = buildDomainIndex(pubs);
    expect(index.get('nature.com')?.id).toBe('p1');
    expect(index.get('nature.org')?.id).toBe('p1');
  });
});

describe('matchPublication', () => {
  const pubs = [
    makePub('p1', 'Nature', ['nature.com']),
    makePub('p2', 'arXiv', ['arxiv.org']),
    makePub('p3', 'UK Gov', ['gov.uk']),
  ];

  it('matches exact domain', () => {
    const index = buildDomainIndex(pubs);
    expect(matchPublication('nature.com', index)?.id).toBe('p1');
    expect(matchPublication('arxiv.org', index)?.id).toBe('p2');
  });

  it('matches subdomain via suffix', () => {
    const index = buildDomainIndex(pubs);
    expect(matchPublication('www.nature.com', index)?.id).toBe('p1');
    expect(matchPublication('legislation.gov.uk', index)?.id).toBe('p3');
  });

  it('returns undefined for unmatched domains', () => {
    const index = buildDomainIndex(pubs);
    expect(matchPublication('example.com', index)).toBeUndefined();
  });

  it('does not match partial domain names', () => {
    const index = buildDomainIndex(pubs);
    // "mynature.com" should NOT match "nature.com" — it doesn't end with ".nature.com"
    expect(matchPublication('mynature.com', index)).toBeUndefined();
  });

  it('is case-insensitive', () => {
    const index = buildDomainIndex(pubs);
    expect(matchPublication('NATURE.COM', index)?.id).toBe('p1');
    expect(matchPublication('ArXiv.Org', index)?.id).toBe('p2');
  });
});
