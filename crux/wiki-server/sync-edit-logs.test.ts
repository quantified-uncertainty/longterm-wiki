import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadEditLogYamls, syncEditLogs } from './sync-edit-logs.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EditLogApiEntry } from '../lib/wiki-server-client.ts';

const noSleep = async () => {};

function makeEntry(pageId: string, date: string = '2026-01-15'): EditLogApiEntry {
  return {
    pageId,
    date,
    tool: 'crux-improve',
    agency: 'ai-directed',
    requestedBy: 'system',
    note: `Updated ${pageId}`,
  };
}

describe('loadEditLogYamls', () => {
  it('loads entries from YAML files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-logs-'));
    writeFileSync(
      join(dir, 'anthropic.yaml'),
      `- date: 2026-01-15\n  tool: crux-improve\n  agency: ai-directed\n  note: Updated page\n`,
    );
    writeFileSync(
      join(dir, 'miri.yaml'),
      `- date: 2026-01-16\n  tool: crux-fix\n  agency: automated\n`,
    );

    const { entries, fileCount, errorFiles } = loadEditLogYamls(dir);

    expect(fileCount).toBe(2);
    expect(errorFiles).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries[0].pageId).toBe('anthropic');
    expect(entries[0].date).toBe('2026-01-15');
    expect(entries[0].tool).toBe('crux-improve');
    expect(entries[1].pageId).toBe('miri');
    expect(entries[1].tool).toBe('crux-fix');
  });

  it('handles Date objects in YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-logs-'));
    // YAML parser converts bare dates to Date objects
    writeFileSync(
      join(dir, 'test-page.yaml'),
      `- date: 2026-01-15\n  tool: crux-fix\n  agency: automated\n`,
    );

    const { entries } = loadEditLogYamls(dir);
    expect(entries).toHaveLength(1);
    // normalizeDate should handle Date objects from YAML parser
    expect(entries[0].date).toBe('2026-01-15');
  });

  it('skips files that are not arrays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-logs-'));
    writeFileSync(join(dir, 'bad.yaml'), 'key: value\n');

    const { entries, errorFiles } = loadEditLogYamls(dir);
    expect(entries).toHaveLength(0);
    expect(errorFiles).toBe(1);
  });

  it('skips entries missing required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-logs-'));
    writeFileSync(
      join(dir, 'page.yaml'),
      `- date: 2026-01-15\n  tool: crux-fix\n  agency: automated\n- date: 2026-01-16\n  note: missing tool and agency\n`,
    );

    const { entries } = loadEditLogYamls(dir);
    expect(entries).toHaveLength(1);
  });

  it('handles empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-logs-'));
    const { entries, fileCount } = loadEditLogYamls(dir);
    expect(entries).toHaveLength(0);
    expect(fileCount).toBe(0);
  });
});

describe('syncEditLogs', () => {
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

  it('inserts all entries successfully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ inserted: 2 }), { status: 200 }),
    );

    const items = [makeEntry('a'), makeEntry('b'), makeEntry('c'), makeEntry('d')];
    const result = await syncEditLogs('http://localhost:3000', items, 2, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ inserted: 4, errors: 0 });
  });

  it('counts errors for failed batches', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ inserted: 2 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    const items = [makeEntry('a'), makeEntry('b'), makeEntry('c'), makeEntry('d')];
    const result = await syncEditLogs('http://localhost:3000', items, 2, {
      _sleep: noSleep,
    });

    expect(result.inserted).toBe(2);
    expect(result.errors).toBe(2);
  });

  it('fast-fails after 3 consecutive failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    const items = Array.from({ length: 10 }, (_, i) => makeEntry(`p${i}`));
    const result = await syncEditLogs('http://localhost:3000', items, 2, {
      _sleep: noSleep,
    });

    expect(result.inserted).toBe(0);
    expect(result.errors).toBe(10);
  });

  it('handles empty items array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await syncEditLogs('http://localhost:3000', [], 100, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ inserted: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends correct payload to /api/edit-logs/batch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ inserted: 1 }), { status: 200 }),
    );

    const items = [makeEntry('test-page')];
    await syncEditLogs('http://localhost:3000', items, 100, {
      _sleep: noSleep,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/edit-logs/batch',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"test-page"'),
      }),
    );

    const callBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(callBody.items).toHaveLength(1);
    expect(callBody.items[0].pageId).toBe('test-page');
  });
});
