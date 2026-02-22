/**
 * Tests for crux/commands/context.ts
 *
 * Focus areas:
 * - Input validation (missing args reject with usage error)
 * - Successful bundle generation (mocked API responses)
 * - Error handling when wiki-server is unavailable
 * - --print flag writes to stdout instead of file
 * - for-issue error handling (bad GITHUB_TOKEN, missing issue number)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the wiki-server client before importing.
// getEntity, searchEntities, getFactsByEntity, searchPages, getPage, getRelatedPages,
// getBacklinks, and getCitationQuotes are all thin wrappers around apiRequest,
// so mocking apiRequest here intercepts all their calls too.
vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: vi.fn(),
  getServerUrl: vi.fn(() => 'http://localhost:3001'),
  getApiKey: vi.fn(() => ''),
  buildHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })),
  BATCH_TIMEOUT_MS: 30_000,
  apiOk: <T>(data: T) => ({ ok: true as const, data }),
  apiErr: (error: string, message: string) => ({ ok: false as const, error, message }),
  unwrap: (result: { ok: boolean; data?: unknown }) => (result.ok ? (result as { data: unknown }).data : null),
  isServerAvailable: vi.fn(() => Promise.resolve(true)),
}));

// Mock the GitHub API
vi.mock('../lib/github.ts', () => ({
  REPO: 'quantified-uncertainty/longterm-wiki',
  githubApi: vi.fn(),
  getGitHubToken: vi.fn(() => 'test-token'),
}));

// Mock fs to avoid writing files during tests
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}));

import { commands } from './context.ts';
import * as clientLib from '../lib/wiki-server/client.ts';
import * as githubLib from '../lib/github.ts';
import { writeFileSync } from 'fs';

const mockApiRequest = vi.mocked(clientLib.apiRequest);
const mockGithubApi = vi.mocked(githubLib.githubApi);
const mockWriteFileSync = vi.mocked(writeFileSync);

// ---------------------------------------------------------------------------
// Test data fixtures
// ---------------------------------------------------------------------------

const PAGE_DETAIL = {
  id: 'scheming',
  numericId: '42',
  title: 'Scheming',
  description: 'AI scheming refers to deceptive planning by AI systems.',
  llmSummary: 'A comprehensive overview of AI scheming behaviors.',
  category: 'risks',
  subcategory: null,
  entityType: 'risk',
  tags: 'ai-safety, deception',
  quality: 8,
  readerImportance: 75,
  hallucinationRiskLevel: 'medium',
  hallucinationRiskScore: 0.55,
  contentPlaintext: null,
  wordCount: 2500,
  lastUpdated: '2026-01-15',
  contentFormat: 'mdx',
  syncedAt: '2026-02-20T00:00:00Z',
};

const RELATED_RESULT = {
  entityId: 'scheming',
  related: [
    { id: 'deceptive-alignment', type: 'page', title: 'Deceptive Alignment', score: 4.5 },
    { id: 'rlhf', type: 'page', title: 'RLHF', score: 3.2, label: 'technique' },
  ],
  total: 2,
};

const BACKLINKS_RESULT = {
  targetId: 'scheming',
  backlinks: [
    {
      id: 'ai-safety-overview',
      type: 'page',
      title: 'AI Safety Overview',
      linkType: 'mention',
      weight: 1.0,
    },
  ],
  total: 1,
};

const CITATIONS_RESULT = {
  quotes: [
    {
      id: 1,
      pageId: 'scheming',
      footnote: 1,
      url: 'https://example.com',
      claimText: 'AI systems may engage in scheming behaviors.',
      sourceQuote: null,
      quoteVerified: true,
      verificationScore: 0.9,
      sourceTitle: 'Example Paper',
      accuracyVerdict: 'accurate',
      accuracyScore: 0.95,
    },
  ],
  pageId: 'scheming',
  total: 1,
};

const ENTITY_DETAIL = {
  id: 'anthropic',
  entityType: 'organization',
  title: 'Anthropic',
  description: 'An AI safety company focused on building reliable AI systems.',
  website: 'https://anthropic.com',
  status: 'active',
  tags: ['ai-safety', 'research'],
  customFields: [{ label: 'Founded', value: '2021' }],
  relatedEntries: [{ id: 'openai', type: 'organization', relationship: 'competitor' }],
  sources: [{ title: 'Anthropic website', url: 'https://anthropic.com' }],
  syncedAt: '2026-02-20T00:00:00Z',
};

const FACTS_RESULT = {
  entityId: 'anthropic',
  facts: [
    {
      id: 1,
      entityId: 'anthropic',
      factId: 'anthropic-employees',
      label: 'Employees',
      value: null,
      numeric: 500,
      low: 400,
      high: 600,
      asOf: '2025-01-01',
      measure: 'employees',
      note: null,
      format: null,
    },
  ],
  total: 1,
};

const PAGE_SEARCH_RESULT = {
  results: [
    {
      id: 'scheming',
      numericId: '42',
      title: 'Scheming',
      description: 'AI scheming description',
      entityType: 'risk',
      category: 'risks',
      readerImportance: 75,
      quality: 8,
      score: 2.345,
    },
  ],
  query: 'scheming',
  total: 1,
};

const ENTITY_SEARCH_RESULT = {
  results: [
    {
      id: 'anthropic',
      entityType: 'organization',
      title: 'Anthropic',
      description: 'AI safety company.',
      website: 'https://anthropic.com',
      status: 'active',
      tags: ['ai-safety'],
      customFields: null,
      relatedEntries: null,
      sources: null,
      syncedAt: '2026-02-20T00:00:00Z',
    },
  ],
  query: 'anthropic',
  total: 1,
};

const GITHUB_ISSUE = {
  number: 580,
  title: 'Add crux context CLI for assembling research bundles',
  body: 'This issue proposes a new CLI command to streamline research context gathering.',
  labels: [{ name: 'tooling' }, { name: 'P1' }],
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-15T00:00:00Z',
  html_url: 'https://github.com/quantified-uncertainty/longterm-wiki/issues/580',
  user: { login: 'alice' },
};

// ---------------------------------------------------------------------------
// for-page — input validation
// ---------------------------------------------------------------------------

describe('context for-page — input validation', () => {
  it('returns error when no page ID provided', async () => {
    const result = await commands['for-page']([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Error');
    expect(result.output).toContain('page ID');
  });

  it('ignores flag-like args and still errors when no real page ID given', async () => {
    const result = await commands['for-page'](['--help'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('page ID');
  });
});

// ---------------------------------------------------------------------------
// for-page — successful bundle generation
// ---------------------------------------------------------------------------

describe('context for-page — successful bundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates bundle and returns success summary', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: PAGE_DETAIL })    // page
      .mockResolvedValueOnce({ ok: true, data: RELATED_RESULT })  // related
      .mockResolvedValueOnce({ ok: true, data: BACKLINKS_RESULT }) // backlinks
      .mockResolvedValueOnce({ ok: true, data: CITATIONS_RESULT }); // citations

    const result = await commands['for-page'](['scheming'], { ci: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('scheming');
    expect(result.output).toContain('Context bundle');
  });

  it('--print flag returns bundle as output string', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: PAGE_DETAIL })
      .mockResolvedValueOnce({ ok: true, data: RELATED_RESULT })
      .mockResolvedValueOnce({ ok: true, data: BACKLINKS_RESULT })
      .mockResolvedValueOnce({ ok: true, data: CITATIONS_RESULT });

    const result = await commands['for-page'](['scheming'], { print: true, ci: true });
    expect(result.exitCode).toBe(0);
    // Bundle content includes page title
    expect(result.output).toContain('Scheming');
    // Bundle includes related pages section
    expect(result.output).toContain('Related Pages');
    // Bundle includes citation health
    expect(result.output).toContain('Citation Health');
  });

  it('returns page-not-found error for 404', async () => {
    mockApiRequest.mockResolvedValueOnce({ ok: false, error: 'bad_request', message: '404: Not found' });

    const result = await commands['for-page'](['nonexistent-page'], { ci: true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('not found');
  });

  it('handles wiki-server unavailable gracefully', async () => {
    mockApiRequest.mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'ECONNREFUSED' });

    const result = await commands['for-page'](['scheming'], { ci: true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('unavailable');
  });

  it('writes bundle to output path when --print not set', async () => {
    mockWriteFileSync.mockClear();
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: PAGE_DETAIL })
      .mockResolvedValueOnce({ ok: true, data: RELATED_RESULT })
      .mockResolvedValueOnce({ ok: true, data: BACKLINKS_RESULT })
      .mockResolvedValueOnce({ ok: true, data: CITATIONS_RESULT });

    const result = await commands['for-page'](['scheming'], { ci: true });
    expect(result.exitCode).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const writtenPath = String(vi.mocked(mockWriteFileSync).mock.calls[0][0]);
    expect(writtenPath).toContain('wip-context.md');
  });

  it('respects --output override path', async () => {
    mockWriteFileSync.mockClear();
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: PAGE_DETAIL })
      .mockResolvedValueOnce({ ok: true, data: RELATED_RESULT })
      .mockResolvedValueOnce({ ok: true, data: BACKLINKS_RESULT })
      .mockResolvedValueOnce({ ok: true, data: CITATIONS_RESULT });

    await commands['for-page'](['scheming'], { output: '/tmp/my-context.md', ci: true });
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(vi.mocked(mockWriteFileSync).mock.calls[0][0]).toBe('/tmp/my-context.md');
  });
});

// ---------------------------------------------------------------------------
// for-entity — input validation
// ---------------------------------------------------------------------------

describe('context for-entity — input validation', () => {
  it('returns error when no entity ID provided', async () => {
    const result = await commands['for-entity']([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('entity ID');
  });
});

// ---------------------------------------------------------------------------
// for-entity — successful bundle generation
// ---------------------------------------------------------------------------

describe('context for-entity — successful bundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates bundle with entity details and facts', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: ENTITY_DETAIL })   // entity
      .mockResolvedValueOnce({ ok: true, data: FACTS_RESULT })     // facts
      .mockResolvedValueOnce({ ok: true, data: PAGE_SEARCH_RESULT }); // pages mentioning entity

    const result = await commands['for-entity'](['anthropic'], { print: true, ci: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('Key Facts');
    expect(result.output).toContain('Employees');
  });

  it('returns entity-not-found error for 404', async () => {
    mockApiRequest.mockResolvedValueOnce({ ok: false, error: 'bad_request', message: '404' });

    const result = await commands['for-entity'](['unknown-entity'], { ci: true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('not found');
  });

  it('facts fetch uses /by-entity/ endpoint (regression: was /api/facts?entity_id=)', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: ENTITY_DETAIL })
      .mockResolvedValueOnce({ ok: true, data: FACTS_RESULT })
      .mockResolvedValueOnce({ ok: true, data: PAGE_SEARCH_RESULT });

    await commands['for-entity'](['anthropic'], { print: true, ci: true });

    // Verify that one of the apiRequest calls used the correct /by-entity/ path,
    // not the former broken /api/facts?entity_id= path.
    const factsCalls = mockApiRequest.mock.calls.filter((call) =>
      String(call[1]).includes('by-entity'),
    );
    expect(factsCalls).toHaveLength(1);
    expect(factsCalls[0][1]).toContain('/api/facts/by-entity/anthropic');
    // Verify no call used the old broken path
    const brokenCalls = mockApiRequest.mock.calls.filter((call) =>
      String(call[1]).includes('entity_id='),
    );
    expect(brokenCalls).toHaveLength(0);
  });

  it('writes bundle to default output path when --print not set', async () => {
    mockWriteFileSync.mockClear();
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: ENTITY_DETAIL })
      .mockResolvedValueOnce({ ok: true, data: FACTS_RESULT })
      .mockResolvedValueOnce({ ok: true, data: PAGE_SEARCH_RESULT });

    const result = await commands['for-entity'](['anthropic'], { ci: true });
    expect(result.exitCode).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const writtenPath = String(vi.mocked(mockWriteFileSync).mock.calls[0][0]);
    expect(writtenPath).toContain('wip-context.md');
  });
});

// ---------------------------------------------------------------------------
// for-topic — input validation
// ---------------------------------------------------------------------------

describe('context for-topic — input validation', () => {
  it('returns error when no topic provided', async () => {
    const result = await commands['for-topic']([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('topic');
  });
});

// ---------------------------------------------------------------------------
// for-topic — successful bundle generation
// ---------------------------------------------------------------------------

describe('context for-topic — successful bundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates bundle with search results', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: PAGE_SEARCH_RESULT })    // page search
      .mockResolvedValueOnce({ ok: true, data: ENTITY_SEARCH_RESULT }); // entity search

    const result = await commands['for-topic'](['AI', 'safety'], { print: true, ci: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AI safety');
    expect(result.output).toContain('Scheming');
    expect(result.output).toContain('Anthropic');
  });

  it('handles empty search results gracefully', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: { results: [], query: 'xyz', total: 0 } })
      .mockResolvedValueOnce({ ok: true, data: { results: [], query: 'xyz', total: 0 } });

    const result = await commands['for-topic'](['xyz-nonexistent'], { print: true, ci: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No pages found');
  });

  it('handles wiki-server unavailable gracefully', async () => {
    mockApiRequest
      .mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'ECONNREFUSED' })
      .mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'ECONNREFUSED' });

    const result = await commands['for-topic'](['scheming'], { print: true, ci: true });
    expect(result.exitCode).toBe(0); // topic still produces output (graceful degradation)
    expect(result.output).toContain('unavailable');
  });
});

// ---------------------------------------------------------------------------
// for-issue — input validation
// ---------------------------------------------------------------------------

describe('context for-issue — input validation', () => {
  it('returns error when no issue number provided', async () => {
    const result = await commands['for-issue']([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('issue number');
  });

  it('returns error when arg is not a number', async () => {
    const result = await commands['for-issue'](['not-a-number'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('issue number');
  });
});

// ---------------------------------------------------------------------------
// for-issue — successful bundle generation
// ---------------------------------------------------------------------------

describe('context for-issue — successful bundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates bundle with issue details and related pages', async () => {
    mockGithubApi.mockResolvedValueOnce(GITHUB_ISSUE);
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: PAGE_SEARCH_RESULT })    // page search
      .mockResolvedValueOnce({ ok: true, data: ENTITY_SEARCH_RESULT }); // entity search

    const result = await commands['for-issue'](['580'], { print: true, ci: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Issue #580');
    expect(result.output).toContain('Add crux context CLI');
    expect(result.output).toContain('Related Wiki Pages');
    expect(result.output).toContain('tooling');
  });

  it('includes issue body in the bundle', async () => {
    mockGithubApi.mockResolvedValueOnce(GITHUB_ISSUE);
    mockApiRequest
      .mockResolvedValueOnce({ ok: true, data: PAGE_SEARCH_RESULT })
      .mockResolvedValueOnce({ ok: true, data: ENTITY_SEARCH_RESULT });

    const result = await commands['for-issue'](['580'], { print: true, ci: true });
    expect(result.output).toContain('Description');
    expect(result.output).toContain('streamline research context');
  });

  it('returns error when GitHub API call fails', async () => {
    mockGithubApi.mockRejectedValueOnce(new Error('GitHub API returned 401: Bad credentials'));

    const result = await commands['for-issue'](['580'], { ci: true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Error fetching issue');
  });

  it('handles wiki-server unavailable after fetching GitHub issue', async () => {
    mockGithubApi.mockResolvedValueOnce(GITHUB_ISSUE);
    mockApiRequest
      .mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'ECONNREFUSED' })
      .mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'ECONNREFUSED' });

    const result = await commands['for-issue'](['580'], { print: true, ci: true });
    expect(result.exitCode).toBe(0); // issue data was fetched; wiki-server failure is graceful
    expect(result.output).toContain('Issue #580');
    expect(result.output).toContain('unavailable');
  });
});
