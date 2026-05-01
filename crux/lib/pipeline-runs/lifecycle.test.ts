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

// Suppress console output during tests — withPipelineRun warn()/error()
// helpers go through console directly. We assert on mock call counts.
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('withPipelineRun', () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockHeartbeat.mockReset();
    mockEnd.mockReset();
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
});
