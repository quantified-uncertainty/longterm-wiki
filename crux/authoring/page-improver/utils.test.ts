import { describe, it, expect } from 'vitest';
import { repairFrontmatter, ensureFrontmatterFields } from './utils.js';

describe('repairFrontmatter', () => {
  describe('Fix 4: YAML-safe quoting', () => {
    it('quotes llmSummary containing colon-space', () => {
      const input = [
        '---',
        "llmSummary: Stuart Russell co-authored 'Artificial Intelligence: A Modern Approach'",
        '---',
        'Body text',
      ].join('\n');

      const result = repairFrontmatter(input);
      expect(result).toContain(
        'llmSummary: "Stuart Russell co-authored \'Artificial Intelligence: A Modern Approach\'"'
      );
    });

    it('quotes description containing colon-space', () => {
      const input = [
        '---',
        "description: Author of 'Human Compatible: Machines and Human Values'",
        '---',
        'Body',
      ].join('\n');

      const result = repairFrontmatter(input);
      expect(result).toContain(
        'description: "Author of \'Human Compatible: Machines and Human Values\'"'
      );
    });

    it('does not double-quote already-quoted values', () => {
      const input = [
        '---',
        'llmSummary: "Already quoted: with colons"',
        '---',
        'Body',
      ].join('\n');

      const result = repairFrontmatter(input);
      expect(result).toContain('llmSummary: "Already quoted: with colons"');
      // Should not have escaped inner quotes or double-wrapped
      expect(result).not.toContain('\\"');
    });

    it('does not quote values without colon-space', () => {
      const input = [
        '---',
        'llmSummary: A simple summary without problematic characters',
        '---',
        'Body',
      ].join('\n');

      const result = repairFrontmatter(input);
      expect(result).toContain(
        'llmSummary: A simple summary without problematic characters'
      );
      // Should remain unquoted
      expect(result).not.toContain('"A simple');
    });

    it('escapes internal double quotes when wrapping', () => {
      const input = [
        '---',
        'description: He said "hello: world" to everyone',
        '---',
        'Body',
      ].join('\n');

      const result = repairFrontmatter(input);
      expect(result).toContain(
        'description: "He said \\"hello: world\\" to everyone"'
      );
    });

    it('does not touch non-string fields', () => {
      const input = [
        '---',
        'quality: 30',
        'sidebar:',
        '  order: 5',
        '---',
        'Body',
      ].join('\n');

      const result = repairFrontmatter(input);
      expect(result).toContain('quality: 30');
      expect(result).toContain('sidebar:');
    });
  });
});

describe('ensureFrontmatterFields', () => {
  it('restores fields dropped by LLM', () => {
    const original = [
      '---',
      'title: "My Page"',
      'description: "A page"',
      'entityType: capability',
      'quality: 50',
      '---',
      'Body',
    ].join('\n');

    const improved = [
      '---',
      'description: "An improved page"',
      'quality: 65',
      '---',
      'Better body',
    ].join('\n');

    const result = ensureFrontmatterFields(original, improved);
    expect(result).toContain('title: "My Page"');
    expect(result).toContain('entityType: capability');
    expect(result).toContain('description: "An improved page"');
    expect(result).toContain('quality: 65');
    expect(result).toContain('Better body');
  });

  it('preserves LLM updates to existing fields', () => {
    const original = [
      '---',
      'title: "Old Title"',
      'description: "Old desc"',
      '---',
      'Body',
    ].join('\n');

    const improved = [
      '---',
      'title: "New Title"',
      'description: "New desc"',
      '---',
      'Body',
    ].join('\n');

    const result = ensureFrontmatterFields(original, improved);
    expect(result).toContain('title: "New Title"');
    expect(result).toContain('description: "New desc"');
  });

  it('returns improved content unchanged when no fields are missing', () => {
    const original = '---\ntitle: "A"\n---\nBody';
    const improved = '---\ntitle: "B"\n---\nBody';
    expect(ensureFrontmatterFields(original, improved)).toBe(improved);
  });

  it('handles multi-line frontmatter values (ratings block)', () => {
    const original = [
      '---',
      'title: "Page"',
      'ratings:',
      '  novelty: 4.2',
      '  rigor: 6.8',
      '---',
      'Body',
    ].join('\n');

    const improved = [
      '---',
      'title: "Page"',
      '---',
      'Body',
    ].join('\n');

    const result = ensureFrontmatterFields(original, improved);
    expect(result).toContain('ratings:');
    expect(result).toContain('  novelty: 4.2');
    expect(result).toContain('  rigor: 6.8');
  });

  it('returns content unchanged when no frontmatter', () => {
    const original = 'No frontmatter';
    const improved = 'Also no frontmatter';
    expect(ensureFrontmatterFields(original, improved)).toBe(improved);
  });

  it('restores original frontmatter when LLM drops entire block', () => {
    const original = '---\ntitle: "Page"\nentityType: capability\n---\nOriginal body';
    const improved = 'Just body text without frontmatter';
    const result = ensureFrontmatterFields(original, improved);
    expect(result).toContain('---\ntitle: "Page"');
    expect(result).toContain('entityType: capability');
    expect(result).toContain('Just body text without frontmatter');
  });

  it('keeps new fields added by LLM that were not in original', () => {
    const original = '---\ntitle: "A"\n---\nBody';
    const improved = '---\ntitle: "A"\ndraft: true\n---\nBody';
    const result = ensureFrontmatterFields(original, improved);
    expect(result).toContain('draft: true');
    expect(result).toContain('title: "A"');
  });
});
