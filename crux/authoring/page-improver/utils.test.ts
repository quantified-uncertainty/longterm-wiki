import { describe, it, expect } from 'vitest';
import { repairFrontmatter } from './utils.js';

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
