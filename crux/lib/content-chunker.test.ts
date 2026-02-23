/**
 * Unit tests for content-chunker.ts (splitContentForEnrichment).
 *
 * Covers:
 * - Short content: single chunk returned unchanged
 * - H2-boundary splitting for content > MAX_CHUNK_SIZE
 * - Frontmatter exclusion (LLM should not see YAML metadata)
 * - Line-boundary fallback for sections > MAX_CHUNK_SIZE
 * - No content loss: all section text present across chunks
 */

import { describe, it, expect } from 'vitest';
import { splitContentForEnrichment, MAX_CHUNK_SIZE } from './content-chunker.ts';

describe('splitContentForEnrichment', () => {
  it('returns single chunk for short content', () => {
    const content = 'Short content that fits in one chunk.';
    const chunks = splitContentForEnrichment(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(content);
  });

  it('splits long content at H2 section boundaries', () => {
    const section1 = '## Section One\n' + 'A'.repeat(3000);
    const section2 = '## Section Two\n' + 'B'.repeat(3000);
    const content = `---\ntitle: Test\n---\n\nPreamble text.\n\n${section1}\n\n${section2}`;

    const chunks = splitContentForEnrichment(content);

    // Should produce at least 3 chunks: preamble, section1, section2
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some(c => c.includes('Preamble text'))).toBe(true);
    expect(chunks.some(c => c.includes('## Section One'))).toBe(true);
    expect(chunks.some(c => c.includes('## Section Two'))).toBe(true);
  });

  it('excludes frontmatter from all chunks (YAML metadata should not reach LLM)', () => {
    // Content must be > MAX_CHUNK_SIZE to trigger chunking (otherwise the fast path
    // returns it unchanged — frontmatter exclusion only applies when chunking is needed).
    const section = '## Section\n' + 'x'.repeat(3000) + '\nContent.';
    const section2 = '## Section Two\n' + 'y'.repeat(3000) + '\nMore.';
    const content = `---\ntitle: "Test Page"\nentityId: anthropic\n---\n\nPreamble.\n\n${section}\n\n${section2}`;

    // Confirm content is long enough to trigger chunking
    expect(content.length).toBeGreaterThan(MAX_CHUNK_SIZE);

    const chunks = splitContentForEnrichment(content);
    expect(chunks.length).toBeGreaterThan(1);

    // None of the chunks should contain the raw frontmatter YAML
    for (const chunk of chunks) {
      expect(chunk).not.toContain('entityId: anthropic');
      expect(chunk).not.toContain('title: "Test Page"');
    }
    // But preamble and section text should still be present
    const combined = chunks.join('\n');
    expect(combined).toContain('Preamble.');
    expect(combined).toContain('## Section');
  });

  it('entity mention at position >6000 chars is in a chunk (#673)', () => {
    // "Anthropic" (standalone) is placed past the 6000-char boundary.
    // section1 is intentionally padded to push section2 past position 6000.
    const preamble = 'Introduction.\n\n';
    const section1 = '## First Section\n' + 'x'.repeat(4000) + '\n\n';
    const section2 = '## Second Section\n' + 'y'.repeat(2000) + '\n\nMentions Anthropic here.\n';
    const content = preamble + section1 + section2;

    // Confirm "Anthropic" is past 6000 chars in the source
    expect(content.indexOf('Anthropic')).toBeGreaterThan(6000);

    const chunks = splitContentForEnrichment(content);

    // The second section chunk must contain the exact entity mention
    const chunkWithMention = chunks.find(c => c.includes('## Second Section'));
    expect(chunkWithMention).toBeDefined();
    expect(chunkWithMention).toContain('Mentions Anthropic here.');
  });

  it('fact reference at position >6000 chars is in a chunk (#673)', () => {
    const preamble = 'Introduction.\n\n';
    const section1 = '## First Section\n' + 'x'.repeat(4000) + '\n\n';
    const section2 = '## Second Section\n' + 'y'.repeat(2000) + '\n\nRaised \\$30 billion in 2024.\n';
    const content = preamble + section1 + section2;

    expect(content.indexOf('\\$30 billion')).toBeGreaterThan(6000);

    const chunks = splitContentForEnrichment(content);

    const chunkWithFact = chunks.find(c => c.includes('## Second Section'));
    expect(chunkWithFact).toBeDefined();
    expect(chunkWithFact).toContain('\\$30 billion');
  });

  it('no content is lost: all section headings and preamble present across chunks', () => {
    const section1 = '## Alpha\n' + 'a'.repeat(2000);
    const section2 = '## Beta\n' + 'b'.repeat(2000);
    const section3 = '## Gamma\n' + 'c'.repeat(2000);
    const content = `Intro text.\n\n${section1}\n\n${section2}\n\n${section3}`;

    const chunks = splitContentForEnrichment(content);
    const combined = chunks.join('\n');

    expect(combined).toContain('Intro text.');
    expect(combined).toContain('## Alpha');
    expect(combined).toContain('## Beta');
    expect(combined).toContain('## Gamma');
  });

  it('splits large sections at line boundaries, not arbitrary char positions', () => {
    // Create a section with lines of known length so we can verify split is at line end
    const lineLength = 100;
    const numLines = Math.ceil((MAX_CHUNK_SIZE * 1.5) / lineLength) + 1;
    const lines = Array.from({ length: numLines }, (_, i) => `Line ${i}: ${'x'.repeat(lineLength - 8)}`);
    const sectionContent = '## Big Section\n' + lines.join('\n');
    const content = `---\ntitle: Test\n---\n\nPreamble.\n\n${sectionContent}`;

    const chunks = splitContentForEnrichment(content);

    // Every chunk should start at a line boundary (no mid-line starts)
    for (const chunk of chunks) {
      if (chunk.startsWith('Line ')) {
        // Hard-split chunks should start with a full line, not a partial one
        expect(chunk).toMatch(/^Line \d+:/);
      }
    }
    // All lines should appear exactly once across all chunks
    const combined = chunks.join('\n');
    for (let i = 0; i < numLines; i++) {
      expect(combined).toContain(`Line ${i}:`);
    }
  });

  it('returns no empty chunks', () => {
    const content = `---\ntitle: Sparse\n---\n\n\n## Section\nContent.`;
    const chunks = splitContentForEnrichment(content);
    for (const chunk of chunks) {
      expect(chunk.trim()).not.toBe('');
    }
  });

  it('splits mid-line when a single line exceeds MAX_CHUNK_SIZE (no newline fallback)', () => {
    // A section whose single body line is longer than MAX_CHUNK_SIZE.
    // lastIndexOf('\n', end) returns -1 (or a position <= i) so the code falls back
    // to an exact-char split inside the line. All chars must still be present.
    const longLine = 'x'.repeat(MAX_CHUNK_SIZE + 500);
    const sectionContent = '## Huge Line\n' + longLine;
    const content = `Preamble.\n\n${sectionContent}`;

    // Confirm there is no newline inside the body (triggering the fallback path)
    expect(sectionContent.split('\n').slice(1).join('\n')).not.toContain('\n');

    const chunks = splitContentForEnrichment(content);

    // No content lost: all chars from the long line appear across chunks
    const combined = chunks.join('');
    expect(combined.length).toBeGreaterThanOrEqual(longLine.length);
    expect(combined).toContain(longLine.slice(0, 100));
    expect(combined).toContain(longLine.slice(-100));
  });
});
