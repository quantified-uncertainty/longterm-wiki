/**
 * Tests for prompt-cache.ts — prompt caching utilities
 */

import { describe, it, expect } from 'vitest';
import { buildCachedSystemPrompt, hasCacheControl, STATIC_IMPROVE_GUIDELINES } from './prompt-cache.ts';

describe('buildCachedSystemPrompt', () => {
  it('returns array of TextBlockParam with cache_control on static prefix', () => {
    const result = buildCachedSystemPrompt('static guidelines', 'dynamic context');

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    expect(result[0].text).toBe('static guidelines');
    expect(result[0].cache_control).toEqual({ type: 'ephemeral' });

    expect(result[1].type).toBe('text');
    expect(result[1].text).toBe('dynamic context');
    expect(result[1].cache_control).toBeUndefined();
  });

  it('handles empty static prefix', () => {
    const result = buildCachedSystemPrompt('', 'dynamic only');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('dynamic only');
    expect(result[0].cache_control).toBeUndefined();
  });

  it('handles empty dynamic suffix', () => {
    const result = buildCachedSystemPrompt('static only', '');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('static only');
    expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles both empty', () => {
    const result = buildCachedSystemPrompt('', '');
    expect(result).toHaveLength(0);
  });
});

describe('hasCacheControl', () => {
  it('returns false for undefined', () => {
    expect(hasCacheControl(undefined)).toBe(false);
  });

  it('returns false for string', () => {
    expect(hasCacheControl('plain string')).toBe(false);
  });

  it('returns false for blocks without cache_control', () => {
    expect(hasCacheControl([
      { type: 'text', text: 'no caching' },
    ])).toBe(false);
  });

  it('returns true for blocks with cache_control', () => {
    expect(hasCacheControl([
      { type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'not cached' },
    ])).toBe(true);
  });
});

describe('STATIC_IMPROVE_GUIDELINES', () => {
  it('contains key improvement sections', () => {
    expect(STATIC_IMPROVE_GUIDELINES).toContain('Content Preservation');
    expect(STATIC_IMPROVE_GUIDELINES).toContain('Section Deduplication');
    expect(STATIC_IMPROVE_GUIDELINES).toContain('Wiki Conventions');
    expect(STATIC_IMPROVE_GUIDELINES).toContain('Objectivity & Neutrality');
    expect(STATIC_IMPROVE_GUIDELINES).toContain('Biographical Accuracy');
    expect(STATIC_IMPROVE_GUIDELINES).toContain('Quality Standards');
    expect(STATIC_IMPROVE_GUIDELINES).toContain('Output Format');
  });

  it('is non-trivial length (>1000 chars)', () => {
    expect(STATIC_IMPROVE_GUIDELINES.length).toBeGreaterThan(1000);
  });

  it('does not contain page-specific content', () => {
    // Should not have page-specific placeholders
    expect(STATIC_IMPROVE_GUIDELINES).not.toContain('${page');
    expect(STATIC_IMPROVE_GUIDELINES).not.toContain('${analysis');
    expect(STATIC_IMPROVE_GUIDELINES).not.toContain('${research');
    expect(STATIC_IMPROVE_GUIDELINES).not.toContain('${entityLookup');
  });
});
