/**
 * Tests for source linking in claims extraction pipelines.
 *
 * Validates that:
 * - Page extraction prompt requests sourceQuote from wiki text
 * - Resource extraction prompt requires sourceQuote from resource text
 * - LLM responses with sourceQuote are properly parsed and stored
 * - buildInsertItem preserves sourceQuote through to DB insertion
 *
 * Addresses issue #1084: all claims had sourceQuote: null and confidence: unverified.
 */

import { describe, it, expect } from 'vitest';
import {
  EXTRACT_SYSTEM_PROMPT,
  cleanMdxForExtraction,
  splitIntoSections,
} from './extract.ts';
import {
  buildExtractionPrompt,
  buildInsertItem,
  type ExtractedResourceClaim,
} from './ingest-resource.ts';

// ---------------------------------------------------------------------------
// Page extraction prompt tests
// ---------------------------------------------------------------------------

describe('page extraction prompt (EXTRACT_SYSTEM_PROMPT)', () => {
  it('requests sourceQuote from the wiki text', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('sourceQuote');
    expect(EXTRACT_SYSTEM_PROMPT).toContain('verbatim excerpt');
  });

  it('includes sourceQuote in the example JSON response', () => {
    // The example JSON at the end should show sourceQuote
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"sourceQuote"');
  });

  it('specifies max 200 char limit for sourceQuote', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain('max 200 chars');
  });
});

// ---------------------------------------------------------------------------
// Resource extraction prompt tests
// ---------------------------------------------------------------------------

describe('resource extraction prompt (buildExtractionPrompt)', () => {
  const resource = {
    id: 'test-resource-id',
    title: 'Test Resource',
    url: 'https://example.com/article',
    authors: ['Jane Doe'],
    type: 'article' as const,
  };

  it('requires sourceQuote (not just optional)', () => {
    const prompt = buildExtractionPrompt(resource, 'kalshi');
    expect(prompt).toContain('REQUIRED');
    expect(prompt).toContain('sourceQuote');
  });

  it('emphasizes sourceQuote in the rules section', () => {
    const prompt = buildExtractionPrompt(resource, 'kalshi');
    expect(prompt).toContain('ALWAYS include sourceQuote');
  });

  it('includes sourceQuote in the example JSON', () => {
    const prompt = buildExtractionPrompt(resource, 'kalshi');
    expect(prompt).toContain('"sourceQuote": "...');
  });
});

// ---------------------------------------------------------------------------
// buildInsertItem — sourceQuote propagation
// ---------------------------------------------------------------------------

describe('buildInsertItem sourceQuote propagation', () => {
  const baseResource = {
    id: 'resource-123',
    title: 'Example',
    url: 'https://example.com',
    type: 'article' as const,
  };

  const baseClaim: ExtractedResourceClaim = {
    claimText: 'Kalshi was founded in 2018.',
    claimType: 'factual',
    relevance: 'direct',
    claimMode: 'endorsed',
    relatedEntities: [],
  };

  it('stores sourceQuote when present in extracted claim', () => {
    const claim: ExtractedResourceClaim = {
      ...baseClaim,
      sourceQuote: 'Kalshi, founded in 2018, is an event-based trading platform.',
    };

    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.sourceQuote).toBe('Kalshi, founded in 2018, is an event-based trading platform.');
  });

  it('stores null when sourceQuote is undefined', () => {
    const item = buildInsertItem(baseClaim, 'kalshi', baseResource);
    expect(item.sourceQuote).toBeNull();
  });

  it('creates claim_sources with sourceQuote when available', () => {
    const claim: ExtractedResourceClaim = {
      ...baseClaim,
      sourceQuote: 'The company raised $30M in Series B.',
    };

    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.sources).toBeDefined();
    expect(item.sources!.length).toBe(1);
    expect(item.sources![0].sourceQuote).toBe('The company raised $30M in Series B.');
    expect(item.sources![0].isPrimary).toBe(true);
    expect(item.sources![0].resourceId).toBe('resource-123');
  });

  it('creates claim_sources without sourceQuote when not available', () => {
    const item = buildInsertItem(baseClaim, 'kalshi', baseResource);
    expect(item.sources).toBeDefined();
    expect(item.sources!.length).toBe(1);
    expect(item.sources![0].sourceQuote).toBeUndefined();
    expect(item.sources![0].isPrimary).toBe(true);
  });

  it('always sets confidence to unverified on initial extraction', () => {
    const claim: ExtractedResourceClaim = {
      ...baseClaim,
      sourceQuote: 'Some quote.',
    };
    const item = buildInsertItem(claim, 'kalshi', baseResource);
    expect(item.confidence).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// cleanMdxForExtraction
// ---------------------------------------------------------------------------

describe('cleanMdxForExtraction', () => {
  it('converts <R> tags to footnote markers', () => {
    const input = 'See <R id="abc123">Source Title</R> for details.';
    const result = cleanMdxForExtraction(input);
    expect(result).toContain('[^R:abc123]');
    expect(result).not.toContain('<R');
  });

  it('removes JSX self-closing tags', () => {
    const input = 'The company <EntityLink id="kalshi" /> was founded in 2018.';
    const result = cleanMdxForExtraction(input);
    expect(result).not.toContain('<EntityLink');
  });

  it('removes import/export statements', () => {
    const input = 'import { Component } from "react";\nexport default Page;\nSome text.';
    const result = cleanMdxForExtraction(input);
    expect(result).not.toContain('import');
    expect(result).not.toContain('export');
    expect(result).toContain('Some text.');
  });
});

// ---------------------------------------------------------------------------
// splitIntoSections
// ---------------------------------------------------------------------------

describe('splitIntoSections', () => {
  it('splits by H2 headings', () => {
    const body = `Some intro text that is long enough to be kept as a section here we go with fifty chars.

## History

Kalshi was founded in 2018. It has grown significantly since its early days as a platform.

## Products

Kalshi offers event-based contracts. Users can trade on the outcome of real-world events.`;

    const sections = splitIntoSections(body);
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe('Introduction');
    expect(sections[1].heading).toBe('History');
    expect(sections[2].heading).toBe('Products');
  });

  it('skips sections with less than 50 chars of content', () => {
    const body = `## Good Section

This section has enough content to be included in the extraction process and analyzed.

## Short

Too short.`;

    const sections = splitIntoSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Good Section');
  });
});
