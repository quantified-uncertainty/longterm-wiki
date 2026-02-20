/**
 * Tests for the deterministic frontmatter conflict resolution logic
 * used by .github/scripts/resolve-conflicts.mjs.
 */

import { describe, it, expect } from 'vitest';
import { findConflictBlocks, tryResolveFrontmatterOnly } from '../../../../../.github/scripts/lib/conflict-resolution.mjs';

// ── findConflictBlocks ──────────────────────────────────────────────────

describe('findConflictBlocks', () => {
  it('returns empty array when no conflict markers exist', () => {
    const lines = ['line 1', 'line 2', 'line 3'];
    expect(findConflictBlocks(lines)).toEqual([]);
  });

  it('finds a single conflict block', () => {
    const lines = [
      'before',
      '<<<<<<< HEAD',
      'head content',
      '=======',
      'main content',
      '>>>>>>> origin/main',
      'after',
    ];
    expect(findConflictBlocks(lines)).toEqual([{ start: 1, end: 5 }]);
  });

  it('finds multiple conflict blocks', () => {
    const lines = [
      '<<<<<<< HEAD',
      'a',
      '=======',
      'b',
      '>>>>>>> origin/main',
      'gap',
      '<<<<<<< HEAD',
      'c',
      '=======',
      'd',
      '>>>>>>> origin/main',
    ];
    expect(findConflictBlocks(lines)).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 },
    ]);
  });

  it('ignores an unclosed conflict block (no >>>>>>>)', () => {
    const lines = [
      '<<<<<<< HEAD',
      'head content',
      '=======',
      'main content',
      // missing >>>>>>>
    ];
    expect(findConflictBlocks(lines)).toEqual([]);
  });
});

// ── tryResolveFrontmatterOnly ───────────────────────────────────────────

