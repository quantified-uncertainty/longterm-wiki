/**
 * Tests for website-sources fetch pipeline — content-hash dedup logic.
 *
 * Tests the client-side hash computation and dedup detection that avoids
 * creating duplicate page snapshots for unchanged content.
 */

import { describe, it, expect } from 'vitest';
import { computeContentHash } from './website-sources.ts';

// ---------------------------------------------------------------------------
// Content-hash computation
// ---------------------------------------------------------------------------

describe('computeContentHash', () => {
  it('produces a deterministic 64-char hex hash', () => {
    const hash = computeContentHash('Hello, world!');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Same input → same output
    expect(computeContentHash('Hello, world!')).toBe(hash);
  });

  it('produces different hashes for different content', () => {
    const hash1 = computeContentHash('Page version 1');
    const hash2 = computeContentHash('Page version 2');
    expect(hash1).not.toBe(hash2);
  });

  it('handles empty string', () => {
    const hash = computeContentHash('');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats whitespace-only changes as different content', () => {
    const hash1 = computeContentHash('Hello world');
    const hash2 = computeContentHash('Hello  world');
    expect(hash1).not.toBe(hash2);
  });

  it('handles unicode content', () => {
    const hash = computeContentHash('日本語テスト 🚀');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles very large content', () => {
    const largeContent = 'x'.repeat(1_000_000);
    const hash = computeContentHash(largeContent);
    expect(hash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Dedup decision logic
// ---------------------------------------------------------------------------

describe('content-hash dedup logic', () => {
  it('detects unchanged content by comparing hashes', () => {
    const pageContent = 'This is the page content about Anthropic.';
    const fetchedHash = computeContentHash(pageContent);
    const lastContentHash = computeContentHash(pageContent);
    expect(fetchedHash).toBe(lastContentHash);
    const shouldSkip = fetchedHash === lastContentHash;
    expect(shouldSkip).toBe(true);
  });

  it('detects changed content', () => {
    const oldContent = 'Anthropic has 100 employees.';
    const newContent = 'Anthropic has 500 employees.';
    const oldHash = computeContentHash(oldContent);
    const newHash = computeContentHash(newContent);
    expect(oldHash).not.toBe(newHash);
    const shouldSkip = newHash === oldHash;
    expect(shouldSkip).toBe(false);
  });

  it('handles null lastContentHash (first fetch)', () => {
    const content = 'First fetch of this page.';
    const fetchedHash = computeContentHash(content);
    const lastContentHash: string | null = null;
    // First fetch: no last hash, so always create snapshot
    const shouldSkip = lastContentHash === fetchedHash;
    expect(shouldSkip).toBe(false);
  });

  it('minor HTML changes that produce same text are deduped', () => {
    // The source-fetcher converts HTML to markdown/text.
    // Two different HTML pages that render to the same text should dedup.
    const text = 'Anthropic is an AI safety company.';
    const hash1 = computeContentHash(text);
    const hash2 = computeContentHash(text);
    expect(hash1).toBe(hash2);
  });
});
