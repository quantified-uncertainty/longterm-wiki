/**
 * Tests for api.ts — SCRY search table validation (#694)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeScrySearch } from './api.ts';

// Mock the LLM layer and utils so the module loads without side effects
vi.mock('../../lib/llm.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/llm.ts')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({})),
    streamingCreate: vi.fn(async () => ({ content: [{ type: 'text', text: '' }] })),
    extractText: vi.fn(() => ''),
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

describe('executeScrySearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid table names', async () => {
    const result = await executeScrySearch('test query', 'DROP TABLE users; --');
    expect(result).toContain('invalid table');
    expect(result).toContain('mv_eaforum_posts');
  });

  it('accepts valid table mv_eaforum_posts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ rows: [] }),
    }));

    const result = await executeScrySearch('test query', 'mv_eaforum_posts');
    expect(result).not.toContain('invalid table');
  });

  it('accepts valid table mv_lesswrong_posts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ rows: [] }),
    }));

    const result = await executeScrySearch('test query', 'mv_lesswrong_posts');
    expect(result).not.toContain('invalid table');
  });
});
