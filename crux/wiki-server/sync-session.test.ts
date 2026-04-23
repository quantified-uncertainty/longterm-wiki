/**
 * Tests for sync-session.ts
 *
 * Covers the core behavior: parseSessionYaml and syncSessionFile,
 * including auth failure handling (issue #2462).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSessionYaml, syncSessionFile } from './sync-session.ts';

describe('parseSessionYaml', () => {
  it('parses a minimal valid YAML file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_test.yaml');
    writeFileSync(filePath, `date: "2026-01-15"\ntitle: Test session\npages: []\n`);
    const entry = parseSessionYaml(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.date).toBe('2026-01-15');
    expect(entry!.title).toBe('Test session');
    expect(entry!.pages).toEqual([]);
  });

  it('returns null for non-existent file', () => {
    const entry = parseSessionYaml('/tmp/does-not-exist-abc123.yaml');
    expect(entry).toBeNull();
  });

  it('returns null for YAML missing required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, 'missing-title.yaml');
    writeFileSync(filePath, `date: "2026-01-15"\n`);
    const entry = parseSessionYaml(filePath);
    expect(entry).toBeNull();
  });

  it('normalizes PR number to URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_with-pr.yaml');
    writeFileSync(filePath, `date: "2026-01-15"\ntitle: With PR\npr: 1234\npages: []\n`);
    const entry = parseSessionYaml(filePath);
    expect(entry!.prUrl).toBe(
      'https://github.com/quantified-uncertainty/longterm-wiki/pull/1234',
    );
  });

  it('serializes checks field to JSON string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_with-checks.yaml');
    writeFileSync(
      filePath,
      `date: "2026-01-15"\ntitle: With Checks\nchecks:\n  initialized: true\n  items: []\npages: []\n`,
    );
    const entry = parseSessionYaml(filePath);
    expect(entry!.checksYaml).not.toBeNull();
    const parsed = JSON.parse(entry!.checksYaml!);
    expect(parsed.initialized).toBe(true);
  });

  it('filters out invalid page IDs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_pages.yaml');
    writeFileSync(
      filePath,
      `date: "2026-01-15"\ntitle: Pages\npages:\n  - valid-page\n  - INVALID_PAGE\n  - another-valid\n`,
    );
    const entry = parseSessionYaml(filePath);
    expect(entry!.pages).toEqual(['valid-page', 'another-valid']);
  });
});

describe('syncSessionFile — auth error handling (issue #2462)', () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
  const origProdUrl = process.env.PROD_LONGTERMWIKI_SERVER_URL;
  const origProdKey = process.env.PROD_LONGTERMWIKI_SERVER_API_KEY;
  const origWikiServerEnv = process.env.WIKI_SERVER_ENV;

  beforeEach(() => {
    vi.restoreAllMocks();
    // Opt out of slot auto-detection (QUA-616) so env-var assertions are
    // deterministic regardless of CWD.
    process.env.WIKI_SERVER_ENV = 'local';
    process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3000';
    process.env.LONGTERMWIKI_SERVER_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (origProdUrl !== undefined) process.env.PROD_LONGTERMWIKI_SERVER_URL = origProdUrl;
    else delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
    if (origProdKey !== undefined) process.env.PROD_LONGTERMWIKI_SERVER_API_KEY = origProdKey;
    else delete process.env.PROD_LONGTERMWIKI_SERVER_API_KEY;
    if (origWikiServerEnv !== undefined) process.env.WIKI_SERVER_ENV = origWikiServerEnv;
    else delete process.env.WIKI_SERVER_ENV;
  });

  it('returns auth_error when server returns 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Bearer token required', { status: 401 }),
    );

    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_auth.yaml');
    writeFileSync(
      filePath,
      `date: "2026-01-15"\ntitle: Auth test\nbranch: claude/auth-test\npages: []\n`,
    );

    const result = await syncSessionFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('auth_error');
    }
  });

  it('returns auth_error when server returns 401 with WIKI_SERVER_ENV=prod', async () => {
    delete process.env.LONGTERMWIKI_SERVER_URL;
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    process.env.WIKI_SERVER_ENV = 'prod';
    process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
    process.env.PROD_LONGTERMWIKI_SERVER_API_KEY = 'wrong-prod-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Bearer token required', { status: 401 }),
    );

    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_prod-auth.yaml');
    writeFileSync(
      filePath,
      `date: "2026-01-15"\ntitle: Prod auth test\nbranch: claude/prod-test\npages: []\n`,
    );

    const result = await syncSessionFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('auth_error');
    }
  });

  it('returns unavailable when server is unreachable', async () => {
    process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';

    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_unavail.yaml');
    writeFileSync(
      filePath,
      `date: "2026-01-15"\ntitle: Unavail test\nbranch: claude/unavail-test\npages: []\n`,
    );

    const result = await syncSessionFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('unavailable');
    }
  });

  it('returns bad_request when file has no branch field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_no-branch.yaml');
    writeFileSync(filePath, `date: "2026-01-15"\ntitle: No branch\npages: []\n`);

    const result = await syncSessionFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('bad_request');
    }
  });

  it('returns ok:true on successful sync', async () => {
    const agentSession = {
      id: 42,
      branch: 'claude/test',
      status: 'active',
      title: null,
      summary: null,
      model: null,
      duration: null,
      cost: null,
      prUrl: null,
      checksYaml: null,
      issuesJson: null,
      learningsJson: null,
      recommendationsJson: null,
      reviewed: null,
      pages: [],
      date: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      initiatedAt: new Date().toISOString(),
    };

    vi.spyOn(globalThis, 'fetch')
      // First call: getAgentSessionByBranch
      .mockResolvedValueOnce(new Response(JSON.stringify(agentSession), { status: 200 }))
      // Second call: updateAgentSession
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...agentSession, status: 'completed' }), { status: 200 }));

    const dir = mkdtempSync(join(tmpdir(), 'sync-session-'));
    const filePath = join(dir, '2026-01-15_success.yaml');
    writeFileSync(
      filePath,
      `date: "2026-01-15"\ntitle: Success test\nbranch: claude/test\npages: []\n`,
    );

    const result = await syncSessionFile(filePath);
    expect(result.ok).toBe(true);
  });
});
