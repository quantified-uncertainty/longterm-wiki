/**
 * Tests for section-splitter.ts
 *
 * Covers:
 *  - headingToId: slug generation from heading text
 *  - splitIntoSections: frontmatter extraction, preamble, H2 sectioning
 *  - reassembleSections: round-trip consistency
 *  - renumberFootnotes: numeric and alphanumeric markers, ordering, edge cases
 *  - filterSourcesForSection: relevance ranking by heading keywords
 */

import { describe, it, expect } from 'vitest';
import {
  headingToId,
  splitIntoSections,
  reassembleSections,
  renumberFootnotes,
  filterSourcesForSection,
  type ParsedSection,
  type SplitPage,
} from './section-splitter.ts';
import type { SourceCacheEntry } from './section-writer.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRONTMATTER = `---
title: Test Page
quality: 70
---
`;

const SIMPLE_PAGE = `${FRONTMATTER}
Intro paragraph before any heading.

## Background

Some background text here. It talks about history.

## Funding

The organization raised money from donors.

## Future Plans

Plans for the future.
`;

// ---------------------------------------------------------------------------
// headingToId
// ---------------------------------------------------------------------------

describe('headingToId', () => {
  it('strips ## prefix', () => {
    expect(headingToId('## Background')).toBe('background');
  });

  it('converts to lowercase and replaces spaces with dashes', () => {
    expect(headingToId('## Key Challenges')).toBe('key-challenges');
  });

  it('handles special characters', () => {
    expect(headingToId('## Funding (2023–2025)')).toBe('funding-2023-2025');
  });

  it('trims leading and trailing dashes', () => {
    expect(headingToId('## ---Test---')).toBe('test');
  });

  it('handles ### prefix', () => {
    expect(headingToId('### Nested Heading')).toBe('nested-heading');
  });
});

// ---------------------------------------------------------------------------
// splitIntoSections
// ---------------------------------------------------------------------------

describe('splitIntoSections', () => {
  it('extracts frontmatter', () => {
    const result = splitIntoSections(SIMPLE_PAGE);
    expect(result.frontmatter).toMatch(/^---\n/);
    expect(result.frontmatter).toContain('title: Test Page');
  });

  it('captures preamble before first ## heading', () => {
    const result = splitIntoSections(SIMPLE_PAGE);
    expect(result.preamble).toContain('Intro paragraph');
  });

  it('creates one section per ## heading', () => {
    const result = splitIntoSections(SIMPLE_PAGE);
    expect(result.sections).toHaveLength(3);
  });

  it('assigns correct ids to sections', () => {
    const result = splitIntoSections(SIMPLE_PAGE);
    expect(result.sections[0].id).toBe('background');
    expect(result.sections[1].id).toBe('funding');
    expect(result.sections[2].id).toBe('future-plans');
  });

  it('section content includes the heading line', () => {
    const result = splitIntoSections(SIMPLE_PAGE);
    expect(result.sections[0].content).toMatch(/^## Background/);
  });

  it('section content includes body lines', () => {
    const result = splitIntoSections(SIMPLE_PAGE);
    expect(result.sections[0].content).toContain('Some background text');
  });

  it('H3 headings stay within parent section', () => {
    const page = `${FRONTMATTER}
## Main Section

### Sub-section A

Content A.

### Sub-section B

Content B.

## Next Section

Different content.
`;
    const result = splitIntoSections(page);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].content).toContain('### Sub-section A');
    expect(result.sections[0].content).toContain('### Sub-section B');
  });

  it('handles content with no ## headings', () => {
    const noSections = `${FRONTMATTER}Just a paragraph.\n`;
    const result = splitIntoSections(noSections);
    expect(result.sections).toHaveLength(0);
    expect(result.preamble).toContain('Just a paragraph');
  });

  it('handles content with no frontmatter', () => {
    const noFm = '## Only Section\n\nBody text.\n';
    const result = splitIntoSections(noFm);
    expect(result.frontmatter).toBe('');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].id).toBe('only-section');
  });

  it('does not split on ## headings inside code fences', () => {
    const page = `${FRONTMATTER}
## Real Section

Normal prose here.

