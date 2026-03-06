/**
 * Tests for deployment.ts utility functions.
 *
 * Covers:
 *   - convertSlugsToNumericIds: EntityLink and DataInfoBox ID conversion
 *   - validateCrossLinks: EntityLink counting and footnote balance checks
 *
 * All tests are offline — no file system access beyond what's explicitly mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock the modules that read from the filesystem before importing
// deployment.ts, because getSlugToNumericMap reads database.json on first call.
vi.mock('../../lib/session/edit-log.ts', () => ({
  appendEditLog: vi.fn(),
  getDefaultRequestedBy: vi.fn(() => 'test'),
}));

vi.mock('../../lib/validation/validate-mdx-content.ts', () => ({
  validateMdxContent: vi.fn(() => ({ valid: true })),
}));

// Import the functions under test AFTER mocking
import { convertSlugsToNumericIds, validateCrossLinks } from './deployment.ts';

// ---------------------------------------------------------------------------
// convertSlugsToNumericIds
// ---------------------------------------------------------------------------

describe('convertSlugsToNumericIds', () => {
  it('leaves content unchanged when there are no slug-based EntityLinks', () => {
    const content = `---
title: Test
---

## Section

Some content without any entity links.
`;
    const result = convertSlugsToNumericIds(content, '/fake/root');
    expect(result.content).toBe(content);
    expect(result.converted).toBe(0);
  });

  it('leaves numeric EntityLink IDs unchanged (already E## format)', () => {
    const content = `<EntityLink id="E123">Some Entity</EntityLink>`;
    const result = convertSlugsToNumericIds(content, '/fake/root');
    expect(result.content).toBe(content);
    expect(result.converted).toBe(0);
  });

  it('leaves slug-based EntityLinks unchanged when registry is empty (database.json not found)', () => {
    // The module caches the registry. Since database.json doesn't exist in the
    // test environment, the registry is empty and slugs are left as-is.
    const content = `<EntityLink id="open-philanthropy">Open Philanthropy</EntityLink>`;
    const result = convertSlugsToNumericIds(content, '/nonexistent/path');
    // Slug not in registry → leave as-is
    expect(result.content).toBe(content);
    expect(result.converted).toBe(0);
  });

  it('handles content with no EntityLinks or DataInfoBox attributes', () => {
    const content = `## Section\n\nJust plain text with entityId mentioned inline.`;
    const result = convertSlugsToNumericIds(content, '/fake/root');
    expect(result.content).toBe(content);
    expect(result.converted).toBe(0);
  });

  it('preserves multiple EntityLinks when none are in registry', () => {
    const content = [
      '<EntityLink id="org-a">Org A</EntityLink>',
      'and',
      '<EntityLink id="org-b">Org B</EntityLink>',
    ].join(' ');
    const result = convertSlugsToNumericIds(content, '/fake/root');
    expect(result.content).toBe(content);
    expect(result.converted).toBe(0);
  });

  it('does not modify numeric entityId attributes in DataInfoBox', () => {
    const content = `<DataInfoBox entityId="E456" />`;
    const result = convertSlugsToNumericIds(content, '/fake/root');
    expect(result.content).toBe(content);
    expect(result.converted).toBe(0);
  });

  it('returns converted count of zero when no conversions occur', () => {
    const content = `<EntityLink id="some-slug">text</EntityLink>`;
    const result = convertSlugsToNumericIds(content, '/fake/root');
    expect(result.converted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateCrossLinks
// ---------------------------------------------------------------------------

describe('validateCrossLinks', () => {
  it('warns when no EntityLinks are found', () => {
    // Use the module's internal fs.existsSync and readFileSync via a tmp file
    const { writeFileSync, mkdtempSync, rmSync } = require('fs');
    const { join } = require('path');
    const tmpDir = mkdtempSync('/tmp/test-crosslinks-');
    const filePath = join(tmpDir, 'test.mdx');

    try {
      writeFileSync(filePath, '## Section\n\nNo entity links here.\n');
      const result = validateCrossLinks(filePath);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('No EntityLinks'))).toBe(true);
      expect(result.outboundCount).toBe(0);
      expect(result.outboundIds).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('warns when only 1-2 EntityLinks are found (below threshold)', () => {
    const { writeFileSync, mkdtempSync, rmSync } = require('fs');
    const { join } = require('path');
    const tmpDir = mkdtempSync('/tmp/test-crosslinks-');
    const filePath = join(tmpDir, 'test.mdx');

    try {
      writeFileSync(filePath, '<EntityLink id="E100">One</EntityLink>\n');
      const result = validateCrossLinks(filePath);
      expect(result.warnings.some(w => w.includes('Only'))).toBe(true);
      expect(result.outboundCount).toBe(1);
      expect(result.outboundIds).toContain('E100');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not warn when 3+ EntityLinks are found', () => {
    const { writeFileSync, mkdtempSync, rmSync } = require('fs');
    const { join } = require('path');
    const tmpDir = mkdtempSync('/tmp/test-crosslinks-');
    const filePath = join(tmpDir, 'test.mdx');

    try {
      const content = [
        '<EntityLink id="E100">One</EntityLink>',
        '<EntityLink id="E200">Two</EntityLink>',
        '<EntityLink id="E300">Three</EntityLink>',
      ].join('\n');
      writeFileSync(filePath, content);
      const result = validateCrossLinks(filePath);
      // Should have no warnings about too few entity links
      expect(result.warnings.filter(w => w.includes('EntityLink')).length).toBe(0);
      expect(result.outboundCount).toBe(3);
      expect(result.outboundIds).toContain('E100');
      expect(result.outboundIds).toContain('E200');
      expect(result.outboundIds).toContain('E300');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('deduplicates repeated EntityLink IDs in outboundIds', () => {
    const { writeFileSync, mkdtempSync, rmSync } = require('fs');
    const { join } = require('path');
    const tmpDir = mkdtempSync('/tmp/test-crosslinks-');
    const filePath = join(tmpDir, 'test.mdx');

    try {
      const content = [
        '<EntityLink id="E100">Link 1</EntityLink>',
        '<EntityLink id="E100">Same entity again</EntityLink>',
        '<EntityLink id="E200">Other</EntityLink>',
        '<EntityLink id="E300">Another</EntityLink>',
      ].join('\n');
      writeFileSync(filePath, content);
      const result = validateCrossLinks(filePath);
      // outboundIds should be deduplicated
      expect(result.outboundIds.filter(id => id === 'E100')).toHaveLength(1);
      expect(result.outboundCount).toBe(4); // total occurrences
      expect(result.outboundIds).toHaveLength(3); // unique IDs
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('warns when footnote references exceed definitions', () => {
    const { writeFileSync, mkdtempSync, rmSync } = require('fs');
    const { join } = require('path');
    const tmpDir = mkdtempSync('/tmp/test-crosslinks-');
    const filePath = join(tmpDir, 'test.mdx');

    try {
      const content = [
        '<EntityLink id="E100">One</EntityLink>',
        '<EntityLink id="E200">Two</EntityLink>',
        '<EntityLink id="E300">Three</EntityLink>',
        // Footnote references
        'Claim here.[^1] Another claim.[^2]',
        // Only one definition
        '[^1]: Source definition.',
        // [^2] has no definition
      ].join('\n');
      writeFileSync(filePath, content);
      const result = validateCrossLinks(filePath);
      expect(result.warnings.some(w => w.includes('footnote reference'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not warn about footnotes when refs and defs are balanced', () => {
    const { writeFileSync, mkdtempSync, rmSync } = require('fs');
    const { join } = require('path');
    const tmpDir = mkdtempSync('/tmp/test-crosslinks-');
    const filePath = join(tmpDir, 'test.mdx');

    try {
      const content = [
        '<EntityLink id="E100">One</EntityLink>',
        '<EntityLink id="E200">Two</EntityLink>',
        '<EntityLink id="E300">Three</EntityLink>',
        'Claim here.[^1] Another.[^2]',
        '[^1]: First source.',
        '[^2]: Second source.',
      ].join('\n');
      writeFileSync(filePath, content);
      const result = validateCrossLinks(filePath);
      expect(result.warnings.filter(w => w.includes('footnote'))).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns warnings for missing file', () => {
    const result = validateCrossLinks('/nonexistent/path/file.mdx');
    expect(result.warnings).toContain('File not found');
    expect(result.outboundCount).toBe(0);
    expect(result.outboundIds).toHaveLength(0);
  });
});
