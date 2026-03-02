/**
 * Tests for `crux query blocks` command
 *
 * Tests option validation, per-page view, cross-page filters,
 * and default summary output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockIndex, PageBlockIR, SectionIR } from '../lib/content/block-ir.ts';

// ---------------------------------------------------------------------------
// Mock loadBlockIndex before importing the module under test
// ---------------------------------------------------------------------------

const mockIndex: BlockIndex = {};

vi.mock('../lib/content-types.ts', () => ({
  loadBlockIndex: () => mockIndex,
}));

// Import after mocking
const { blocks } = await import('./query.ts');

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

function makePage(pageId: string, sections: SectionIR[], components: Record<string, number> = {}): PageBlockIR {
  return { pageId, sections, components };
}

function seedIndex(pages: PageBlockIR[]): void {
  // Clear existing
  for (const key of Object.keys(mockIndex)) {
    delete mockIndex[key];
  }
  for (const p of pages) {
    mockIndex[p.pageId] = p;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('crux query blocks', () => {
  beforeEach(() => {
    seedIndex([]);
  });

  // -----------------------------------------------------------------------
  // Option validation
  // -----------------------------------------------------------------------

  describe('option validation', () => {
    it('rejects page-id combined with --entity', async () => {
      seedIndex([makePage('test', [makeSection()])]);
      const result = await blocks(['test'], { entity: 'anthropic' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('mutually exclusive');
    });

    it('rejects page-id combined with --component', async () => {
      seedIndex([makePage('test', [makeSection()])]);
      const result = await blocks(['test'], { component: 'squiggle' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('mutually exclusive');
    });

    it('rejects page-id combined with --uncited', async () => {
      seedIndex([makePage('test', [makeSection()])]);
      const result = await blocks(['test'], { uncited: true });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('mutually exclusive');
    });

    it('rejects --entity combined with --component', async () => {
      seedIndex([makePage('test', [makeSection()])]);
      const result = await blocks([], { entity: 'anthropic', component: 'squiggle' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('only one of');
    });

    it('rejects --entity combined with --uncited', async () => {
      seedIndex([makePage('test', [makeSection()])]);
      const result = await blocks([], { entity: 'anthropic', uncited: true });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('only one of');
    });

    it('rejects --component combined with --uncited', async () => {
      seedIndex([makePage('test', [makeSection()])]);
      const result = await blocks([], { component: 'squiggle', uncited: true });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('only one of');
    });
  });

  // -----------------------------------------------------------------------
  // Empty index
  // -----------------------------------------------------------------------

  describe('empty index', () => {
    it('returns error when block index is empty', async () => {
      const result = await blocks([], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('No block-index.json');
    });
  });

  // -----------------------------------------------------------------------
  // Per-page view
  // -----------------------------------------------------------------------

  describe('per-page view', () => {
    it('returns page not found for missing page', async () => {
      seedIndex([makePage('anthropic', [makeSection()])]);
      const result = await blocks(['nonexistent'], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Page not found');
    });

    it('renders section structure for a page', async () => {
      seedIndex([makePage('anthropic', [
        makeSection({ heading: '__preamble__', level: 0, wordCount: 50 }),
        makeSection({ heading: 'Overview', wordCount: 200, entityLinks: ['dario-amodei'] }),
        makeSection({ heading: 'History', wordCount: 300, footnoteRefs: ['1', '2'] }),
      ])]);

      const result = await blocks(['anthropic'], {});
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('anthropic');
      expect(result.output).toContain('Overview');
      expect(result.output).toContain('History');
      expect(result.output).toContain('dario-amodei');
    });

    it('returns JSON for --json flag', async () => {
      seedIndex([makePage('test-page', [makeSection()], { squiggle: 2 })]);
      const result = await blocks(['test-page'], { json: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.output);
      expect(parsed.pageId).toBe('test-page');
      expect(parsed.components.squiggle).toBe(2);
    });

    it('displays component summary', async () => {
      seedIndex([makePage('test-page', [
        makeSection({ componentNames: ['squiggle'] }),
      ], { squiggle: 1, mermaid: 2 })]);

      const result = await blocks(['test-page'], {});
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('squiggle');
      expect(result.output).toContain('mermaid');
    });
  });

  // -----------------------------------------------------------------------
  // Entity filter
  // -----------------------------------------------------------------------

  describe('--entity filter', () => {
    it('finds sections referencing an entity', async () => {
      seedIndex([
        makePage('page-a', [
          makeSection({ heading: 'Overview', entityLinks: ['anthropic', 'openai'] }),
          makeSection({ heading: 'History', entityLinks: ['openai'] }),
        ]),
        makePage('page-b', [
          makeSection({ heading: 'Analysis', entityLinks: ['anthropic'] }),
        ]),
      ]);

      const result = await blocks([], { entity: 'anthropic' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('2 section');
      expect(result.output).toContain('page-a');
      expect(result.output).toContain('page-b');
    });

    it('returns empty result for unknown entity', async () => {
      seedIndex([makePage('test', [makeSection({ entityLinks: ['openai'] })])]);
      const result = await blocks([], { entity: 'nonexistent' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('No sections reference');
    });

    it('returns JSON for --json flag', async () => {
      seedIndex([makePage('page-a', [
        makeSection({ heading: 'Overview', entityLinks: ['anthropic'] }),
      ])]);
      const result = await blocks([], { entity: 'anthropic', json: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].pageId).toBe('page-a');
    });
  });

  // -----------------------------------------------------------------------
  // Component filter
  // -----------------------------------------------------------------------

  describe('--component filter', () => {
    it('finds pages using a component', async () => {
      seedIndex([
        makePage('page-a', [makeSection()], { squiggle: 3 }),
        makePage('page-b', [makeSection()], { squiggle: 1 }),
        makePage('page-c', [makeSection()], { mermaid: 2 }),
      ]);

      const result = await blocks([], { component: 'squiggle' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('2 page');
      expect(result.output).toContain('page-a');
      expect(result.output).toContain('page-b');
    });

    it('is case-insensitive', async () => {
      seedIndex([makePage('test', [makeSection()], { squiggle: 1 })]);
      const result = await blocks([], { component: 'Squiggle' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('1 page');
    });

    it('suggests known components for unknown type', async () => {
      seedIndex([makePage('test', [makeSection()], { squiggle: 1, mermaid: 2 })]);
      const result = await blocks([], { component: 'nonexistent' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Known:');
      expect(result.output).toContain('squiggle');
    });

    it('sorts by count descending', async () => {
      seedIndex([
        makePage('page-a', [makeSection()], { squiggle: 1 }),
        makePage('page-b', [makeSection()], { squiggle: 5 }),
      ]);
      const result = await blocks([], { component: 'squiggle', json: true });
      const parsed = JSON.parse(result.output);
      expect(parsed[0].pageId).toBe('page-b');
      expect(parsed[0].count).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Uncited filter
  // -----------------------------------------------------------------------

  describe('--uncited filter', () => {
    it('finds sections with enough words but no citations', async () => {
      seedIndex([makePage('page-a', [
        makeSection({ heading: '__preamble__', level: 0, wordCount: 200, footnoteRefs: [] }),
        makeSection({ heading: 'Cited', wordCount: 200, footnoteRefs: ['1'] }),
        makeSection({ heading: 'Uncited', wordCount: 150, footnoteRefs: [] }),
        makeSection({ heading: 'Short', wordCount: 20, footnoteRefs: [] }),
      ])]);

      const result = await blocks([], { uncited: true });
      expect(result.exitCode).toBe(0);
      // Only "Uncited" should appear (preamble excluded by level>0, Cited has refs, Short is too short)
      expect(result.output).toContain('Uncited');
      expect(result.output).not.toContain('Cited');
      expect(result.output).not.toContain('Short');
      expect(result.output).not.toContain('preamble');
    });

    it('respects --min-words option', async () => {
      seedIndex([makePage('test', [
        makeSection({ heading: 'Medium', wordCount: 80, footnoteRefs: [] }),
        makeSection({ heading: 'Long', wordCount: 200, footnoteRefs: [] }),
      ])]);

      const result = await blocks([], { uncited: true, 'min-words': '100' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Long');
      expect(result.output).not.toContain('Medium');
    });

    it('reports no issues when all sections are cited', async () => {
      seedIndex([makePage('test', [
        makeSection({ heading: 'Section', wordCount: 200, footnoteRefs: ['1'] }),
      ])]);

      const result = await blocks([], { uncited: true });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('No uncited sections');
    });

    it('sorts by word count descending', async () => {
      seedIndex([makePage('test', [
        makeSection({ heading: 'Small', wordCount: 60, footnoteRefs: [] }),
        makeSection({ heading: 'Big', wordCount: 500, footnoteRefs: [] }),
      ])]);

      const result = await blocks([], { uncited: true, json: true });
      const parsed = JSON.parse(result.output);
      expect(parsed[0].section).toBe('Big');
      expect(parsed[0].wordCount).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // Default summary
  // -----------------------------------------------------------------------

  describe('default summary', () => {
    it('shows page and section counts', async () => {
      seedIndex([
        makePage('page-a', [makeSection(), makeSection()]),
        makePage('page-b', [makeSection()]),
      ]);

      const result = await blocks([], {});
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('2');  // 2 pages
      expect(result.output).toContain('3');  // 3 sections
    });

    it('returns JSON for --json flag', async () => {
      seedIndex([makePage('test', [makeSection()])]);
      const result = await blocks([], { json: true });
      const parsed = JSON.parse(result.output);
      expect(parsed.pages).toBe(1);
      expect(parsed.sections).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Limit option
  // -----------------------------------------------------------------------

  describe('--limit option', () => {
    it('limits entity filter results', async () => {
      const sections = Array.from({ length: 30 }, (_, i) =>
        makeSection({ heading: `Section ${i}`, entityLinks: ['anthropic'] }),
      );
      seedIndex([makePage('big-page', sections)]);

      const result = await blocks([], { entity: 'anthropic', limit: '5', json: true });
      const parsed = JSON.parse(result.output);
      expect(parsed).toHaveLength(5);
    });
  });
});
