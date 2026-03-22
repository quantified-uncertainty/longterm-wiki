/**
 * Tests for resource reference validation (pre-write guard).
 *
 * Tests cover:
 * - Extraction of <R> tags from MDX content
 * - Validation against known resource IDs
 * - Auto-fixing broken refs (strip or convert to links)
 * - Title quality checking
 * - Edge cases (code blocks, inline code, self-closing tags)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock resource-io BEFORE importing the module under test
vi.mock('../../resource-io.ts', () => ({
  loadResourceIdsPGFirst: vi.fn(async () =>
    new Set(['valid-id-1', 'valid-id-2', 'aB1cD2eF3g']),
  ),
  loadResources: vi.fn(() => [
    { id: 'valid-id-1', url: 'https://example.com/1', title: 'Resource 1' },
    { id: 'valid-id-2', url: 'https://example.com/2', title: 'Resource 2', stable_id: 'aB1cD2eF3g' },
  ]),
}));

import {
  extractResourceRefs,
  validateResourceRefs,
  validateResourceTitles,
  loadKnownResourceIdsSync,
  validatePipelineResources,
} from './validate-resource-refs.ts';

// ---------------------------------------------------------------------------
// extractResourceRefs
// ---------------------------------------------------------------------------

describe('extractResourceRefs', () => {
  it('extracts a single <R> tag with children', () => {
    const content = 'See <R id="abc123">this resource</R> for more.';
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe('abc123');
    expect(refs[0].displayText).toBe('this resource');
    expect(refs[0].line).toBe(1);
  });

  it('extracts multiple <R> tags', () => {
    const content = [
      'First <R id="id-1">Resource A</R>',
      'Second <R id="id-2">Resource B</R>',
      'Third <R id="id-3">Resource C</R>',
    ].join('\n');
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(3);
    expect(refs[0].id).toBe('id-1');
    expect(refs[1].id).toBe('id-2');
    expect(refs[2].id).toBe('id-3');
  });

  it('extracts self-closing <R> tags', () => {
    const content = 'See <R id="abc123" /> for more.';
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe('abc123');
    expect(refs[0].displayText).toBe('');
  });

  it('reports correct line numbers', () => {
    const content = [
      'Line 1',
      'Line 2',
      '<R id="abc">text</R>',
      'Line 4',
    ].join('\n');
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].line).toBe(3);
  });

  it('skips <R> tags inside fenced code blocks', () => {
    const content = '```\n<R id="abc">text</R>\n```';
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(0);
  });

  it('skips <R> tags inside inline code spans', () => {
    const content = 'Use `<R id="abc">text</R>` in your page.';
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(0);
  });

  it('handles <R> tags with additional attributes', () => {
    const content = '<R id="abc" showType={true}>text</R>';
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe('abc');
  });

  it('handles single-quoted IDs', () => {
    const content = "<R id='abc'>text</R>";
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe('abc');
  });

  it('returns empty array for content with no <R> tags', () => {
    const content = 'Just some plain text with no resource refs.';
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(0);
  });

  it('handles <R> tags on the same line', () => {
    const content = '<R id="a">A</R> and <R id="b">B</R>';
    const refs = extractResourceRefs(content);
    expect(refs).toHaveLength(2);
    expect(refs[0].id).toBe('a');
    expect(refs[1].id).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// validateResourceRefs
// ---------------------------------------------------------------------------

describe('validateResourceRefs', () => {
  const knownIds = new Set(['valid-id-1', 'valid-id-2', 'valid-id-3']);

  it('passes content with all valid refs unchanged', () => {
    const content = 'See <R id="valid-id-1">Resource A</R> and <R id="valid-id-2">Resource B</R>.';
    const result = validateResourceRefs(content, knownIds);
    expect(result.totalRefs).toBe(2);
    expect(result.validRefs).toBe(2);
    expect(result.brokenRefs).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.fixedContent).toBe(content);
  });

  it('strips broken refs with no URL context', () => {
    const content = 'See <R id="broken-id">Missing Resource</R> for details.';
    const result = validateResourceRefs(content, knownIds);
    expect(result.brokenRefs).toBe(1);
    expect(result.broken[0].fix).toBe('stripped');
    expect(result.fixedContent).toBe('See Missing Resource for details.');
    expect(result.changed).toBe(true);
  });

  it('converts broken refs to markdown links when URL is on same line', () => {
    const content = 'See <R id="broken-id">Missing Resource</R> at https://example.com/article';
    const result = validateResourceRefs(content, knownIds);
    expect(result.brokenRefs).toBe(1);
    expect(result.broken[0].fix).toBe('converted-to-link');
    expect(result.broken[0].url).toBe('https://example.com/article');
    expect(result.fixedContent).toContain('[Missing Resource](https://example.com/article)');
  });

  it('uses the resource ID as display text when children are empty (self-closing)', () => {
    const content = 'See <R id="broken-id" /> for details.';
    const result = validateResourceRefs(content, knownIds);
    expect(result.brokenRefs).toBe(1);
    expect(result.broken[0].replacement).toBe('broken-id');
  });

  it('handles a mix of valid and broken refs', () => {
    const content = [
      '<R id="valid-id-1">Valid</R>',
      '<R id="broken-id">Broken</R>',
      '<R id="valid-id-2">Also Valid</R>',
    ].join('\n');
    const result = validateResourceRefs(content, knownIds);
    expect(result.totalRefs).toBe(3);
    expect(result.validRefs).toBe(2);
    expect(result.brokenRefs).toBe(1);
  });

  it('handles content with no <R> tags', () => {
    const content = 'Plain text with no resource refs.';
    const result = validateResourceRefs(content, knownIds);
    expect(result.totalRefs).toBe(0);
    expect(result.validRefs).toBe(0);
    expect(result.brokenRefs).toBe(0);
    expect(result.changed).toBe(false);
  });

  it('handles multiple broken refs', () => {
    const content = [
      '<R id="bad-1">Bad 1</R>',
      '<R id="bad-2">Bad 2</R>',
      '<R id="bad-3">Bad 3</R>',
    ].join('\n');
    const result = validateResourceRefs(content, knownIds);
    expect(result.brokenRefs).toBe(3);
    expect(result.fixedContent).toBe('Bad 1\nBad 2\nBad 3');
  });

  it('preserves surrounding content when fixing refs', () => {
    const content = 'Before <R id="broken">text</R> after.';
    const result = validateResourceRefs(content, knownIds);
    expect(result.fixedContent).toBe('Before text after.');
  });
});

// ---------------------------------------------------------------------------
// validateResourceTitles
// ---------------------------------------------------------------------------

describe('validateResourceTitles', () => {
  it('passes valid titles', () => {
    const titles = [
      { id: '1', title: 'Artificial Intelligence Safety Research' },
      { id: '2', title: 'A Study of Alignment Techniques' },
    ];
    const result = validateResourceTitles(titles);
    expect(result.checked).toBe(2);
    expect(result.issues).toHaveLength(0);
  });

  it('flags empty titles', () => {
    const result = validateResourceTitles([{ id: '1', title: '' }]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain('empty');
  });

  it('flags domain-only titles', () => {
    const cases = [
      'arxiv.org',
      'www.nature.com',
      'github.com',
      'https://example.com/',
    ];
    for (const title of cases) {
      const result = validateResourceTitles([{ id: '1', title }]);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('domain name');
    }
  });

  it('flags error/placeholder titles', () => {
    const badTitles = ['Untitled', '404 Not Found', 'Error', 'Page Not Found', 'Access Denied'];
    for (const title of badTitles) {
      const result = validateResourceTitles([{ id: '1', title }]);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('flags very short titles', () => {
    const result = validateResourceTitles([{ id: '1', title: 'AI' }]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain('too short');
  });

  it('flags very long titles', () => {
    const longTitle = 'A'.repeat(301);
    const result = validateResourceTitles([{ id: '1', title: longTitle }]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain('too long');
  });

  it('flags Cloudflare challenge page titles', () => {
    const result = validateResourceTitles([
      { id: '1', title: 'Just a moment...' },
      { id: '2', title: 'Attention Required! | Cloudflare' },
    ]);
    expect(result.issues).toHaveLength(2);
  });

  it('does not flag legitimate titles containing flagged words', () => {
    const result = validateResourceTitles([
      { id: '1', title: 'Understanding 404 Error Handling in Web Development' },
    ]);
    // "Understanding 404 Error Handling..." starts with "Understanding", not "404"
    expect(result.issues).toHaveLength(0);
  });

  it('handles null and undefined titles', () => {
    const result = validateResourceTitles([{ id: '1', title: 'null' }]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toContain('null');
  });
});

// ---------------------------------------------------------------------------
// loadKnownResourceIdsSync
// ---------------------------------------------------------------------------

describe('loadKnownResourceIdsSync', () => {
  it('returns a set of resource IDs from snapshot', () => {
    const ids = loadKnownResourceIdsSync();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has('valid-id-1')).toBe(true);
    expect(ids.has('valid-id-2')).toBe(true);
  });

  it('includes stable_ids in the set', () => {
    const ids = loadKnownResourceIdsSync();
    expect(ids.has('aB1cD2eF3g')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineResources (integration)
// ---------------------------------------------------------------------------

describe('validatePipelineResources', () => {
  it('validates refs against known IDs and returns fixed content', async () => {
    const content = [
      '---',
      'title: Test',
      '---',
      '',
      'See <R id="valid-id-1">Good Ref</R> for details.',
      'Also <R id="nonexistent">Bad Ref</R> here.',
    ].join('\n');

    const logMessages: Array<{ phase: string; msg: string }> = [];
    const result = await validatePipelineResources(content, {
      log: (phase, msg) => logMessages.push({ phase, msg }),
    });

    expect(result.resourceIdsAvailable).toBe(true);
    expect(result.refs.totalRefs).toBe(2);
    expect(result.refs.validRefs).toBe(1);
    expect(result.refs.brokenRefs).toBe(1);
    expect(result.refs.fixedContent).toContain('Good Ref');
    expect(result.refs.fixedContent).not.toContain('<R id="nonexistent">');
    expect(logMessages.length).toBeGreaterThan(0);
  });

  it('validates resource titles when provided', async () => {
    const content = 'Some content with no refs.';
    const result = await validatePipelineResources(content, {
      newResourceTitles: [
        { id: '1', title: 'Good Title' },
        { id: '2', title: 'Untitled' },
      ],
    });

    expect(result.titles).toBeDefined();
    expect(result.titles!.checked).toBe(2);
    expect(result.titles!.issues).toHaveLength(1);
  });

  it('handles content with all valid refs', async () => {
    const content = '<R id="valid-id-1">Valid</R>';
    const logMessages: Array<{ phase: string; msg: string }> = [];
    const result = await validatePipelineResources(content, {
      log: (phase, msg) => logMessages.push({ phase, msg }),
    });

    expect(result.refs.brokenRefs).toBe(0);
    expect(result.refs.changed).toBe(false);
    // Should log a success message
    expect(logMessages.some(m => m.msg.includes('all OK'))).toBe(true);
  });
});