describe('tryResolveFrontmatterOnly', () => {
  it('returns null for non-MDX/YAML files', () => {
    const content = '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> origin/main';
    expect(tryResolveFrontmatterOnly('file.ts', content)).toBeNull();
    expect(tryResolveFrontmatterOnly('file.json', content)).toBeNull();
    expect(tryResolveFrontmatterOnly('file.js', content)).toBeNull();
  });

  it('returns null for MDX without frontmatter delimiters', () => {
    const content = 'no frontmatter here\n<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> origin/main';
    expect(tryResolveFrontmatterOnly('page.mdx', content)).toBeNull();
  });

  it('returns null when conflict is outside frontmatter (in body)', () => {
    const content = [
      '---',
      'title: "Test"',
      '---',
      '# Body',
      '<<<<<<< HEAD',
      'head body content',
      '=======',
      'main body content',
      '>>>>>>> origin/main',
    ].join('\n');
    expect(tryResolveFrontmatterOnly('page.mdx', content)).toBeNull();
  });

  it('resolves a simple MDX frontmatter conflict with disjoint keys', () => {
    const content = [
      '---',
      'title: "Test Page"',
      '<<<<<<< HEAD',
      'quality: 65',
      '=======',
      'clusters: ["ai-safety"]',
      '>>>>>>> origin/main',
      '---',
      'import {EntityLink} from "@components/wiki";',
      '',
      '## Content',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('page.mdx', content);
    expect(result).not.toBeNull();
    expect(result).toContain('quality: 65');
    expect(result).toContain('clusters: ["ai-safety"]');
    expect(result).not.toContain('<<<<<<<');
    expect(result).not.toContain('>>>>>>>');
    expect(result).toContain('## Content');
  });

  it('prefers HEAD value for duplicate keys', () => {
    const content = [
      '---',
      'title: "Test"',
      '<<<<<<< HEAD',
      'readerImportance: 72.5',
      'lastEdited: "2026-02-19"',
      '=======',
      'readerImportance: 33.5',
      'lastEdited: "2026-02-20"',
      '>>>>>>> origin/main',
      '---',
      '## Body',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('page.mdx', content);
    expect(result).not.toBeNull();
    expect(result).toContain('readerImportance: 72.5');
    expect(result).toContain('lastEdited: "2026-02-19"');
    expect(result).not.toContain('readerImportance: 33.5');
    expect(result).not.toContain('lastEdited: "2026-02-20"');
  });

  it('merges HEAD duplicates + new keys from main', () => {
    const content = [
      '---',
      'title: "Test"',
      '<<<<<<< HEAD',
      'llmSummary: "HEAD summary"',
      'readerImportance: 72.5',
      'quality: 68',
      '=======',
      'llmSummary: "main summary"',
      'readerImportance: 33.5',
      'clusters: ["ai-safety"]',
      'entityType: capability',
      '>>>>>>> origin/main',
      '---',
      '## Body',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('page.mdx', content);
    expect(result).not.toBeNull();
    // HEAD values preserved for duplicates
    expect(result).toContain('llmSummary: "HEAD summary"');
    expect(result).toContain('readerImportance: 72.5');
    // HEAD-only key kept
    expect(result).toContain('quality: 68');
    // Main-only keys added
    expect(result).toContain('clusters: ["ai-safety"]');
    expect(result).toContain('entityType: capability');
  });

  it('handles multi-line values (nested YAML blocks)', () => {
    const content = [
      '---',
      'title: "Test"',
      '<<<<<<< HEAD',
      'ratings:',
      '  focus: 7.5',
      '  novelty: 3.5',
      '  rigor: 6',
      'quality: 68',
      '=======',
      'clusters:',
      '  - "ai-safety"',
      '  - "governance"',
      'entityType: capability',
      '>>>>>>> origin/main',
      '---',
      '## Body',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('page.mdx', content);
    expect(result).not.toBeNull();
    expect(result).toContain('ratings:');
    expect(result).toContain('  focus: 7.5');
    expect(result).toContain('  novelty: 3.5');
    expect(result).toContain('  rigor: 6');
    expect(result).toContain('quality: 68');
    expect(result).toContain('clusters:');
    expect(result).toContain('  - "ai-safety"');
    expect(result).toContain('entityType: capability');
  });

  it('resolves a YAML file conflict (entire file is frontmatter)', () => {
    const content = [
      'page_id: openai',
      'edits:',
      '- date: 2026-02-19',
      '  tool: crux-improve',
      '  note: "Improved"',
      '<<<<<<< HEAD',
      '- date: 2026-02-20',
      '  tool: crux-grade',
      '  note: "Quality graded: 62"',
      '=======',
      '- date: 2026-02-20',
      '  tool: crux-fix',
      '  note: "Fixed escaping"',
      '- date: 2026-02-20',
      '  tool: crux-improve',
      '  note: "Improved (polish)"',
      '>>>>>>> origin/main',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('data/edit-logs/openai.yaml', content);
    expect(result).not.toBeNull();
    expect(result).toContain('page_id: openai');
    expect(result).not.toContain('<<<<<<<');
    expect(result).not.toContain('>>>>>>>');
  });

  it('handles the real PR #374 agentic-ai.mdx conflict pattern', () => {
    const content = [
      '---',
      'title: "Agentic AI"',
      'description: "AI systems that autonomously take actions"',
      'sidebar:',
      '  order: 3',
      '<<<<<<< HEAD',
      'llmSummary: "HEAD summary about benchmarks"',
      'lastEdited: "2026-02-19"',
      'readerImportance: 72.5',
      'tacticalValue: 88',
      'researchImportance: 94.5',
      'update_frequency: 21',
      'ratings:',
      '  focus: 7.5',
      '  novelty: 3.5',
      '  rigor: 6',
      '  completeness: 8',
      '  concreteness: 7.5',
      '  actionability: 5.5',
      '  objectivity: 7',
      'clusters:',
      '  - "ai-safety"',
      '  - "governance"',
      'quality: 68',
      '=======',
      'llmSummary: "Main summary with 2025 updates"',
      'lastEdited: "2026-02-20"',
      'subcategory: agentic',
      'readerImportance: 94',
      'tacticalValue: 84',
      'researchImportance: 94.5',
      'update_frequency: 21',
      'ratings:',
      '  novelty: 5',
      '  rigor: 6.5',
      '  actionability: 6',
      '  completeness: 7.5',
      'clusters: ["ai-safety", "governance"]',
      'entityType: capability',
      '>>>>>>> origin/main',
      '---',
      'import {DataInfoBox} from "@components/wiki";',
      '',
      '## Key Links',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('content/docs/knowledge-base/capabilities/agentic-ai.mdx', content);
    expect(result).not.toBeNull();

    // HEAD values for duplicate keys
    expect(result).toContain('llmSummary: "HEAD summary about benchmarks"');
    expect(result).toContain('lastEdited: "2026-02-19"');
    expect(result).toContain('readerImportance: 72.5');

    // HEAD-only keys
    expect(result).toContain('quality: 68');

    // Main-only keys added
    expect(result).toContain('subcategory: agentic');
    expect(result).toContain('entityType: capability');

    // Body preserved
    expect(result).toContain('import {DataInfoBox}');
    expect(result).toContain('## Key Links');

    // No conflict markers
    expect(result).not.toContain('<<<<<<<');
    expect(result).not.toContain('>>>>>>>');
    expect(result).not.toContain('=======');
  });

  it('returns null when no conflict markers exist (no-op)', () => {
    const content = [
      '---',
      'title: "Test"',
      'quality: 50',
      '---',
      '## Body',
    ].join('\n');
    expect(tryResolveFrontmatterOnly('page.mdx', content)).toBeNull();
  });

  it('preserves the closing --- and body content intact', () => {
    const content = [
      '---',
      'title: "Test"',
      '<<<<<<< HEAD',
      'quality: 65',
      '=======',
      'entityType: concept',
      '>>>>>>> origin/main',
      '---',
      'import {EntityLink} from "@components/wiki";',
      '',
      '<EntityLink id="miri">MIRI</EntityLink> is an org.',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('page.mdx', content);
    expect(result).not.toBeNull();

    const lines = result.split('\n');
    // Find the closing ---
    const closingIdx = lines.indexOf('---', 1);
    expect(closingIdx).toBeGreaterThan(0);

    // Everything after --- is unchanged body
    const body = lines.slice(closingIdx + 1).join('\n');
    expect(body).toContain('import {EntityLink}');
    expect(body).toContain('<EntityLink id="miri">MIRI</EntityLink>');
  });

  it('handles .yml extension the same as .yaml', () => {
    const content = [
      'key1: value1',
      '<<<<<<< HEAD',
      'key2: headval',
      '=======',
      'key2: mainval',
      'key3: newval',
      '>>>>>>> origin/main',
    ].join('\n');

    const result = tryResolveFrontmatterOnly('data/something.yml', content);
    expect(result).not.toBeNull();
    expect(result).toContain('key2: headval');
    expect(result).toContain('key3: newval');
    expect(result).not.toContain('key2: mainval');
  });
});
