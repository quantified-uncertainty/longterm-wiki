/**
 * Tests for block-section-quality validation rule
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockIndex, PageBlockIR, SectionIR } from '../content/block-ir.ts';
import { ValidationEngine, Severity } from '../validation/validation-engine.ts';

// ---------------------------------------------------------------------------
// Mock loadBlockIndex
// ---------------------------------------------------------------------------

const mockIndex: BlockIndex = {};

vi.mock('../content-types.ts', () => ({
  loadBlockIndex: () => mockIndex,
}));

// Import after mocking
const { blockSectionQualityRule, _resetCache } = await import('./block-section-quality.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSection(overrides: Partial<SectionIR> = {}): SectionIR {
  return {
    heading: 'Test Section',
    headingId: 'test-section',
    level: 2,
    startLine: 10,
    endLine: 30,
    entityLinks: [],
    facts: [],
    footnoteRefs: [],
    internalLinks: [],
    externalLinks: [],
    tables: [],
    wordCount: 100,
    componentNames: [],
    ...overrides,
  };
}

function seedIndex(pages: PageBlockIR[]): void {
  for (const key of Object.keys(mockIndex)) {
    delete mockIndex[key];
  }
  for (const p of pages) {
    mockIndex[p.pageId] = p;
  }
}

function makeContentFile(
  slug: string,
  opts: { pageType?: string; isIndex?: boolean } = {},
) {
  return {
    path: `/content/docs/knowledge-base/${slug}.mdx`,
    relativePath: `knowledge-base/${slug}.mdx`,
    slug: `knowledge-base/${slug}`,
    frontmatter: { pageType: opts.pageType } as any,
    body: '',
    isIndex: opts.isIndex ?? false,
  } as any;
}

const engine = {} as ValidationEngine;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('blockSectionQualityRule', () => {
  beforeEach(() => {
    _resetCache();
    seedIndex([]);
  });

  // -----------------------------------------------------------------------
  // Uncited long sections
  // -----------------------------------------------------------------------

  describe('uncited long sections', () => {
    it('flags sections with ≥200 words and no citations', () => {
      seedIndex([{
        pageId: 'anthropic',
        sections: [
          makeSection({ heading: '__preamble__', level: 0, wordCount: 50 }),
          makeSection({ heading: 'Overview', wordCount: 250, footnoteRefs: [] }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('anthropic')],
        engine,
      );

      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('Overview');
      expect(issues[0].message).toContain('250 words');
      expect(issues[0].message).toContain('no footnote citations');
      expect(issues[0].severity).toBe(Severity.WARNING);
    });

    it('does not flag sections with citations', () => {
      seedIndex([{
        pageId: 'anthropic',
        sections: [
          makeSection({ heading: 'History', wordCount: 300, footnoteRefs: ['1', '2'] }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('anthropic')],
        engine,
      );

      expect(issues).toHaveLength(0);
    });

    it('does not flag sections below the word threshold', () => {
      seedIndex([{
        pageId: 'anthropic',
        sections: [
          makeSection({ heading: 'Brief', wordCount: 150, footnoteRefs: [] }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('anthropic')],
        engine,
      );

      expect(issues).toHaveLength(0);
    });

    it('skips preamble sections', () => {
      seedIndex([{
        pageId: 'anthropic',
        sections: [
          makeSection({ heading: '__preamble__', level: 0, wordCount: 500, footnoteRefs: [] }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('anthropic')],
        engine,
      );

      expect(issues).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Empty sections
  // -----------------------------------------------------------------------

  describe('empty sections', () => {
    it('flags sections with ≤10 words', () => {
      seedIndex([{
        pageId: 'test-page',
        sections: [
          makeSection({ heading: 'Empty Heading', wordCount: 5, startLine: 20 }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('test-page')],
        engine,
      );

      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('Empty Heading');
      expect(issues[0].message).toContain('5 words');
      expect(issues[0].line).toBe(20);
    });

    it('does not flag sections with enough content', () => {
      seedIndex([{
        pageId: 'test-page',
        sections: [
          makeSection({ heading: 'Good Section', wordCount: 50 }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('test-page')],
        engine,
      );

      expect(issues).toHaveLength(0);
    });

    it('flags 0-word sections', () => {
      seedIndex([{
        pageId: 'test-page',
        sections: [
          makeSection({ heading: 'Placeholder', wordCount: 0 }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('test-page')],
        engine,
      );

      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('0 words');
    });
  });

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------

  describe('page filtering', () => {
    it('skips non-knowledge-base pages', () => {
      seedIndex([{
        pageId: 'internal-page',
        sections: [
          makeSection({ heading: 'Uncited', wordCount: 500, footnoteRefs: [] }),
        ],
        components: {},
      }]);

      const cf = {
        path: '/content/docs/internal/page.mdx',
        relativePath: 'internal/page.mdx',
        slug: 'internal/page',
        frontmatter: {} as any,
        body: '',
        isIndex: false,
      } as any;

      const issues = blockSectionQualityRule.check([cf], engine);
      expect(issues).toHaveLength(0);
    });

    it('skips index pages', () => {
      seedIndex([{
        pageId: 'organizations',
        sections: [
          makeSection({ heading: 'All Orgs', wordCount: 500, footnoteRefs: [] }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('organizations', { isIndex: true })],
        engine,
      );

      expect(issues).toHaveLength(0);
    });

    it('skips stub pages', () => {
      seedIndex([{
        pageId: 'stub-page',
        sections: [
          makeSection({ heading: 'Placeholder', wordCount: 500, footnoteRefs: [] }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('stub-page', { pageType: 'stub' })],
        engine,
      );

      expect(issues).toHaveLength(0);
    });

    it('handles pages not in block index gracefully', () => {
      seedIndex([]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('missing-page')],
        engine,
      );

      expect(issues).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Combined checks
  // -----------------------------------------------------------------------

  describe('combined checks', () => {
    it('can flag both uncited and empty on the same page', () => {
      seedIndex([{
        pageId: 'messy-page',
        sections: [
          makeSection({ heading: '__preamble__', level: 0, wordCount: 30 }),
          makeSection({ heading: 'Big Uncited', wordCount: 300, footnoteRefs: [] }),
          makeSection({ heading: 'Empty', wordCount: 3 }),
          makeSection({ heading: 'Good', wordCount: 100, footnoteRefs: ['1'] }),
        ],
        components: {},
      }]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('messy-page')],
        engine,
      );

      expect(issues).toHaveLength(2);
      const messages = issues.map(i => i.message);
      expect(messages.some(m => m.includes('Big Uncited'))).toBe(true);
      expect(messages.some(m => m.includes('Empty'))).toBe(true);
    });

    it('handles multiple pages', () => {
      seedIndex([
        {
          pageId: 'page-a',
          sections: [makeSection({ heading: 'Long', wordCount: 400, footnoteRefs: [] })],
          components: {},
        },
        {
          pageId: 'page-b',
          sections: [makeSection({ heading: 'Short', wordCount: 2 })],
          components: {},
        },
      ]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('page-a'), makeContentFile('page-b')],
        engine,
      );

      expect(issues).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Empty block index
  // -----------------------------------------------------------------------

  describe('empty block index', () => {
    it('returns no issues when block index is empty', () => {
      seedIndex([]);

      const issues = blockSectionQualityRule.check(
        [makeContentFile('anthropic')],
        engine,
      );

      expect(issues).toHaveLength(0);
    });
  });
});
