/**
 * Tests for `crux linear monitor` (QUA-970).
 *
 * Verifies the upsert/resolve actions used by render-monitor and
 * server-health-monitor workflows. These were previously bash `gh issue
 * create` calls; the migration moves them to Linear-first filing with the
 * project set so tickets aren't orphaned.
 *
 * Test surface:
 *   upsert
 *     - existing open match → comments, exit 0
 *     - no match → resolves project + creates, exit 0
 *     - project missing → exit 1, no create attempted
 *     - project archived/completed → exit 1, no create attempted
 *     - malformed Linear create response (missing identifier/url) → exit 1
 *     - oldest open ticket wins when multiple match (concurrent runs converge)
 *     - missing required flags → exit 1 with usage message
 *   resolve
 *     - no open match → no-op, exit 0
 *     - one open match → comment + close, exit 0
 *     - multiple open matches → close all in parallel, partial-success reported
 *     - missing comment → close without commenting (comment is optional)
 *     - missing title → exit 1
 *
 * Each test injects a `__deps` mock instead of hitting Linear, so these
 * are pure unit tests with no network dependency.
 */

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { monitor, type MonitorDeps } from '../linear-monitor.ts';
import type { SearchedIssue } from '../../lib/linear/issues.ts';

const TITLE = 'Render quality regression detected';
const BODY = '## Render audit failed\n\nDetail here.';
const PROJECT = 'Dashboards & Visibility';

function makeIssue(overrides: Partial<SearchedIssue> = {}): SearchedIssue {
  return {
    identifier: 'QUA-500',
    title: TITLE,
    priority: 0,
    state: { name: 'Backlog', type: 'backlog' },
    url: 'https://linear.app/q/issue/QUA-500',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    search: vi.fn().mockResolvedValue([]),
    comment: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ identifier: 'QUA-9999', url: 'https://linear.app/q/issue/QUA-9999' }),
    setState: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({ id: 'project-uuid-aaaa', name: PROJECT, state: 'started' }),
    ...overrides,
  };
}

