/**
 * Tests for orphaned footnote ref stripping.
 *
 * Tests the exported `stripOrphanedInlineRefs()` function which strips
 * inline footnote refs ([^N]) that have no matching definition ([^N]:).
 */

import { describe, it, expect } from 'vitest';
import { stripOrphanedInlineRefs } from './fix-orphaned-footnotes.ts';

describe('stripOrphanedInlineRefs', () => {
  it('strips a single orphaned ref', () => {
    const content = 'Some text[^1] and more.\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toBe('Some text and more.\n');
    expect(stripped).toEqual(['1']);
  });

  it('strips multiple orphaned refs', () => {
    const content = 'First[^1] and second[^2] and third[^3].\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toBe('First and second and third.\n');
    expect(stripped).toHaveLength(3);
  });

  it('preserves refs that have definitions', () => {
    const content = 'Some text[^1] and more[^2].\n\n[^1]: A valid definition\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toContain('[^1]');
    expect(newContent).not.toContain('[^2]');
    expect(stripped).toEqual(['2']);
  });

  it('preserves refs inside code fences', () => {
    const content = 'Text before.\n\n```\ncode[^1] here\n```\n\nText after[^2].\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    // [^1] inside code fence should be preserved
    expect(newContent).toContain('code[^1] here');
    // [^2] outside code fence and orphaned should be stripped
    expect(newContent).toContain('Text after.');
    expect(stripped).toEqual(['2']);
  });

  it('returns unchanged content when no orphaned refs exist', () => {
    const content = 'Text[^1] here.\n\n[^1]: Definition\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toBe(content);
    expect(stripped).toEqual([]);
  });

  it('returns unchanged content when no refs at all', () => {
    const content = 'Plain text with no footnotes.\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toBe(content);
    expect(stripped).toEqual([]);
  });

  it('preserves frontmatter', () => {
    const content = '---\ntitle: Test\n---\n\nSome text[^1] here.\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toBe('---\ntitle: Test\n---\n\nSome text here.\n');
    expect(stripped).toEqual(['1']);
  });

  it('handles refs with non-numeric markers', () => {
    const content = 'Text[^abc] and[^ref-2] more.\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toBe('Text and more.\n');
    expect(stripped).toHaveLength(2);
  });

  it('does not strip definition lines', () => {
    // A definition line [^1]: text should not be modified even if [^1] is orphaned as a def
    const content = 'Body text.\n\n[^1]: Orphaned definition\n';
    const { newContent } = stripOrphanedInlineRefs(content);
    // The definition line should remain (orphaned defs are handled separately)
    expect(newContent).toContain('[^1]: Orphaned definition');
  });

  it('handles adjacent refs', () => {
    const content = 'Text[^1][^2] here.\n';
    const { newContent, stripped } = stripOrphanedInlineRefs(content);
    expect(newContent).toBe('Text here.\n');
    expect(stripped).toHaveLength(2);
  });
});
