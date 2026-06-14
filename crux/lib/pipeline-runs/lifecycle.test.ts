/**
 * Unit tests for withPipelineRun (QUA-954).
 *
 * Acceptance coverage:
 *   - success path → status=committed
 *   - body throws → re-throw + status=aborted with errorPayload
 *   - body markStatus override (partial_failure) wins over default
 *   - heartbeat fires every interval while body runs
 *   - /start fail → throw by default; allowOffline returns no-op runCtx
 *   - /end fail → caller still receives body's value/exception
 *
 * Mocks at the wiki-server client boundary so we don't need a real
 * server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStart = vi.fn();
const mockHeartbeat = vi.fn();
const mockEnd = vi.fn();

vi.mock('../wiki-server/pipeline-runs.ts', () => ({
  startPipelineRun: (...args: unknown[]) => mockStart(...args),
  heartbeatPipelineRun: (...args: unknown[]) => mockHeartbeat(...args),
  endPipelineRun: (...args: unknown[]) => mockEnd(...args),
}));

const mockGetCachedAuditSessionId = vi.fn<() => string | null>(() => null);

vi.mock('../wiki-server/audit-context.ts', () => ({
  getCachedAuditSessionId: () => mockGetCachedAuditSessionId(),
}));

// Suppress console output during tests — withPipelineRun warn()/error()
// helpers go through console directly. We assert on mock call counts.
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('withPipelineRun', () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockHeartbeat.mockReset();
    mockEnd.mockReset();
    mockGetCachedAuditSessionId.mockReset().mockReturnValue(null);
    consoleWarnSpy.mockClear();
    consoleErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('success path', () => {
    it('starts → runs body → ends with status=committed', async () => {
      mockStart.mockResolvedValue({ ok: true, data: { runId: 'mocked' } });
      mockEnd.mockResolvedValue({ ok: true, data: { runId: 'mocked' } });

      const { withPipelineRun } = await import('./lifecycle.ts');

      const result = await withPipelineRun(
        {
          pipelineName: 'improve-page',
          entityId: 'E42',
          shape: 'standard',
          // Disable heartbeat for this specific test so we don't need to
          // advance fake timers.
          heartbeatIntervalMs: 1_000_000_000,
        },
        async (ctx) => {
          expect(ctx.runId).toBeTruthy();
          expect(ctx.offline).toBe(false);
          return { rows: 3 };
        },
      );

      expect(result).toEqual({ rows: 3 });
      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineName: 'improve-page',
          entityId: 'E42',
          shape: 'standard',
          runId: expect.any(String),
        }),
      );
      expect(mockEnd).toHaveBeenCalledOnce();
      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'committed' }),
      );
    });

    it('passes followups + caller-set status through to /end', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');

      await withPipelineRun(
        { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000_000_000 },
        async (ctx) => {
          ctx.markFollowup({ kind: 'retry', attempt: 1 });
          ctx.markStatus('partial_failure', { reason: 'phase2_abort' });
        },
      );

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'partial_failure',
          failureReason: 'phase2_abort',
          followupActions: [{ kind: 'retry', attempt: 1 }],
        }),
      );
    });
  });

  describe('throw on /start fail (fail-closed default)', () => {
    it('throws when /start returns non-ok and allowOffline is unset', async () => {
      mockStart.mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'connection refused',
      });

      const { withPipelineRun } = await import('./lifecycle.ts');

      const bodySpy = vi.fn();
      await expect(
        withPipelineRun(
          { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000_000_000 },
          bodySpy,
        ),
      ).rejects.toThrow(/failed to register run/);

      // Body never ran, no heartbeat, no /end call — fail-closed semantics.
      expect(bodySpy).not.toHaveBeenCalled();
      expect(mockHeartbeat).not.toHaveBeenCalled();
      expect(mockEnd).not.toHaveBeenCalled();
    });
  });

  describe('allowOffline=true degrades to no-op', () => {
    it('returns body result without ever calling /heartbeat or /end', async () => {
      mockStart.mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'connection refused',
      });

      const { withPipelineRun } = await import('./lifecycle.ts');

      const result = await withPipelineRun(
        {
          pipelineName: 'improve-page',
          allowOffline: true,
          heartbeatIntervalMs: 1_000_000_000,
        },
        async (ctx) => {
          expect(ctx.offline).toBe(true);
          // markStatus / markFollowup must be no-ops in offline mode.
          ctx.markStatus('aborted');
          ctx.markFollowup({ kind: 'whatever' });
          return 'offline-result';
        },
      );

      expect(result).toBe('offline-result');
      expect(mockHeartbeat).not.toHaveBeenCalled();
      expect(mockEnd).not.toHaveBeenCalled();
      // The warning is logged so the offline degradation is visible.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('running offline (allowOffline=true)'),
      );
    });
  });

  describe('body throws → status=aborted with errorPayload', () => {
    it('records the abort, then re-throws to caller', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');

      const boom = new TypeError('boom');
      await expect(
        withPipelineRun(
          { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000_000_000 },
          async () => {
            throw boom;
          },
        ),
      ).rejects.toBe(boom);

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'aborted',
          errorCode: 'TypeError',
          failureReason: 'boom',
          errorPayload: expect.objectContaining({
            name: 'TypeError',
            message: 'boom',
          }),
        }),
      );
    });

    it('preserves caller-set status when the body also throws', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');

      await expect(
        withPipelineRun(
          { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000_000_000 },
          async (ctx) => {
            ctx.markStatus('oscillation', { reason: 'flapping' });
            throw new Error('detected flap');
          },
        ),
      ).rejects.toThrow('detected flap');

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'oscillation',
          failureReason: 'flapping',
        }),
      );
    });
  });

  describe('heartbeat interval', () => {
    it('fires heartbeats while body is awaiting', async () => {
      vi.useFakeTimers();
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockHeartbeat.mockResolvedValue({ ok: true, data: { ok: true } });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');

      // The body waits for a manually-resolved promise so we control
      // exactly when it returns.
      let releaseBody: (() => void) | null = null;
      const blocked = new Promise<void>((resolve) => {
        releaseBody = resolve;
      });

      const promise = withPipelineRun(
        { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000 },
        async () => {
          await blocked;
        },
      );

      // Tick three intervals — heartbeat should have fired three times.
      // We need to flush microtasks between advances so the
      // setInterval callback's mockHeartbeat() actually resolves.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(mockHeartbeat).toHaveBeenCalledTimes(3);

      // Release the body, drain real timers/microtasks.
      releaseBody?.();
      await vi.runAllTimersAsync();
      await promise;

      // After end, no further heartbeats.
      const callsAtEnd = mockHeartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockHeartbeat).toHaveBeenCalledTimes(callsAtEnd);

      // /end was reached.
      expect(mockEnd).toHaveBeenCalledOnce();
    });

    it('survives a heartbeat /api error without aborting the body', async () => {
      vi.useFakeTimers();
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockHeartbeat.mockResolvedValue({
        ok: false,
        error: 'server_error',
        message: '503',
      });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');

      let releaseBody: (() => void) | null = null;
      const blocked = new Promise<void>((resolve) => {
        releaseBody = resolve;
      });

      const promise = withPipelineRun(
        { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000 },
        async () => {
          await blocked;
          return 'ok';
        },
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // Heartbeat warned but did not abort.
      expect(mockHeartbeat).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('heartbeat failed (non-fatal)'),
      );

      releaseBody?.();
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('ok');

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'committed' }),
      );
    });
  });

  describe('CostTracker integration (QUA-1013)', () => {
    it('writes tracker totals to /end on success and the payload satisfies EndPipelineRunSchema', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');
      const { CostTracker } = await import('../cost-tracker.ts');
      const { EndPipelineRunSchema } = await import('../../../apps/wiki-server/src/api-types.ts');

      const tracker = new CostTracker();

      await withPipelineRun(
        {
          pipelineName: 'improve-page',
          tracker,
          heartbeatIntervalMs: 1_000_000_000,
        },
        async () => {
          // The tracker delta is snapshotted from the index before the
          // body ran, so cost must be recorded INSIDE the body for the
          // /end payload to capture it. Pre-existing tracker entries
          // (e.g. from a parent pipeline) are intentionally excluded.
          //
          // Use a real model from the pricing table so calculateCost
          // does NOT silently fall through to 0 — that masking is what
          // made the pre-review version of this test a tautology.
          tracker.record('claude-sonnet-4-6', {
            input_tokens: 1000,
            output_tokens: 200,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 30,
          }, 'phase-1');
          tracker.record('claude-sonnet-4-6', {
            input_tokens: 500,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 80,
          }, 'phase-2');
          return 'done';
        },
      );

      // Sanity guard: this combination must produce an FP-imprecise
      // total — that's what proves the rounding is exercised. If
      // pricing math ever lands on a clean 4-dp value, swap to inputs
      // that don't (e.g. add a cache-read token).
      expect((tracker.totalCost * 10000) % 1).not.toBe(0);

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'committed',
          costUsd: Math.round(tracker.totalCost * 10000) / 10000,
          tokensInput: 1500,
          tokensOutput: 300,
          tokensCacheRead: 110,
          tokensCacheWrite: 50,
        }),
      );

      // Server-side regression guard: the payload must satisfy the
      // exact Zod schema the wiki-server uses. Catches FP precision
      // drift, integer-coercion bugs, and accidental field renames.
      const [, endPayload] = mockEnd.mock.calls[0];
      const parsed = EndPipelineRunSchema.safeParse(endPayload);
      expect(parsed.success).toBe(true);
    });

    it('writes tracker totals to /end when the body throws', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');
      const { CostTracker } = await import('../cost-tracker.ts');

      const tracker = new CostTracker();

      await expect(
        withPipelineRun(
          {
            pipelineName: 'improve-page',
            tracker,
            heartbeatIntervalMs: 1_000_000_000,
          },
          async () => {
            // Cost recorded inside the body — withPipelineRun snapshots
            // the tracker's entry index at start, so only this call's
            // entry is included in /end's costUsd.
            tracker.recordExternalCost('perplexity/sonar', 0.42, 'gap-search');
            throw new Error('mid-run abort');
          },
        ),
      ).rejects.toThrow('mid-run abort');

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'aborted',
          costUsd: 0.42,
          tokensInput: 0,
          tokensOutput: 0,
        }),
      );
    });

    it('records only the body-added delta, not pre-existing tracker entries', async () => {
      // Each pipeline_run row should record only what its body added,
      // not entries the outer scope had already accumulated. Otherwise
      // a nested row would double-count parent spend.
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');
      const { CostTracker } = await import('../cost-tracker.ts');

      const tracker = new CostTracker();
      tracker.recordExternalCost('parent-search', 1.23, 'parent-phase');

      await withPipelineRun(
        { pipelineName: 'inner', tracker, heartbeatIntervalMs: 1_000_000_000 },
        async () => {
          tracker.recordExternalCost('inner-call', 0.05, 'inner-phase');
          return 'done';
        },
      );

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: 'committed',
          costUsd: 0.05,
        }),
      );
    });

    it('nested wrap: inner records its delta, outer records the full sum', async () => {
      // The real-world scenario: improveSingleEntity (outer) calls
      // runResearch (inner) sharing one CostTracker. Outer's row should
      // see all spend; inner's row should see only its own contribution.
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');
      const { CostTracker } = await import('../cost-tracker.ts');

      const tracker = new CostTracker();

      await withPipelineRun(
        { pipelineName: 'outer', tracker, heartbeatIntervalMs: 1_000_000_000 },
        async () => {
          tracker.recordExternalCost('outer-pre', 0.10, 'outer-phase');
          await withPipelineRun(
            { pipelineName: 'inner', tracker, heartbeatIntervalMs: 1_000_000_000 },
            async () => {
              tracker.recordExternalCost('inner-call', 0.05, 'inner-phase');
              return 'inner-done';
            },
          );
          tracker.recordExternalCost('outer-post', 0.20, 'outer-phase');
          return 'outer-done';
        },
      );

      // mockEnd is called twice: once for inner (delta = 0.05), once
      // for outer (full spend = 0.10 + 0.05 + 0.20 = 0.35).
      expect(mockEnd).toHaveBeenCalledTimes(2);
      const innerCall = mockEnd.mock.calls.find(
        ([, payload]: [string, { costUsd?: number }]) => payload.costUsd === 0.05,
      );
      const outerCall = mockEnd.mock.calls.find(
        ([, payload]: [string, { costUsd?: number }]) => payload.costUsd === 0.35,
      );
      expect(innerCall).toBeDefined();
      expect(outerCall).toBeDefined();
    });

    it('sends zero totals when tracker exists but recorded nothing', async () => {
      // An empty tracker reports `costUsd: 0` rather than omitting the
      // field, matching the api-types.ts convention that 0 means
      // "tracked spend was zero" and null/omitted means "not tracked".
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');
      const { CostTracker } = await import('../cost-tracker.ts');

      const tracker = new CostTracker();

      await withPipelineRun(
        { pipelineName: 'improve-page', tracker, heartbeatIntervalMs: 1_000_000_000 },
        async () => 'done',
      );

      expect(mockEnd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          costUsd: 0,
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
        }),
      );
    });

    it('omits cost fields entirely when no tracker is configured', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');

      await withPipelineRun(
        { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000_000_000 },
        async () => 'done',
      );

      const [, endPayload] = mockEnd.mock.calls[0];
      // Fields are absent — distinct from `null`. The QUA-1012 typed
      // client treats omitted as "preserve existing value", which is
      // what untracked pipelines should produce.
      expect(endPayload).not.toHaveProperty('costUsd');
      expect(endPayload).not.toHaveProperty('tokensInput');
      expect(endPayload).not.toHaveProperty('tokensOutput');
      expect(endPayload).not.toHaveProperty('tokensCacheRead');
      expect(endPayload).not.toHaveProperty('tokensCacheWrite');
    });

    it('auto-attributes ambient LLM calls when no tracker is configured', async () => {
      // The win: a pipeline that makes LLM calls without manually wiring a
      // CostTracker still records real spend, because withPipelineRun sets an
      // ambient tracker that the LLM helpers record into. Here we simulate an
      // LLM call by recording into the ambient tracker directly.
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });

      const { withPipelineRun } = await import('./lifecycle.ts');
      const { recordAmbient } = await import('../llm-usage/ambient-tracker.ts');

      await withPipelineRun(
        { pipelineName: 'research-agent', heartbeatIntervalMs: 1_000_000_000 },
        async () => {
          recordAmbient(
            'claude-haiku-4-5-20251001',
            { input_tokens: 1000, output_tokens: 500 },
            'verify',
          );
          return 'done';
        },
      );

      const [, endPayload] = mockEnd.mock.calls[0];
      expect(endPayload.costUsd).toBeGreaterThan(0);
      expect(endPayload.tokensInput).toBe(1000);
      expect(endPayload.tokensOutput).toBe(500);
    });

    it('warns and skips tracker persistence when allowOffline=true and /start fails', async () => {
      mockStart.mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'connection refused',
      });

      const { withPipelineRun } = await import('./lifecycle.ts');
      const { CostTracker } = await import('../cost-tracker.ts');

      const tracker = new CostTracker();
      tracker.recordExternalCost('perplexity/sonar', 0.10, 'phase');

      await withPipelineRun(
        {
          pipelineName: 'improve-page',
          allowOffline: true,
          tracker,
          heartbeatIntervalMs: 1_000_000_000,
        },
        async () => 'done',
      );

      expect(mockEnd).not.toHaveBeenCalled();
      // Surface the silent drop in logs — caller has no run row to
      // attach the totals to, so they need to know they were lost.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('tracker totals will NOT be persisted'),
      );
    });
  });

  describe('/end failure handling', () => {
    it('logs error but still returns body result on /end failure', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({
        ok: false,
        error: 'server_error',
        message: '500',
      });

      const { withPipelineRun } = await import('./lifecycle.ts');

      const result = await withPipelineRun(
        { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000_000_000 },
        async () => 'body-result',
      );

      expect(result).toBe('body-result');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('/end failed'),
      );
    });

    it('rethrows the body error even if /end itself throws (review fix)', async () => {
      // Regression for the QUA-954 hostile-review finding: if `finalize`
      // throws (or, here, /end fails AND endPipelineRun rejects), the
      // body's original exception must still reach the caller. Previously
      // a rejected /end would mask the body's TypeError with the network
      // error, which is exactly the situation where the original error
      // matters most for debugging.
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockRejectedValue(new Error('network down'));

      const { withPipelineRun } = await import('./lifecycle.ts');

      const original = new TypeError('the actual bug');
      await expect(
        withPipelineRun(
          { pipelineName: 'improve-page', heartbeatIntervalMs: 1_000_000_000 },
          async () => {
            throw original;
          },
        ),
      ).rejects.toBe(original);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('finalize threw after body abort'),
      );
    });
  });

  describe('agentSessionId default resolution', () => {
    it('resolves from getCachedAuditSessionId when caller omits the field', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });
      mockGetCachedAuditSessionId.mockReturnValue('42');

      const { withPipelineRun } = await import('./lifecycle.ts');

      await withPipelineRun(
        { pipelineName: 'p', heartbeatIntervalMs: 1_000_000_000 },
        async () => 'done',
      );

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionId: 42 }),
      );
    });

    it('explicit null bypasses the default and propagates as null', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });
      // Cache returns a value — but caller passing null should still win.
      mockGetCachedAuditSessionId.mockReturnValue('42');

      const { withPipelineRun } = await import('./lifecycle.ts');

      await withPipelineRun(
        { pipelineName: 'p', agentSessionId: null, heartbeatIntervalMs: 1_000_000_000 },
        async () => 'done',
      );

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionId: null }),
      );
    });

    it('explicit number bypasses the default', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });
      mockGetCachedAuditSessionId.mockReturnValue('42');

      const { withPipelineRun } = await import('./lifecycle.ts');

      await withPipelineRun(
        { pipelineName: 'p', agentSessionId: 99, heartbeatIntervalMs: 1_000_000_000 },
        async () => 'done',
      );

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionId: 99 }),
      );
    });

    it('omitted field with empty cache resolves to null (no agent session)', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });
      mockGetCachedAuditSessionId.mockReturnValue(null);

      const { withPipelineRun } = await import('./lifecycle.ts');

      await withPipelineRun(
        { pipelineName: 'p', heartbeatIntervalMs: 1_000_000_000 },
        async () => 'done',
      );

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionId: null }),
      );
    });

    it('omitted field with non-numeric cache value resolves to null (parse fail)', async () => {
      mockStart.mockResolvedValue({ ok: true, data: {} });
      mockEnd.mockResolvedValue({ ok: true, data: {} });
      mockGetCachedAuditSessionId.mockReturnValue('not-a-number');

      const { withPipelineRun } = await import('./lifecycle.ts');

      await withPipelineRun(
        { pipelineName: 'p', heartbeatIntervalMs: 1_000_000_000 },
        async () => 'done',
      );

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ agentSessionId: null }),
      );
    });
  });
});
