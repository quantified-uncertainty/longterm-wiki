import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSessionYamls, syncSessions } from './sync-sessions.ts';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SessionApiEntry } from '../lib/wiki-server-client.ts';

const noSleep = async () => {};

function makeSession(title: string, date: string = '2026-01-15'): SessionApiEntry {
  return {
    date,
    branch: 'claude/test',
    title,
    summary: null,
    model: 'claude-opus-4-6',
    duration: '~30min',
    cost: '~$5',
    prUrl: null,
    checksYaml: null,
    pages: ['page-a', 'page-b'],
  };
}

describe('loadSessionYamls', () => {
  it('loads sessions from YAML files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    writeFileSync(
      join(dir, '2026-01-15_test-branch.yaml'),
      `date: "2026-01-15"\nbranch: claude/test\ntitle: Test session\npages:\n  - page-a\n  - page-b\n`,
    );
    writeFileSync(
      join(dir, '2026-01-16_other-branch.yaml'),
      `date: "2026-01-16"\nbranch: claude/other\ntitle: Other session\npages: []\n`,
    );

    const { sessions, fileCount, errorFiles } = loadSessionYamls(dir);

    expect(fileCount).toBe(2);
    expect(errorFiles).toBe(0);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].title).toBe('Test session');
    expect(sessions[0].pages).toEqual(['page-a', 'page-b']);
    expect(sessions[1].title).toBe('Other session');
  });

  it('handles bare YAML dates (parsed as Date objects)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    // Bare date (no quotes) — YAML parser converts to Date object
    writeFileSync(
      join(dir, '2026-01-15_bare-date.yaml'),
      `date: 2026-01-15\ntitle: Bare date session\npages: []\n`,
    );

    const { sessions, errorFiles } = loadSessionYamls(dir);

    expect(errorFiles).toBe(0);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].date).toBe('2026-01-15');
  });

  it('skips files that cannot be parsed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    writeFileSync(join(dir, 'bad.yaml'), 'not: valid: session\n');

    const { sessions, errorFiles } = loadSessionYamls(dir);
    expect(sessions).toHaveLength(0);
    expect(errorFiles).toBe(1);
  });

  it('handles empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    const { sessions, fileCount } = loadSessionYamls(dir);
    expect(sessions).toHaveLength(0);
    expect(fileCount).toBe(0);
  });
});

describe('syncSessions', () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3000';
    process.env.LONGTERMWIKI_SERVER_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it('inserts all sessions successfully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ upserted: 2 }), { status: 200 }),
    );

    const items = [
      makeSession('Session A'),
      makeSession('Session B'),
      makeSession('Session C'),
      makeSession('Session D'),
    ];
    const result = await syncSessions('http://localhost:3000', items, 2, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ inserted: 4, errors: 0 });
  });

  it('counts errors for failed batches', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ upserted: 2 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    const items = [
      makeSession('A'),
      makeSession('B'),
      makeSession('C'),
      makeSession('D'),
    ];
    const result = await syncSessions('http://localhost:3000', items, 2, {
      _sleep: noSleep,
    });

    expect(result.inserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it('fast-fails after 3 consecutive failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    const items = Array.from({ length: 10 }, (_, i) => makeSession(`S${i}`));
    const result = await syncSessions('http://localhost:3000', items, 2, {
      _sleep: noSleep,
    });

    expect(result.inserted).toBe(0);
    expect(result.errors).toBe(10);
  });

  it('handles empty items array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await syncSessions('http://localhost:3000', [], 100, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ inserted: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends correct payload to /api/sessions/batch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ upserted: 1 }), { status: 200 }),
    );

    const items = [makeSession('Test Session')];
    await syncSessions('http://localhost:3000', items, 100, {
      _sleep: noSleep,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/sessions/batch',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"Test Session"'),
      }),
    );

    const callBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(callBody.items).toHaveLength(1);
    expect(callBody.items[0].title).toBe('Test Session');
  });
});