\`\`\`markdown
## This is inside a code fence
It should not create a new section.
\`\`\`

More prose after the fence.
`;
    const result = splitIntoSections(page);
    // Only one real section; the fenced heading is within it
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].id).toBe('real-section');
    expect(result.sections[0].content).toContain('## This is inside a code fence');
  });

  it('handles nested fences correctly (second ``` closes first)', () => {
    const page = `${FRONTMATTER}
## First Section

\`\`\`
code block
\`\`\`

After fence.

## Second Section

More content.
`;
    const result = splitIntoSections(page);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].id).toBe('first-section');
    expect(result.sections[1].id).toBe('second-section');
  });
});

// ---------------------------------------------------------------------------
// reassembleSections
// ---------------------------------------------------------------------------

describe('reassembleSections', () => {
  it('round-trips a page through split→reassemble', () => {
    const split = splitIntoSections(SIMPLE_PAGE);
    const result = reassembleSections(split);

    // Core content preserved
    expect(result).toContain('title: Test Page');
    expect(result).toContain('## Background');
    expect(result).toContain('Some background text');
    expect(result).toContain('## Funding');
    expect(result).toContain('## Future Plans');
  });

  it('result ends with a single newline', () => {
    const split = splitIntoSections(SIMPLE_PAGE);
    const result = reassembleSections(split);
    expect(result.endsWith('\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(false);
  });

  it('no triple+ newlines in output', () => {
    const split = splitIntoSections(SIMPLE_PAGE);
    const result = reassembleSections(split);
    expect(result).not.toMatch(/\n{3,}/);
  });

  it('works on a split with no sections', () => {
    const split: SplitPage = {
      frontmatter: FRONTMATTER.trimEnd(),
      preamble: 'Just a preamble.',
      sections: [],
    };
    const result = reassembleSections(split);
    expect(result).toContain('Just a preamble');
    expect(result).toContain('title: Test Page');
  });
});

// ---------------------------------------------------------------------------
// renumberFootnotes
// ---------------------------------------------------------------------------

describe('renumberFootnotes', () => {
  it('returns content unchanged if no footnotes', () => {
    const content = '## Section\n\nNo footnotes here.\n';
    expect(renumberFootnotes(content)).toBe(content);
  });

  it('renumbers numeric footnotes in order', () => {
    const content = [
      '## Section',
      '',
      'Claim A.[^3] Claim B.[^1] Claim C.[^3]',
      '',
      '[^3]: Source Three (https://example.com/3)',
      '[^1]: Source One (https://example.com/1)',
    ].join('\n');

    const result = renumberFootnotes(content);
    // [^3] appears first → becomes [^1]; [^1] appears second → becomes [^2]
    expect(result).toContain('[^1]');
    expect(result).toContain('[^2]');
    expect(result).not.toContain('[^3]');
    // Definitions renumbered consistently
    expect(result).toContain('[^1]: Source Three');
    expect(result).toContain('[^2]: Source One');
  });

  it('converts SRC-N style markers to numeric', () => {
    const content = [
      '## Background',
      '',
      'MIRI was founded in 2000.[^SRC-1]',
      '',
      '[^SRC-1]: MIRI History (https://miri.org)',
    ].join('\n');

    const result = renumberFootnotes(content);
    expect(result).toContain('[^1]');
    expect(result).not.toContain('[^SRC-1]');
    expect(result).toContain('[^1]: MIRI History');
  });

  it('handles multiple sections with reused SRC markers', () => {
    // Two sections, each using [^SRC-1] for different sources
    const content = [
      '## Background',
      '',
      'Founded in 2000.[^SRC-1]',
      '',
      '[^SRC-1]: History (https://example.com/history)',
      '',
      '## Funding',
      '',
      'Raised $5M.[^SRC-1]',
      '',
      '[^SRC-1]: Funding Report (https://example.com/funding)',
    ].join('\n');

    const result = renumberFootnotes(content);
    // First appearance of SRC-1 → [^1]; second appearance (already mapped) → [^1] again
    // But only ONE definition for [^1] is emitted (first-wins for duplicate markers)
    expect(result).toContain('[^1]');
    // Should not contain any SRC-style markers
    expect(result).not.toContain('[^SRC-');
  });

  it('handles mixed numeric and SRC-N markers', () => {
    const content = [
      '## Section',
      '',
      'Claim A.[^1] Claim B.[^SRC-1]',
      '',
      '[^1]: Existing Source (https://example.com/existing)',
      '[^SRC-1]: New Source (https://example.com/new)',
    ].join('\n');

    const result = renumberFootnotes(content);
    // [^1] appears first → stays [^1]; [^SRC-1] appears second → becomes [^2]
    expect(result).toContain('[^1]: Existing Source');
    expect(result).toContain('[^2]: New Source');
    expect(result).not.toContain('[^SRC-1]');
  });

  it('definitions block appears at end of document', () => {
    const content = [
      '## Section',
      '',
      'Claim.[^SRC-1]',
      '',
      '[^SRC-1]: A Source (https://example.com)',
    ].join('\n');

    const result = renumberFootnotes(content);
    const lines = result.trimEnd().split('\n');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toMatch(/^\[\^1\]:/);
  });

  it('same marker appearing multiple times only counts once in mapping', () => {
    const content = [
      '## Section',
      '',
      'Claim A.[^SRC-1] And again.[^SRC-1]',
      '',
      '[^SRC-1]: Single Source (https://example.com)',
    ].join('\n');

    const result = renumberFootnotes(content);
    // Both original SRC-style markers are gone
    expect(result).not.toContain('[^SRC-1]');
    // Both inline refs are renumbered to [^1]
    // Note: /\[\^1\]/ also matches the definition [^1]:, so use a body-only check
    const bodyLine = 'Claim A.[^1] And again.[^1]';
    expect(result).toContain(bodyLine);
    // Exactly one definition
    const defMatches = [...result.matchAll(/^\[\^1\]:/gm)];
    expect(defMatches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// filterSourcesForSection
// ---------------------------------------------------------------------------

const makeSrc = (overrides: Partial<SourceCacheEntry>): SourceCacheEntry => ({
  id: 'SRC-1',
  url: 'https://example.com',
  title: 'Default Title',
  content: 'Default content.',
  ...overrides,
});

describe('filterSourcesForSection', () => {
  it('returns empty array for no sources', () => {
    const section: ParsedSection = { id: 'background', heading: '## Background', content: '## Background\n\nText.' };
    expect(filterSourcesForSection(section, [])).toEqual([]);
  });

  it('returns sources unchanged if no keyword overlap', () => {
    const section: ParsedSection = { id: 'xyz', heading: '## XYZ', content: '## XYZ\n\nText.' };
    const sources = [
      makeSrc({ id: 'SRC-1', title: 'Unrelated Alpha' }),
      makeSrc({ id: 'SRC-2', title: 'Unrelated Beta' }),
    ];
    const result = filterSourcesForSection(section, sources);
    expect(result).toHaveLength(2);
    // Order unchanged (no keyword match)
    expect(result[0].id).toBe('SRC-1');
  });

  it('ranks sources with heading keyword in title higher', () => {
    const section: ParsedSection = {
      id: 'funding',
      heading: '## Funding History',
      content: '## Funding History\n\nText.',
    };
    const sources = [
      makeSrc({ id: 'SRC-1', title: 'General Overview' }),
      makeSrc({ id: 'SRC-2', title: 'Funding Report 2023' }),
    ];
    const result = filterSourcesForSection(section, sources);
    expect(result[0].id).toBe('SRC-2'); // "funding" in title → higher score
  });

  it('ranks sources with keyword in facts', () => {
    const section: ParsedSection = {
      id: 'research',
      heading: '## Research Output',
      content: '## Research Output\n\nText.',
    };
    const sources = [
      makeSrc({ id: 'SRC-1', title: 'Other Topic', facts: ['No matching words'] }),
      makeSrc({ id: 'SRC-2', title: 'Other Topic', facts: ['Research methodology used'] }),
    ];
    const result = filterSourcesForSection(section, sources);
    expect(result[0].id).toBe('SRC-2'); // "research" in facts → higher score
  });

  it('ignores short words (<=3 chars) in heading', () => {
    const section: ParsedSection = {
      id: 'ai',
      heading: '## AI and ML',
      content: '## AI and ML\n\nText.',
    };
    const sources = [
      makeSrc({ id: 'SRC-1', title: 'Artificial Intelligence Research' }),
    ];
    // "AI", "and", "ML" all ≤ 3 chars → no keywords → original order
    const result = filterSourcesForSection(section, sources);
    expect(result).toHaveLength(1);
  });
});