describe('crux linear monitor — upsert', () => {
  it('comments on the oldest open match instead of creating a new ticket', async () => {
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([
        makeIssue({ identifier: 'QUA-555' }),
        makeIssue({ identifier: 'QUA-500' }),
        makeIssue({ identifier: 'QUA-700' }),
      ]),
    });

    const result = await monitor(['upsert'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(0);
    // Oldest (QUA-500) wins — concurrent monitor runs converge.
    expect(deps.comment).toHaveBeenCalledWith('QUA-500', BODY);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('filters out title near-matches (Linear search is token-based)', async () => {
    // Linear's full-text search returns tokens-overlap results too. The
    // upsert command must filter to EXACT title match before deciding what
    // to do — otherwise an unrelated ticket with similar words gets
    // commented on or, worse, dedup-blocks the real ticket from being filed.
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([
        makeIssue({ identifier: 'QUA-555', title: 'Render quality investigation: auto-update' }),
      ]),
    });

    const result = await monitor(['upsert'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(0);
    expect(deps.comment).not.toHaveBeenCalled();
    expect(deps.create).toHaveBeenCalled();
  });

  it('skips closed tickets when picking a comment target', async () => {
    // Closed tickets must NOT be commented on; we want a brand-new ticket
    // when every prior match is closed.
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([
        makeIssue({ identifier: 'QUA-500', state: { name: 'Done', type: 'completed' } }),
      ]),
    });

    const result = await monitor(['upsert'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(0);
    expect(deps.comment).not.toHaveBeenCalled();
    expect(deps.create).toHaveBeenCalled();
  });

  it('creates a new ticket with the resolved project when no open match exists', async () => {
    const deps = makeDeps();

    const result = await monitor(['upsert'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(0);
    expect(deps.getProject).toHaveBeenCalledWith(PROJECT);
    expect(deps.create).toHaveBeenCalledWith({
      title: TITLE,
      description: BODY,
      projectId: 'project-uuid-aaaa',
    });
  });

  it('refuses with exit 1 when the project does not resolve', async () => {
    // Rename detection. Don't file orphans silently.
    const deps = makeDeps({ getProject: vi.fn().mockResolvedValue(null) });

    const result = await monitor(['upsert'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(1);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('refuses with exit 1 when the project is archived (state=completed)', async () => {
    // Filing into an archived project produces invisible tickets.
    const deps = makeDeps({
      getProject: vi.fn().mockResolvedValue({ id: 'p', name: PROJECT, state: 'completed' }),
    });

    const result = await monitor(['upsert'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(1);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('refuses with exit 1 when Linear create returns malformed response', async () => {
    const deps = makeDeps({
      create: vi.fn().mockResolvedValue({ identifier: undefined, url: undefined }),
    });

    const result = await monitor(['upsert'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(1);
  });

  it('reads body from --body-file when --body is omitted', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'linear-monitor-test-'));
    const path = join(tmp, 'body.md');
    writeFileSync(path, BODY, 'utf-8');

    const deps = makeDeps();

    const result = await monitor(['upsert'], {
      title: TITLE,
      bodyFile: path,
      project: PROJECT,
      __deps: deps,
    });

    expect(result.exitCode).toBe(0);
    expect(deps.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: BODY }),
    );
  });

  it('refuses with exit 1 when --title is missing', async () => {
    const deps = makeDeps();
    const result = await monitor(['upsert'], { body: BODY, project: PROJECT, __deps: deps });
    expect(result.exitCode).toBe(1);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('refuses with exit 1 when --project is missing', async () => {
    const deps = makeDeps();
    const result = await monitor(['upsert'], { title: TITLE, body: BODY, __deps: deps });
    expect(result.exitCode).toBe(1);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('refuses with exit 1 when neither --body nor --body-file is provided', async () => {
    const deps = makeDeps();
    const result = await monitor(['upsert'], { title: TITLE, project: PROJECT, __deps: deps });
    expect(result.exitCode).toBe(1);
    expect(deps.create).not.toHaveBeenCalled();
  });
});

describe('crux linear monitor — resolve', () => {
  it('returns no-op exit 0 when there are no matching open tickets', async () => {
    const deps = makeDeps();

    const result = await monitor(['resolve'], { title: TITLE, comment: 'All clear', __deps: deps });

    expect(result.exitCode).toBe(0);
    expect(deps.setState).not.toHaveBeenCalled();
    expect(deps.comment).not.toHaveBeenCalled();
  });

  it('comments + closes a single matching open ticket', async () => {
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([makeIssue({ identifier: 'QUA-500' })]),
    });

    const result = await monitor(['resolve'], { title: TITLE, comment: 'All clear', __deps: deps });

    expect(result.exitCode).toBe(0);
    expect(deps.comment).toHaveBeenCalledWith('QUA-500', 'All clear');
    expect(deps.setState).toHaveBeenCalledWith('QUA-500', 'Done');
  });

  it('closes without commenting when --comment is omitted', async () => {
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([makeIssue({ identifier: 'QUA-500' })]),
    });

    const result = await monitor(['resolve'], { title: TITLE, __deps: deps });

    expect(result.exitCode).toBe(0);
    expect(deps.comment).not.toHaveBeenCalled();
    expect(deps.setState).toHaveBeenCalledWith('QUA-500', 'Done');
  });

  it('closes every matching open ticket in parallel', async () => {
    // Multiple concurrent monitor runs occasionally race and produce
    // duplicates. Resolve should sweep all of them, not just one.
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([
        makeIssue({ identifier: 'QUA-500' }),
        makeIssue({ identifier: 'QUA-501' }),
      ]),
    });

    const result = await monitor(['resolve'], { title: TITLE, __deps: deps });

    expect(result.exitCode).toBe(0);
    expect(deps.setState).toHaveBeenCalledWith('QUA-500', 'Done');
    expect(deps.setState).toHaveBeenCalledWith('QUA-501', 'Done');
  });

  it('reports partial failures via exit 1 but keeps the successful closes', async () => {
    const setState = vi
      .fn()
      .mockResolvedValueOnce(undefined) // QUA-500 succeeds
      .mockRejectedValueOnce(new Error('Linear 500')); // QUA-501 fails
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([
        makeIssue({ identifier: 'QUA-500' }),
        makeIssue({ identifier: 'QUA-501' }),
      ]),
      setState,
    });

    const result = await monitor(['resolve'], { title: TITLE, __deps: deps });

    expect(result.exitCode).toBe(1);
    // Both attempts happened — partial failure shouldn't abort the sweep.
    expect(setState).toHaveBeenCalledTimes(2);
  });

  it('refuses with exit 1 when --title is missing', async () => {
    const deps = makeDeps();
    const result = await monitor(['resolve'], { __deps: deps });
    expect(result.exitCode).toBe(1);
    expect(deps.setState).not.toHaveBeenCalled();
  });

  it('does not match closed tickets (only open ones get resolved)', async () => {
    // Already-closed tickets must not be re-closed — that would post a
    // misleading comment and a no-op state transition.
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([
        makeIssue({ identifier: 'QUA-500', state: { name: 'Done', type: 'completed' } }),
      ]),
    });

    const result = await monitor(['resolve'], { title: TITLE, comment: 'All clear', __deps: deps });

    expect(result.exitCode).toBe(0);
    expect(deps.setState).not.toHaveBeenCalled();
  });

  it('returns JSON output with --json flag', async () => {
    const deps = makeDeps({
      search: vi.fn().mockResolvedValue([makeIssue({ identifier: 'QUA-500' })]),
    });

    const result = await monitor(['resolve'], { title: TITLE, json: true, __deps: deps });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({
      action: 'resolved',
      closed: ['QUA-500'],
      failed: [],
    });
  });
});

describe('crux linear monitor — dispatch', () => {
  it('returns help when called with no subcommand', async () => {
    const result = await monitor([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage: crux linear monitor');
  });

  it('returns help with exit 0 when called with explicit help', async () => {
    const result = await monitor(['help'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage: crux linear monitor');
  });

  it('returns exit 1 on unknown subcommand', async () => {
    const result = await monitor(['fishbowl'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown subcommand');
  });

  it('accepts `up` as an alias for `upsert`', async () => {
    const deps = makeDeps();
    const result = await monitor(['up'], {
      title: TITLE,
      body: BODY,
      project: PROJECT,
      __deps: deps,
    });
    expect(result.exitCode).toBe(0);
    expect(deps.create).toHaveBeenCalled();
  });

  it('accepts `down` as an alias for `resolve`', async () => {
    const deps = makeDeps();
    const result = await monitor(['down'], { title: TITLE, __deps: deps });
    expect(result.exitCode).toBe(0);
  });
});
