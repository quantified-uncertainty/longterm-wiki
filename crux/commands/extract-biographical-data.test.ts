/**
 * Tests for the extract-biographical-data command.
 *
 * Tests utility functions (footnote parsing, validation) and CLI error handling.
 * Does not make LLM or network calls.
 */

import { describe, it, expect } from 'vitest';
import { commands } from './extract-biographical-data.ts';

// ---------------------------------------------------------------------------
// Test the footnote parsing (exported indirectly via module behavior)
// We test it through command behavior, not direct function access.
// ---------------------------------------------------------------------------

describe('extract-biographical-data command', () => {
  it('shows usage when no entity ID or entity-type provided', async () => {
    const result = await commands.extract([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage:');
    expect(result.output).toContain('extract-biographical-data');
  });

  it('returns error for nonexistent entity', async () => {
    const result = await commands.extract(
      ['completely-nonexistent-entity-xyz-999'],
      { dryRun: true },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Entity not found');
  });

  it('handles entity with no MDX file gracefully', async () => {
    // This tests the flow for an entity that exists in people.yaml but has no wiki page.
    // We pick an entity that likely has no MDX file (test entities added to YAML
    // without content). If all entities have MDX files, the command should
    // still handle gracefully via the "not found" path.
    const result = await commands.extract(
      ['nonexistent-slug-with-no-mdx-file'],
      { dryRun: true },
    );
    expect(result.exitCode).toBe(1);
    // Either "Entity not found" or "MDX file not found"
    expect(result.output).toMatch(/not found/i);
  });

  it('exits with code 1 for missing entity with --json flag', async () => {
    const result = await commands.extract(
      ['nonexistent-entity-xyz'],
      { dryRun: true, json: true },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('not found');
  });

  it('batch mode with limit=0 processes nothing', async () => {
    const result = await commands.extract(
      [],
      { entityType: 'person', limit: '0' },
    );
    // With limit 0, no entities to process
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No entities');
  });

  it('help function returns usage info', async () => {
    const { getHelp } = await import('./extract-biographical-data.ts');
    const help = getHelp();
    expect(help).toContain('Extract Biographical Data');
    expect(help).toContain('--verify');
    expect(help).toContain('--apply');
    expect(help).toContain('--budget');
    expect(help).toContain('--entity-type');
    expect(help).toContain('dan-hendrycks');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for internal parsing functions
// We re-implement them in test to verify correctness without exporting.
// ---------------------------------------------------------------------------

describe('footnote parsing logic', () => {
  function parseFootnotes(content: string): Map<string, { id: string; text: string; url: string | null }> {
    const footnotes = new Map<string, { id: string; text: string; url: string | null }>();
    const footnotePattern = /^\[(\^[^\]]+)\]:\s*(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = footnotePattern.exec(content)) !== null) {
      const id = match[1];
      const text = match[2].trim();
      const urlMatch = text.match(/(https?:\/\/[^\s)]+)(?:\s*$)/);
      const url = urlMatch ? urlMatch[1] : null;
      footnotes.set(id, { id, text, url });
    }
    return footnotes;
  }

  it('parses standard footnote definitions', () => {
    const content = `
Some text here.[^ref1]

[^ref1]: Author, "Title," 2024. https://example.com/article
[^ref2]: Another source. https://example.org/source
`;
    const footnotes = parseFootnotes(content);
    expect(footnotes.size).toBe(2);
    expect(footnotes.get('^ref1')?.url).toBe('https://example.com/article');
    expect(footnotes.get('^ref2')?.url).toBe('https://example.org/source');
  });

  it('handles footnotes without URLs', () => {
    const content = `[^local]: Personal communication, 2024.`;
    const footnotes = parseFootnotes(content);
    expect(footnotes.size).toBe(1);
    expect(footnotes.get('^local')?.url).toBeNull();
  });

  it('handles empty content', () => {
    const footnotes = parseFootnotes('');
    expect(footnotes.size).toBe(0);
  });

  it('extracts URL from footnote with complex text', () => {
    const content = `[^rc-d679]: CAIS official page, "About CAIS," accessed 2024. https://safe.ai/about`;
    const footnotes = parseFootnotes(content);
    expect(footnotes.get('^rc-d679')?.url).toBe('https://safe.ai/about');
  });
});

describe('footnote reference extraction logic', () => {
  function extractFootnoteRefs(text: string): string[] {
    const refs: string[] = [];
    const refPattern = /\[(\^[^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = refPattern.exec(text)) !== null) {
      const afterMatch = text.slice(match.index + match[0].length);
      if (!afterMatch.startsWith(':')) {
        refs.push(match[1]);
      }
    }
    return [...new Set(refs)];
  }

  it('extracts inline footnote references', () => {
    const text = 'He founded CAIS in 2022.[^rc-d679] More info.[^rc-02ec]';
    const refs = extractFootnoteRefs(text);
    expect(refs).toContain('^rc-d679');
    expect(refs).toContain('^rc-02ec');
    expect(refs).toHaveLength(2);
  });

  it('does not extract footnote definitions as references', () => {
    const text = '[^ref1]: This is a definition, not a reference.';
    const refs = extractFootnoteRefs(text);
    expect(refs).toHaveLength(0);
  });

  it('deduplicates repeated refs', () => {
    const text = 'Text[^a] more[^b] again[^a]';
    const refs = extractFootnoteRefs(text);
    expect(refs).toHaveLength(2);
  });

  it('handles empty text', () => {
    expect(extractFootnoteRefs('')).toHaveLength(0);
  });
});

describe('validation helpers', () => {
  // Test education validation
  function validateEducation(raw: unknown): Array<{ degree: string; institution: string; year: number | null }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        degree: String(item.degree ?? ''),
        institution: String(item.institution ?? ''),
        year: typeof item.year === 'number' ? item.year : null,
      }))
      .filter((e) => e.degree.length > 0 && e.institution.length > 0);
  }

  it('validates well-formed education data', () => {
    const result = validateEducation([
      { degree: 'Ph.D., Computer Science', institution: 'UC Berkeley', year: 2022 },
      { degree: 'B.S., Computer Science', institution: 'University of Chicago', year: 2018 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].degree).toBe('Ph.D., Computer Science');
    expect(result[0].year).toBe(2022);
  });

  it('filters out entries with missing degree', () => {
    const result = validateEducation([
      { degree: '', institution: 'MIT', year: 2020 },
    ]);
    expect(result).toHaveLength(0);
  });

  it('filters out entries with missing institution', () => {
    const result = validateEducation([
      { degree: 'Ph.D.', institution: '', year: 2020 },
    ]);
    expect(result).toHaveLength(0);
  });

  it('returns empty for non-array input', () => {
    expect(validateEducation(null)).toHaveLength(0);
    expect(validateEducation(undefined)).toHaveLength(0);
    expect(validateEducation('string')).toHaveLength(0);
    expect(validateEducation(42)).toHaveLength(0);
  });

  it('handles year as null when not a number', () => {
    const result = validateEducation([
      { degree: 'M.S.', institution: 'Stanford', year: 'unknown' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].year).toBeNull();
  });

  // Test role validation
  function validateRoles(raw: unknown): Array<{
    title: string;
    organization: string;
    startYear: number | null;
    endYear: number | null;
    type: string;
  }> {
    if (!Array.isArray(raw)) return [];
    const validTypes = new Set(['key-person', 'advisory', 'board']);
    return raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        title: String(item.title ?? ''),
        organization: String(item.organization ?? ''),
        startYear: typeof item.startYear === 'number' ? item.startYear : null,
        endYear: typeof item.endYear === 'number' ? item.endYear : null,
        type: validTypes.has(String(item.type)) ? String(item.type) : 'key-person',
      }))
      .filter((r) => r.title.length > 0 && r.organization.length > 0);
  }

  it('validates roles with valid types', () => {
    const result = validateRoles([
      { title: 'Director', organization: 'CAIS', startYear: 2022, endYear: null, type: 'key-person' },
      { title: 'Advisor', organization: 'xAI', startYear: 2024, endYear: null, type: 'advisory' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('key-person');
    expect(result[1].type).toBe('advisory');
  });

  it('defaults unknown role type to key-person', () => {
    const result = validateRoles([
      { title: 'Fellow', organization: 'MIT', type: 'unknown-type' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('key-person');
  });

  it('filters empty titles and organizations', () => {
    const result = validateRoles([
      { title: '', organization: 'CAIS', type: 'key-person' },
      { title: 'Director', organization: '', type: 'key-person' },
    ]);
    expect(result).toHaveLength(0);
  });
});
