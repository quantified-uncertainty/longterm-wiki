/**
 * Tests for escapeCell (internal) via formatPlaybookMarkdown.
 *
 * escapeCell must escape backslash FIRST (so an input `\` becomes `\\` and
 * cannot combine with the `\` we add for pipes), escape `|` as `\|` so a value
 * cannot break out of a markdown table cell, and flatten newlines to spaces so
 * a value cannot inject extra table rows.
 */

import { describe, it, expect } from 'vitest';
import { formatPlaybookMarkdown, type ResearchPlaybook } from './research-playbooks.ts';

function makePlaybook(sourceName: string): ResearchPlaybook {
  return {
    entityType: 'lab',
    description: 'desc',
    sources: [
      {
        name: sourceName,
        reliability: 'high',
        covers: ['funding'],
      },
    ],
    checklist: ['check one'],
    common_pitfalls: [],
    research_order: [],
  };
}

describe('formatPlaybookMarkdown / escapeCell', () => {
  it('escapes backslash before pipe and flattens newlines in table cells', () => {
    // Source name contains: a literal backslash, a pipe, and a newline.
    const md = formatPlaybookMarkdown(makePlaybook('a\\b|c\nd'));

    // Backslash escaped first: literal `\` -> `\\`, then `|` -> `\|`.
    // Expected rendered cell content: a\\b\|c d
    expect(md).toContain('| a\\\\b\\|c d |');

    // The pipe must be escaped — no raw, unescaped `|` from the value should
    // appear (which would split the cell and corrupt the table).
    expect(md).not.toContain('b|c');

    // Newline must become a space — no literal newline inside the value.
    expect(md).not.toContain('c\nd');
  });

  it('does not double-escape an added pipe escape via the input backslash', () => {
    // If pipe were escaped before backslash, the `\` we add would itself get
    // doubled. With correct ordering, a lone `|` becomes exactly `\|`.
    const md = formatPlaybookMarkdown(makePlaybook('x|y'));
    expect(md).toContain('| x\\|y |');
    expect(md).not.toContain('x\\\\|y');
  });
});
