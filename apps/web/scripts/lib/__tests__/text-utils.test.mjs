/**
 * Tests for text-utils.mjs
 *
 * Verifies stripMarkup and extractDescriptionFromIntro used by
 * entity-transform.mjs and mdx-generator.mjs.
 */

import { describe, it, expect } from 'vitest';
import { stripMarkup, extractDescriptionFromIntro } from '../text-utils.mjs';

describe('stripMarkup', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(stripMarkup(null)).toBe('');
    expect(stripMarkup(undefined)).toBe('');
    expect(stripMarkup('')).toBe('');
  });

  it('strips HTML/JSX tags', () => {
    expect(stripMarkup('<b>bold</b>')).toBe('bold');
    expect(stripMarkup('<DataInfoBox type="test" />Some text')).toBe('Some text');
    expect(stripMarkup('Hello <em>world</em>!')).toBe('Hello world!');
  });

  it('strips markdown links but keeps text', () => {
    expect(stripMarkup('[OpenAI](https://openai.com)')).toBe('OpenAI');
    expect(stripMarkup('See [this paper](http://arxiv.org/123) for details')).toBe('See this paper for details');
  });

  it('strips bold markers', () => {
    expect(stripMarkup('**important** text')).toBe('important text');
  });

  it('strips italic markers', () => {
    expect(stripMarkup('*emphasized* word')).toBe('emphasized word');
  });

  it('strips multiple markup types together', () => {
    expect(stripMarkup('<p>**Bold** and [link](url) with *italics*</p>'))
      .toBe('Bold and link with italics');
  });

  it('trims whitespace', () => {
    expect(stripMarkup('  hello  ')).toBe('hello');
  });
});

describe('extractDescriptionFromIntro', () => {
  it('returns null for null/undefined/empty', () => {
    expect(extractDescriptionFromIntro(null)).toBeNull();
    expect(extractDescriptionFromIntro(undefined)).toBeNull();
    expect(extractDescriptionFromIntro('')).toBeNull();
  });

  it('returns null for very short text', () => {
    expect(extractDescriptionFromIntro('Short.')).toBeNull();
    expect(extractDescriptionFromIntro('Hi there')).toBeNull();
  });

  it('extracts first sentence and adds period', () => {
    expect(extractDescriptionFromIntro('This is a description of the entity. More details here.'))
      .toBe('This is a description of the entity.');
  });

  it('does not double-add period', () => {
    expect(extractDescriptionFromIntro('Already has a period. Second sentence.'))
      .toBe('Already has a period.');
  });

  it('splits on paragraph boundary', () => {
    expect(extractDescriptionFromIntro('First paragraph text\n\nSecond paragraph'))
      .toBe('First paragraph text.');
  });

  it('truncates to 157 chars with ellipsis', () => {
    const longSentence = 'A'.repeat(200) + '. Second sentence.';
    const result = extractDescriptionFromIntro(longSentence);
    expect(result).toBe('A'.repeat(157) + '...');
    expect(result.length).toBe(160);
  });

  it('strips markup before extracting', () => {
    expect(extractDescriptionFromIntro('<DataInfoBox type="risk" />**AI safety** is [important](http://example.com). Details follow.'))
      .toBe('AI safety is important.');
  });

  it('handles intro with only JSX tags', () => {
    expect(extractDescriptionFromIntro('<DataInfoBox type="risk" />')).toBeNull();
  });

  it('handles sentence at exactly 157 chars (no truncation needed)', () => {
    const exactly157 = 'A'.repeat(157);
    const result = extractDescriptionFromIntro(exactly157 + '. More text.');
    // 157 is not > 157, so it gets a period appended (not truncated)
    expect(result).toBe('A'.repeat(157) + '.');
  });

  it('handles sentence under 157 chars', () => {
    const text = 'A'.repeat(100);
    const result = extractDescriptionFromIntro(text + '. More.');
    expect(result).toBe('A'.repeat(100) + '.');
  });

  it('handles text with quotes (used in YAML frontmatter)', () => {
    const result = extractDescriptionFromIntro('The "alignment tax" is a key concept. More here.');
    expect(result).toBe('The "alignment tax" is a key concept.');
    // Callers are responsible for escaping quotes for their context
  });

  it('handles text with no sentence boundary (single long text)', () => {
    const result = extractDescriptionFromIntro('A description without any period or paragraph break');
    expect(result).toBe('A description without any period or paragraph break.');
  });

  it('returns null for whitespace-only input', () => {
    expect(extractDescriptionFromIntro('   ')).toBeNull();
    expect(extractDescriptionFromIntro('\n\n')).toBeNull();
  });

  it('handles nested markdown (bold inside link)', () => {
    const result = extractDescriptionFromIntro('[**Bold link**](http://example.com) is an entity. More.');
    // Link regex keeps text including bold markers, then bold regex strips them
    expect(result).toBe('Bold link is an entity.');
  });

  it('handles single newline (not paragraph break)', () => {
    const result = extractDescriptionFromIntro('First line\nsecond line continues. End here.');
    // Single newline is NOT a paragraph break
    expect(result).toBe('First line\nsecond line continues.');
  });

  it('handles sentence ending exactly at period-space', () => {
    // The period is consumed by the split regex, so the first segment has no period
    const result = extractDescriptionFromIntro('First sentence. Second sentence.');
    expect(result).toBe('First sentence.');
  });

  it('handles at exactly 10 chars (minimum threshold)', () => {
    expect(extractDescriptionFromIntro('0123456789. Next.')).toBe('0123456789.');
  });

  it('returns null at exactly 9 chars (below threshold)', () => {
    expect(extractDescriptionFromIntro('012345678. Next.')).toBeNull();
  });
});
