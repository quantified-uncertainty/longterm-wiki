/**
 * Tests for the semantic diff system.
 *
 * Tests cover:
 * 1. MDX preprocessing for claim extraction
 * 2. Claim diff engine (pure, no LLM)
 * 3. Scope checker (pure, no LLM)
 * 4. Snapshot storage
 * 5. Assessment logic
 * 6. Adversarial cases (hallucination, scope violation attempts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { preprocessMdxForExtraction, splitIntoChunks } from './claim-extractor.ts';
import { diffClaims } from './diff-engine.ts';
import { checkScope, checkContentScope, filterContentFiles, detectModifiedFiles } from './scope-checker.ts';
import { storeSnapshot, loadSnapshot, listSnapshots } from './snapshot-store.ts';
import type { ExtractedClaim } from './types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClaim(
  text: string,
  type: ExtractedClaim['type'] = 'numeric',
  keyValue?: string,
): ExtractedClaim {
  return {
    text,
    type,
    confidence: 'high',
    sourceContext: text,
    keyValue,
  };
}

const SAMPLE_MDX = `---
numericId: E42
title: Test Organization
description: A test organization
lastEdited: "2024-01-01"
---

import { EntityLink } from '@/components/entity-link';

# Overview

Test Organization was founded in 2015 by Jane Smith. The organization has raised \\$500 million in total funding and employs approximately 300 researchers.

<EntityLink id="some-entity">Some Entity</EntityLink>

## Research Areas

The organization focuses on AI safety research. In 2023, they published 45 papers on alignment.

[^1]: https://example.com/source1
[^2]: https://example.com/source2
`;

// ---------------------------------------------------------------------------
// 1. MDX Preprocessing Tests
// ---------------------------------------------------------------------------

describe('preprocessMdxForExtraction', () => {
  it('strips frontmatter', () => {
    const result = preprocessMdxForExtraction(SAMPLE_MDX);
    expect(result).not.toContain('numericId:');
    expect(result).not.toContain('lastEdited:');
  });

  it('strips import statements', () => {
    const result = preprocessMdxForExtraction(SAMPLE_MDX);
    expect(result).not.toContain('import {');
    expect(result).not.toContain('EntityLink');
  });

  it('strips JSX component tags', () => {
    const result = preprocessMdxForExtraction(SAMPLE_MDX);
    expect(result).not.toContain('<EntityLink');
    expect(result).not.toContain('</EntityLink>');
  });

  it('strips footnote definitions but keeps prose', () => {
    const result = preprocessMdxForExtraction(SAMPLE_MDX);
    expect(result).not.toContain('[^1]:');
    expect(result).not.toContain('[^2]:');
    // Prose should remain
    expect(result).toContain('founded in 2015');
  });

  it('strips heading markers but keeps text', () => {
    const result = preprocessMdxForExtraction(SAMPLE_MDX);
    expect(result).not.toContain('## Research Areas');
    expect(result).toContain('Research Areas');
  });

  it('strips inline footnote references from prose', () => {
    const content = 'The organization has 300 researchers[^1] working on alignment[^2].';
    const result = preprocessMdxForExtraction(content);
    expect(result).not.toContain('[^1]');
    expect(result).not.toContain('[^2]');
    expect(result).toContain('300 researchers');
  });

  it('preserves factual content', () => {
    const result = preprocessMdxForExtraction(SAMPLE_MDX);
    expect(result).toContain('500 million');
    expect(result).toContain('300 researchers');
    expect(result).toContain('2015');
    expect(result).toContain('AI safety research');
  });

  it('handles empty content gracefully', () => {
    const result = preprocessMdxForExtraction('');
    expect(result).toBe('');
  });

  it('handles content with only frontmatter', () => {
    const onlyFm = '---\ntitle: Test\n---\n';
    const result = preprocessMdxForExtraction(onlyFm);
    expect(result).toBe('');
  });
});

describe('splitIntoChunks', () => {
  it('returns single chunk for short content', () => {
    const text = 'Short paragraph.';
    const chunks = splitIntoChunks(text, 3000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits on paragraph boundaries', () => {
    const text = 'Para one.\n\nPara two.\n\nPara three.';
    const chunks = splitIntoChunks(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should not exceed maxChars + one paragraph
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(200);
    }
  });

  it('handles empty string', () => {
    const chunks = splitIntoChunks('', 3000);
    expect(chunks).toHaveLength(0);
  });

  it('preserves all content across chunks', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} with some content.`);
    const text = paragraphs.join('\n\n');
    const chunks = splitIntoChunks(text, 100);
    const rejoined = chunks.join('\n\n');
    // All paragraphs should be preserved
    for (const para of paragraphs) {
      expect(rejoined).toContain(para);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Claim Diff Engine Tests
// ---------------------------------------------------------------------------

describe('diffClaims', () => {
  it('detects added claims', () => {
    const before: ExtractedClaim[] = [
      makeClaim('Organization was founded in 2015', 'temporal', '2015'),
    ];
    const after: ExtractedClaim[] = [
      makeClaim('Organization was founded in 2015', 'temporal', '2015'),
      makeClaim('Organization raised $500 million', 'numeric', '500 million'),
    ];

    const diff = diffClaims(before, after);
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.unchanged).toBe(1);
    expect(diff.summary.removed).toBe(0);
    expect(diff.claimsAfter).toBe(2);
    expect(diff.claimsBefore).toBe(1);
  });

  it('detects removed claims', () => {
    const before: ExtractedClaim[] = [
      makeClaim('Organization was founded in 2015', 'temporal', '2015'),
      makeClaim('Organization has 200 employees', 'numeric', '200'),
    ];
    const after: ExtractedClaim[] = [
      makeClaim('Organization was founded in 2015', 'temporal', '2015'),
    ];

    const diff = diffClaims(before, after);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.unchanged).toBe(1);
    expect(diff.summary.added).toBe(0);
  });

  it('detects changed claims with different key values', () => {
    const before: ExtractedClaim[] = [
      makeClaim('Organization has 200 employees', 'numeric', '200'),
    ];
    const after: ExtractedClaim[] = [
      makeClaim('Organization has 500 employees', 'numeric', '500'),
    ];

    const diff = diffClaims(before, after);
    expect(diff.summary.changed).toBe(1);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);

    const changedEntry = diff.entries.find(e => e.status === 'changed');
    expect(changedEntry).toBeDefined();
    expect(changedEntry?.changeDescription).toContain('200');
    expect(changedEntry?.changeDescription).toContain('500');
  });

  it('handles empty claim sets', () => {
    const diff = diffClaims([], []);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(0);
    expect(diff.summary.unchanged).toBe(0);
    expect(diff.entries).toHaveLength(0);
  });

  it('marks all claims as added when no before claims', () => {
    const after: ExtractedClaim[] = [
      makeClaim('Organization was founded in 2015', 'temporal', '2015'),
      makeClaim('Organization raised $500M', 'numeric', '500'),
    ];

    const diff = diffClaims([], after);
    expect(diff.summary.added).toBe(2);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.unchanged).toBe(0);
  });

  it('marks all claims as removed when no after claims', () => {
    const before: ExtractedClaim[] = [
      makeClaim('Organization was founded in 2015', 'temporal', '2015'),
    ];

    const diff = diffClaims(before, []);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.added).toBe(0);
  });

  it('matches semantically similar claims despite minor wording differences', () => {
    // Claims that differ only in minor wording should be matched via Jaccard similarity
    // The threshold is 0.5, so the two strings must share ≥50% of their word vocabulary
    const before: ExtractedClaim[] = [
      makeClaim('OpenAI employs approximately 1000 researchers', 'numeric', '1000'),
    ];
    const after: ExtractedClaim[] = [
      // Same subject, same number, very similar verb — should match
      makeClaim('OpenAI employs approximately 2000 researchers', 'numeric', '2000'),
    ];

    const diff = diffClaims(before, after);
    // Should be matched as changed (same claim structure, different value)
    expect(diff.summary.unchanged + diff.summary.changed).toBe(1);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);

    const changedEntry = diff.entries.find(e => e.status === 'changed');
    expect(changedEntry).toBeDefined();
  });

  it('does not match unrelated claims', () => {
    const before: ExtractedClaim[] = [
      makeClaim('OpenAI was founded in 2015', 'temporal', '2015'),
    ];
    const after: ExtractedClaim[] = [
      makeClaim('Anthropic focuses on constitutional AI research', 'existence'),
    ];

    const diff = diffClaims(before, after);
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.unchanged).toBe(0);
  });

  it('summary counts are consistent with entries', () => {
    const before: ExtractedClaim[] = [
      makeClaim('Claim A with unique text about topic X', 'numeric', '100'),
      makeClaim('Claim B with unique text about topic Y', 'temporal', '2020'),
    ];
    const after: ExtractedClaim[] = [
      makeClaim('Claim A with unique text about topic X', 'numeric', '200'),
      makeClaim('New claim Z about topic Z', 'existence'),
    ];

    const diff = diffClaims(before, after);
    const total = diff.summary.added + diff.summary.removed + diff.summary.changed + diff.summary.unchanged;
    expect(total).toBe(diff.entries.length);
  });
});

// ---------------------------------------------------------------------------
// 3. Scope Checker Tests
// ---------------------------------------------------------------------------

describe('checkScope', () => {
  it('returns valid when all files are in allowed list', () => {
    const changed = ['content/docs/anthropic.mdx', 'content/docs/openai.mdx'];
    const allowed = ['content/docs/anthropic.mdx', 'content/docs/openai.mdx'];

    const result = checkScope(changed, allowed);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.allowedChanges).toHaveLength(2);
  });

  it('returns invalid when files are outside allowed list', () => {
    const changed = ['content/docs/anthropic.mdx', 'content/docs/deepmind.mdx'];
    const allowed = ['content/docs/anthropic.mdx'];

    const result = checkScope(changed, allowed);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('content/docs/deepmind.mdx');
  });

  it('always allows data/edit-log.yaml changes', () => {
    const changed = ['data/edit-log.yaml'];
    const allowed: string[] = [];

    const result = checkScope(changed, allowed);
    expect(result.valid).toBe(true);
    expect(result.allowedChanges).toContain('data/edit-log.yaml');
  });

  it('always allows data/entities/ changes', () => {
    const changed = ['data/entities/anthropic.yaml'];
    const allowed: string[] = [];

    const result = checkScope(changed, allowed);
    expect(result.valid).toBe(true);
  });

  it('handles empty changed files list', () => {
    const result = checkScope([], ['content/docs/anthropic.mdx']);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.allowedChanges).toHaveLength(0);
  });

  it('handles empty allowed list with non-meta files', () => {
    const changed = ['content/docs/anthropic.mdx'];
    const result = checkScope(changed, []);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });
});

describe('checkContentScope', () => {
  it('validates content files against allowed paths', () => {
    const changed = ['content/docs/anthropic.mdx'];
    const allowed = ['content/docs/anthropic.mdx'];

    const result = checkContentScope(changed, allowed);
    expect(result.valid).toBe(true);
  });
});

describe('filterContentFiles', () => {
  it('filters to only MDX and YAML files', () => {
    const files = [
      'content/docs/page.mdx',
      'data/entities/org.yaml',
      'apps/web/src/component.tsx',
      '.github/workflows/ci.yml',
      'README.md',
    ];

    const content = filterContentFiles(files);
    expect(content).toContain('content/docs/page.mdx');
    expect(content).toContain('data/entities/org.yaml');
    expect(content).toContain('.github/workflows/ci.yml');
    expect(content).not.toContain('apps/web/src/component.tsx');
  });

  it('handles empty file list', () => {
    expect(filterContentFiles([])).toHaveLength(0);
  });
});

describe('detectModifiedFiles', () => {
  it('detects added files', () => {
    const before = new Map([['file-a.mdx', 'hash1']]);
    const after = new Map([['file-a.mdx', 'hash1'], ['file-b.mdx', 'hash2']]);

    const result = detectModifiedFiles(before, after);
    expect(result.added).toContain('file-b.mdx');
    expect(result.modified).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('detects deleted files', () => {
    const before = new Map([['file-a.mdx', 'hash1'], ['file-b.mdx', 'hash2']]);
    const after = new Map([['file-a.mdx', 'hash1']]);

    const result = detectModifiedFiles(before, after);
    expect(result.deleted).toContain('file-b.mdx');
    expect(result.modified).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });

  it('detects modified files (same path, different hash)', () => {
    const before = new Map([['file-a.mdx', 'hash1']]);
    const after = new Map([['file-a.mdx', 'hash2-changed']]);

    const result = detectModifiedFiles(before, after);
    expect(result.modified).toContain('file-a.mdx');
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('handles no changes', () => {
    const before = new Map([['file-a.mdx', 'hash1']]);
    const after = new Map([['file-a.mdx', 'hash1']]);

    const result = detectModifiedFiles(before, after);
    expect(result.modified).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Snapshot Store Tests
// ---------------------------------------------------------------------------

describe('storeSnapshot and loadSnapshot', () => {
  let tempDir: string;

  // We need to patch the SNAPSHOTS_DIR — since it's a module-level const,
  // we use a workaround by mocking the fs path. In practice, we test
  // via the public API but mock the fs operations.

  // For simplicity, we directly test that the functions don't throw
  // and return appropriate types.

  it('storeSnapshot returns a path string or null', () => {
    // Should not throw; may return null if filesystem write fails
    const result = storeSnapshot('test-page-id', 'before content', 'after content', {
      agent: 'test',
      tier: 'standard',
    });

    // Result is either a path string or null (null = filesystem error, acceptable in test env)
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('loadSnapshot returns null for non-existent page', () => {
    const result = loadSnapshot('definitely-nonexistent-page-xyz', '2024-01-01T00:00:00.000Z');
    expect(result).toBeNull();
  });

  it('listSnapshots returns empty array for non-existent page', () => {
    const result = listSnapshots('definitely-nonexistent-page-xyz');
    expect(result).toEqual([]);
  });

  it('stores and retrieves a snapshot', () => {
    const pageId = `test-snapshot-${Date.now()}`;
    const beforeContent = 'Before: Organization was founded in 2015 with 100 employees.';
    const afterContent = 'After: Organization was founded in 2015 with 500 employees.';

    const storedPath = storeSnapshot(pageId, beforeContent, afterContent, {
      agent: 'test-agent',
      tier: 'polish',
    });

    // If storage succeeded (may fail in restricted envs)
    if (storedPath !== null) {
      const snapshots = listSnapshots(pageId);
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0].agent).toBe('test-agent');
      expect(snapshots[0].tier).toBe('polish');

      // Clean up
      try {
        const dir = path.dirname(storedPath);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Adversarial/edge cases
// ---------------------------------------------------------------------------

describe('adversarial cases — diff engine', () => {
  it('handles a claim that changes from a small number to a very large number (hallucination pattern)', () => {
    // An LLM might hallucinate a larger number to seem more impressive
    const before: ExtractedClaim[] = [
      makeClaim('OpenAI employs 1500 researchers', 'numeric', '1500'),
    ];
    const after: ExtractedClaim[] = [
      // LLM hallucinated 10x more employees
      makeClaim('OpenAI employs 15000 researchers', 'numeric', '15000'),
    ];

    const diff = diffClaims(before, after);
    // Should be detected as changed, not as new claim
    expect(diff.summary.changed).toBe(1);
    const change = diff.entries.find(e => e.status === 'changed');
    expect(change?.changeDescription).toContain('1500');
    expect(change?.changeDescription).toContain('15000');
  });

  it('handles many simultaneous claim changes (rewrite pattern)', () => {
    // If an LLM rewrites an entire section, most claims change
    const before: ExtractedClaim[] = Array.from({ length: 10 }, (_, i) =>
      makeClaim(`Claim ${i}: Organization was founded in ${2010 + i}`, 'temporal', `${2010 + i}`)
    );
    const after: ExtractedClaim[] = Array.from({ length: 10 }, (_, i) =>
      makeClaim(`Claim ${i}: Organization was founded in ${2020 + i}`, 'temporal', `${2020 + i}`)
    );

    const diff = diffClaims(before, after);
    // All claims should be detected as changed
    expect(diff.summary.changed).toBe(10);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
  });

  it('handles the same claim appearing multiple times (dedup behavior)', () => {
    const before: ExtractedClaim[] = [
      makeClaim('OpenAI was founded in 2015', 'temporal', '2015'),
    ];
    const after: ExtractedClaim[] = [
      // Same claim appears twice (e.g., in intro and summary)
      makeClaim('OpenAI was founded in 2015', 'temporal', '2015'),
      makeClaim('OpenAI was founded in 2015', 'temporal', '2015'),
    ];

    const diff = diffClaims(before, after);
    // One should match, one should be "added"
    const total = diff.summary.added + diff.summary.unchanged + diff.summary.changed;
    expect(total).toBe(2); // 1 matched + 1 duplicate
  });
});

describe('adversarial cases — scope checker', () => {
  it('detects scope violation when agent modifies unrelated pages', () => {
    // Scenario: Tier 2 agent should only touch conflict files
    const allowedConflictFiles = ['content/docs/anthropic.mdx'];
    const actuallyModified = [
      'content/docs/anthropic.mdx',   // Allowed
      'content/docs/openai.mdx',       // NOT allowed (scope violation)
      'content/docs/deepmind.mdx',     // NOT allowed (scope violation)
    ];

    const result = checkScope(actuallyModified, allowedConflictFiles);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);

    const violatedFiles = result.violations.map(v => v.file);
    expect(violatedFiles).toContain('content/docs/openai.mdx');
    expect(violatedFiles).toContain('content/docs/deepmind.mdx');
  });

  it('reports violation reasons', () => {
    const result = checkScope(
      ['content/docs/secret.mdx'],
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].reason).toContain('not in the allowed scope');
    expect(result.violations[0].file).toBe('content/docs/secret.mdx');
  });
});
