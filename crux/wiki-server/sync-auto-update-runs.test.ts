import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRunYaml, loadRunYamls, syncAutoUpdateRuns } from './sync-auto-update-runs.ts';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RecordAutoUpdateRunInput } from '../lib/wiki-server/auto-update.ts';

const noSleep = async () => {};

function makeRun(date: string = '2026-01-15'): RecordAutoUpdateRunInput {
  return {
    date,
    startedAt: `${date}T06:00:00.000Z`,
    completedAt: `${date}T07:00:00.000Z`,
    trigger: 'scheduled',
    budgetLimit: 30,
    budgetSpent: 25,
    sourcesChecked: 10,
    sourcesFailed: 1,
    itemsFetched: 100,
    itemsRelevant: 50,
    pagesPlanned: 5,
    pagesUpdated: 4,
    pagesFailed: 0,
    pagesSkipped: 1,
    newPagesCreated: [],
    results: [
      { pageId: 'test-page', status: 'success', tier: 'standard', durationMs: 5000, errorMessage: null },
    ],
  };
}

describe('parseRunYaml', () => {
  it('parses a complete run YAML file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const filePath = join(dir, '2026-01-15T06-00-00.yaml');
    writeFileSync(
      filePath,
      `date: 2026-01-15
startedAt: 2026-01-15T06:00:00.000Z
completedAt: 2026-01-15T07:00:00.000Z
trigger: scheduled
budget:
  limit: 30
  spent: 25
digest:
  sourcesChecked: 10
  sourcesFailed: 1
  itemsFetched: 100
  itemsRelevant: 50
plan:
  pagesPlanned: 5
execution:
  pagesUpdated: 4
  pagesFailed: 0
  pagesSkipped: 1
  results:
    - pageId: test-page
      status: success
      tier: standard
      durationMs: 5000
newPagesCreated: []
`,
    );

    const result = parseRunYaml(filePath);

    expect(result).not.toBeNull();
    expect(result!.date).toBe('2026-01-15');
    expect(result!.trigger).toBe('scheduled');
    expect(result!.budgetLimit).toBe(30);
    expect(result!.budgetSpent).toBe(25);
    expect(result!.pagesUpdated).toBe(4);
    expect(result!.results).toHaveLength(1);
    expect(result!.results![0].pageId).toBe('test-page');
    expect(result!.results![0].status).toBe('success');
  });

  it('parses a minimal run YAML file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const filePath = join(dir, '2026-01-15.yaml');
    writeFileSync(
      filePath,
      `date: 2026-01-15
startedAt: 2026-01-15T06:00:00.000Z
trigger: manual
budget:
  limit: 50
  spent: 0
digest:
  sourcesChecked: 15
execution:
  pagesUpdated: 0
  results: []
newPagesCreated: []
`,
    );

    const result = parseRunYaml(filePath);

    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('manual');
    expect(result!.completedAt).toBeNull();
    expect(result!.results).toEqual([]);
  });

  it('falls back to startedAt when date is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const filePath = join(dir, 'no-date.yaml');
    writeFileSync(
      filePath,
      `startedAt: 2026-02-10T14:30:00.000Z\ntrigger: manual\nexecution:\n  results: []\nnewPagesCreated: []\n`,
    );

    const result = parseRunYaml(filePath);
    expect(result).not.toBeNull();
    expect(result!.date).toBe('2026-02-10');
  });

  it('returns null for files without startedAt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const filePath = join(dir, 'bad.yaml');
    writeFileSync(filePath, `date: 2026-01-15\ntrigger: manual\n`);

    const result = parseRunYaml(filePath);
    expect(result).toBeNull();
  });
});

describe('loadRunYamls', () => {
  it('loads runs from YAML files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    writeFileSync(
      join(dir, '2026-01-15T06-00-00.yaml'),
      `date: 2026-01-15\nstartedAt: 2026-01-15T06:00:00.000Z\ntrigger: scheduled\nexecution:\n  results: []\nnewPagesCreated: []\n`,
    );

    const { runs, fileCount, errorFiles } = loadRunYamls(dir);

    expect(fileCount).toBe(1);
    expect(errorFiles).toBe(0);
    expect(runs).toHaveLength(1);
  });

  it('skips detail files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    writeFileSync(
      join(dir, '2026-01-15T06-00-00.yaml'),
      `date: 2026-01-15\nstartedAt: 2026-01-15T06:00:00.000Z\ntrigger: scheduled\nexecution:\n  results: []\nnewPagesCreated: []\n`,
    );
    writeFileSync(
      join(dir, '2026-01-15T06-00-00-details.yaml'),
      `someDetail: data\n`,
    );

    const { runs, fileCount } = loadRunYamls(dir);

    expect(fileCount).toBe(1); // detail file excluded
    expect(runs).toHaveLength(1);
  });

  it('handles empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const { runs, fileCount } = loadRunYamls(dir);
    expect(runs).toHaveLength(0);
    expect(fileCount).toBe(0);
  });
});

describe('syncAutoUpdateRuns', () => {
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

  it('inserts all runs successfully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ id: 1, resultsInserted: 1 }), { status: 200 }),
    );

    const runs = [makeRun('2026-01-15'), makeRun('2026-01-16')];
    const result = await syncAutoUpdateRuns('http://localhost:3000', runs, {
      _sleep: noSleep,
    });

    expect(result).toEqual({ inserted: 2, errors: 0 });
  });

  it('counts errors for failed runs', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, resultsInserted: 1 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    const runs = [makeRun('2026-01-15'), makeRun('2026-01-16')];
    const result = await syncAutoUpdateRuns('http://localhost:3000', runs, {
      _sleep: noSleep,
    });

    expect(result.inserted).toBe(1);
    expect(result.errors).toBe(1);
  });

  it('fast-fails after 3 consecutive failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    const runs = Array.from({ length: 6 }, (_, i) => makeRun(`2026-01-${15 + i}`));
    const result = await syncAutoUpdateRuns('http://localhost:3000', runs, {
      _sleep: noSleep,
    });

    expect(result.inserted).toBe(0);
    expect(result.errors).toBe(6);
  });

  it('handles empty runs array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await syncAutoUpdateRuns('http://localhost:3000', [], {
      _sleep: noSleep,
    });

    expect(result).toEqual({ inserted: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends correct payload to /api/auto-update-runs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1, resultsInserted: 1 }), { status: 200 }),
    );

    const runs = [makeRun('2026-01-15')];
    await syncAutoUpdateRuns('http://localhost:3000', runs, {
      _sleep: noSleep,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/auto-update-runs',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"2026-01-15"'),
      }),
    );
  });
});
