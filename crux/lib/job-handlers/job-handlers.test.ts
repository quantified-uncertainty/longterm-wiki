import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JobHandlerContext } from './types.ts';

// ---------------------------------------------------------------------------
// Test context helper
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<JobHandlerContext> = {}): JobHandlerContext {
  return {
    workerId: 'test-worker-1',
    projectRoot: '/tmp/test-project',
    verbose: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Handler Registry Tests
// ---------------------------------------------------------------------------

describe('job-handlers/index', () => {
  it('exports getHandler, isKnownType, getRegisteredTypes', async () => {
    const mod = await import('./index.ts');
    expect(typeof mod.getHandler).toBe('function');
    expect(typeof mod.isKnownType).toBe('function');
    expect(typeof mod.getRegisteredTypes).toBe('function');
  });

  it('registers all expected job types', async () => {
    const { getRegisteredTypes } = await import('./index.ts');
    const types = getRegisteredTypes();

    expect(types).toContain('ping');
    expect(types).toContain('citation-verify');
    expect(types).toContain('page-improve');
    expect(types).toContain('page-create');
    expect(types).toContain('batch-commit');
    expect(types).toContain('auto-update-digest');
  });

  it('isKnownType returns true for registered types', async () => {
    const { isKnownType } = await import('./index.ts');
    expect(isKnownType('ping')).toBe(true);
    expect(isKnownType('page-improve')).toBe(true);
    expect(isKnownType('nonexistent')).toBe(false);
  });

  it('getHandler returns a function for registered types', async () => {
    const { getHandler } = await import('./index.ts');
    const handler = getHandler('ping');
    expect(typeof handler).toBe('function');
  });

  it('getHandler returns undefined for unknown types', async () => {
    const { getHandler } = await import('./index.ts');
    expect(getHandler('nonexistent')).toBeUndefined();
  });

  it('ping handler returns success', async () => {
    const { getHandler } = await import('./index.ts');
    const handler = getHandler('ping')!;
    const result = await handler({}, makeContext());

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(result.data.worker).toBe('test-worker-1');
    expect(result.data.timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Page Improve Handler Tests (validation only — no actual execution)
// ---------------------------------------------------------------------------

describe('job-handlers/page-improve', () => {
  it('rejects missing pageId', async () => {
    const { handlePageImprove } = await import('./page-improve.ts');
    const result = await handlePageImprove({}, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('pageId');
  });

  it('rejects invalid tier', async () => {
    const { handlePageImprove } = await import('./page-improve.ts');
    const result = await handlePageImprove(
      { pageId: 'test', tier: 'invalid' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid tier');
  });
});

// ---------------------------------------------------------------------------
// Page Create Handler Tests (validation only)
// ---------------------------------------------------------------------------

describe('job-handlers/page-create', () => {
  it('rejects missing title', async () => {
    const { handlePageCreate } = await import('./page-create.ts');
    const result = await handlePageCreate({}, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('title');
  });

  it('rejects invalid tier', async () => {
    const { handlePageCreate } = await import('./page-create.ts');
    const result = await handlePageCreate(
      { title: 'Test Page', tier: 'invalid' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid tier');
  });
});

// ---------------------------------------------------------------------------
// Batch Commit Handler Tests (validation only)
// ---------------------------------------------------------------------------

describe('job-handlers/batch-commit', () => {
  it('rejects missing batchId', async () => {
    const { handleBatchCommit } = await import('./batch-commit.ts');
    const result = await handleBatchCommit({}, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('batchId');
  });

  it('rejects missing childJobIds', async () => {
    const { handleBatchCommit } = await import('./batch-commit.ts');
    const result = await handleBatchCommit(
      { batchId: 'test', prTitle: 'Test PR' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('childJobIds');
  });

  it('rejects empty childJobIds', async () => {
    const { handleBatchCommit } = await import('./batch-commit.ts');
    const result = await handleBatchCommit(
      { batchId: 'test', childJobIds: [], prTitle: 'Test PR' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('childJobIds');
  });

  it('rejects missing prTitle', async () => {
    const { handleBatchCommit } = await import('./batch-commit.ts');
    const result = await handleBatchCommit(
      { batchId: 'test', childJobIds: [1, 2] },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('prTitle');
  });
});

// ---------------------------------------------------------------------------
// Auto-Update Digest Handler Tests (validation only)
// ---------------------------------------------------------------------------

describe('job-handlers/auto-update-digest', () => {
  // This handler requires external services, so we only test that the
  // module loads and exports correctly.
  it('exports handleAutoUpdateDigest', async () => {
    const { handleAutoUpdateDigest } = await import('./auto-update-digest.ts');
    expect(typeof handleAutoUpdateDigest).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Utils Tests
// ---------------------------------------------------------------------------

describe('job-handlers/utils', () => {
  it('isContentFile identifies MDX files', async () => {
    const { isContentFile } = await import('./utils.ts');
    expect(isContentFile('content/docs/concepts/ai-safety.mdx')).toBe(true);
    expect(isContentFile('data/entities/concepts.yaml')).toBe(true);
    expect(isContentFile('node_modules/foo.js')).toBe(false);
    expect(isContentFile('apps/web/src/app.tsx')).toBe(false);
    expect(isContentFile('random.yaml')).toBe(true);
    expect(isContentFile('random.mdx')).toBe(true);
  });

  it('applyFileChanges blocks path traversal', async () => {
    const { applyFileChanges } = await import('./utils.ts');
    const result = applyFileChanges('/tmp/fake-root', [
      { path: '../../../etc/passwd', content: 'malicious' },
      { path: 'content/docs/legit.mdx', content: 'ok' },
    ]);

    // The traversal attempt should be rejected
    expect(result.errors.some(e => e.includes('path traversal'))).toBe(true);
    // The legit file should fail because /tmp/fake-root doesn't exist,
    // but it shouldn't be blocked by path traversal
    expect(result.errors.filter(e => e.includes('path traversal')).length).toBe(1);
  });

  it('applyFileChanges blocks non-content files', async () => {
    const { applyFileChanges } = await import('./utils.ts');
    const result = applyFileChanges('/tmp/fake-root', [
      { path: 'package.json', content: '{}' },
      { path: '.env', content: 'SECRET=x' },
    ]);

    // Both should be rejected as non-content files
    expect(result.errors.filter(e => e.includes('not a content file')).length).toBe(2);
    expect(result.applied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Types Tests (compile-time)
// ---------------------------------------------------------------------------

describe('job-handlers/types', () => {
  it('exports expected types', async () => {
    // This just verifies the module loads without errors
    const types = await import('./types.ts');
    expect(types).toBeDefined();
  });
});
