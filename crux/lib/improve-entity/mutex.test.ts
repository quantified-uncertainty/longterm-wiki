/**
 * Tests for `checkImproveEntityMutex` (QUA-1032).
 *
 * Pure-helper tests — `listPipelineRuns` is injected, no network. Each test
 * pins the clock so freshness math is deterministic.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  checkImproveEntityMutex,
  formatMutexError,
  ImproveEntityMutexError,
  IMPROVE_ENTITY_PIPELINE_NAME,
  IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
  type CheckMutexOptions,
} from './mutex.ts';
import type { PipelineRunRow } from '../wiki-server/pipeline-runs.ts';
import type { ApiResult } from '../wiki-server/client.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-05-01T20:00:00.000Z');
const NOW = (): number => T0;

function makeRow(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return {
    runId: 'run-1',
    pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
    agentSessionId: 42,
    entityId: null,
    shape: null,
    status: 'running',
    startedAt: new Date(T0 - 60_000).toISOString(),
    heartbeatAt: new Date(T0 - 30_000).toISOString(),
    endedAt: null,
    failureReason: null,
    errorCode: null,
    errorPayload: null,
    snapshotPath: null,
    followupActions: [],
    costUsd: null,
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    createdAt: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0 - 30_000).toISOString(),
    ...overrides,
  } as PipelineRunRow;
}

function makeList(
  rows: PipelineRunRow[] | { ok: false; error: 'unavailable' | 'server_error'; message: string },
): NonNullable<CheckMutexOptions['list']> {
  return vi.fn().mockResolvedValue(
    Array.isArray(rows)
      ? ({ ok: true, data: { runs: rows, count: rows.length } } satisfies ApiResult<{
          runs: PipelineRunRow[];
          count: number;
        }>)
      : (rows satisfies ApiResult<{ runs: PipelineRunRow[]; count: number }>),
  );
}

// ── core behavior ───────────────────────────────────────────────────────────

describe('checkImproveEntityMutex', () => {
  it('returns null when no running rows match', async () => {
    const list = makeList([]);
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      list,
      nowMs: NOW,
    });
    expect(result).toBeNull();
    expect(list).toHaveBeenCalledWith({
      status: 'running',
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      limit: 50,
    });
  });

  it('returns the conflict when one fresh running row exists', async () => {
    const row = makeRow({ runId: 'run-A', agentSessionId: 7 });
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      list: makeList([row]),
      nowMs: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.runId).toBe('run-A');
    expect(result!.agentSessionId).toBe(7);
    expect(result!.ageSeconds).toBe(30);
  });

  it('skips rows whose heartbeat is older than the freshness window', async () => {
    // 31 min stale heartbeat → above the 30-min default cutoff.
    const stale = makeRow({
      runId: 'stale',
      heartbeatAt: new Date(T0 - 31 * 60_000).toISOString(),
    });
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      list: makeList([stale]),
      nowMs: NOW,
    });
    expect(result).toBeNull();
  });

  it('falls back to startedAt when heartbeatAt is null', async () => {
    // No heartbeat yet (race between insert and first beat).
    // startedAt is 1 min ago → within freshness.
    const row = makeRow({
      runId: 'fresh-no-beat',
      heartbeatAt: null,
      startedAt: new Date(T0 - 60_000).toISOString(),
    });
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      list: makeList([row]),
      nowMs: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.runId).toBe('fresh-no-beat');
  });

  it('returns the most-recently-active conflict when multiple are fresh', async () => {
    const older = makeRow({
      runId: 'older',
      heartbeatAt: new Date(T0 - 5 * 60_000).toISOString(),
    });
    const newer = makeRow({
      runId: 'newer',
      heartbeatAt: new Date(T0 - 15_000).toISOString(),
    });
    const middle = makeRow({
      runId: 'middle',
      heartbeatAt: new Date(T0 - 60_000).toISOString(),
    });
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      list: makeList([older, newer, middle]),
      nowMs: NOW,
    });
    expect(result?.runId).toBe('newer');
    expect(result?.ageSeconds).toBe(15);
  });

  it('returns null when force=true (regardless of running rows)', async () => {
    const fresh = makeRow({ runId: 'should-be-bypassed' });
    const list = makeList([fresh]);
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      force: true,
      list,
      nowMs: NOW,
    });
    expect(result).toBeNull();
    // force should short-circuit *before* the API call
    expect(list).not.toHaveBeenCalled();
  });

  it('respects a custom freshnessMs window', async () => {
    // 5 min ago — would normally be fresh under the 30-min default,
    // but rejected by a 1-min freshness window.
    const row = makeRow({
      runId: 'just-outside',
      heartbeatAt: new Date(T0 - 5 * 60_000).toISOString(),
    });
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      freshnessMs: 60_000,
      list: makeList([row]),
      nowMs: NOW,
    });
    expect(result).toBeNull();
  });

  it('forwards the pipelineName filter to the API', async () => {
    const list = makeList([]);
    await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_PIPELINE_NAME,
      list,
      nowMs: NOW,
    });
    expect(list).toHaveBeenCalledWith({
      status: 'running',
      pipelineName: IMPROVE_ENTITY_PIPELINE_NAME,
      limit: 50,
    });
  });
});

// ── fail-open paths ─────────────────────────────────────────────────────────

describe('checkImproveEntityMutex — fail-open', () => {
  it('returns null (allows run) when listPipelineRuns returns ok:false', async () => {
    const list = makeList({
      ok: false,
      error: 'unavailable',
      message: 'wiki-server down',
    });
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      list,
      nowMs: NOW,
    });
    expect(result).toBeNull();
  });

  it('returns null (allows run) when listPipelineRuns throws', async () => {
    const list = vi.fn().mockRejectedValue(new Error('network exploded'));
    const result = await checkImproveEntityMutex({
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      list,
      nowMs: NOW,
    });
    expect(result).toBeNull();
  });
});

// ── error formatting ────────────────────────────────────────────────────────

describe('formatMutexError', () => {
  it('formats the conflict with run id, age, and session id', () => {
    const conflict = {
      runId: 'run-XYZ',
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      agentSessionId: 99,
      startedAt: new Date(T0 - 60_000),
      heartbeatAt: new Date(T0 - 45_000),
      ageSeconds: 45,
    };
    const msg = formatMutexError(conflict, IMPROVE_ENTITY_SUITE_PIPELINE_NAME);
    expect(msg).toContain('run_id=run-XYZ');
    expect(msg).toContain('agent_session_id=99');
    expect(msg).toContain('45s ago');
    expect(msg).toContain('Wait for it to complete, or pass --force');
    expect(msg).toMatch(/Another improve-entity-suite run is in progress/);
  });

  it('omits agent_session_id when null', () => {
    const conflict = {
      runId: 'run-1',
      pipelineName: IMPROVE_ENTITY_PIPELINE_NAME,
      agentSessionId: null,
      startedAt: new Date(T0),
      heartbeatAt: new Date(T0),
      ageSeconds: 5,
    };
    const msg = formatMutexError(conflict, IMPROVE_ENTITY_PIPELINE_NAME);
    expect(msg).not.toContain('agent_session_id');
    expect(msg).toContain('5s ago');
  });

  it('formats minute-scale ages as Xm', () => {
    const conflict = {
      runId: 'run-1',
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      agentSessionId: null,
      startedAt: new Date(T0),
      heartbeatAt: new Date(T0),
      ageSeconds: 7 * 60 + 12, // 7m 12s — drops the seconds at minute scale
    };
    expect(formatMutexError(conflict, IMPROVE_ENTITY_SUITE_PIPELINE_NAME)).toContain('7m ago');
  });

  it('formats hour-scale ages as Xh Ym', () => {
    const conflict = {
      runId: 'run-1',
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      agentSessionId: null,
      startedAt: new Date(T0),
      heartbeatAt: new Date(T0),
      ageSeconds: 3600 + 5 * 60,
    };
    expect(formatMutexError(conflict, IMPROVE_ENTITY_SUITE_PIPELINE_NAME)).toContain('1h 5m ago');
  });
});

describe('ImproveEntityMutexError', () => {
  it('exposes conflict + pipelineName and produces a useful message', () => {
    const conflict = {
      runId: 'run-1',
      pipelineName: IMPROVE_ENTITY_PIPELINE_NAME,
      agentSessionId: 11,
      startedAt: new Date(T0),
      heartbeatAt: new Date(T0),
      ageSeconds: 12,
    };
    const err = new ImproveEntityMutexError(conflict, IMPROVE_ENTITY_PIPELINE_NAME);
    expect(err.conflict.runId).toBe('run-1');
    expect(err.pipelineName).toBe(IMPROVE_ENTITY_PIPELINE_NAME);
    expect(err.message).toContain('run_id=run-1');
    expect(err.message).toContain('Another improve-entity run');
    expect(err.name).toBe('ImproveEntityMutexError');
  });
});
