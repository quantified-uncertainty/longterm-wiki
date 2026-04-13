import { describe, it, expect } from 'vitest';
import { runDoctor, renderPretty, exitCodeFor } from '../runner.ts';
import type { DoctorCheck, DoctorEnv } from '../types.ts';

const stubEnv: DoctorEnv = {
  lwDir: '/lw',
  now: () => new Date('2026-04-12T14:32:08'),
  env: {},
  exists: () => false,
  stat: () => null,
  readlink: () => null,
  readFile: () => null,
  listDir: () => [],
  exec: () => ({ stdout: '', stderr: '', code: 0 }),
  fetch: async () => ({ ok: true, status: 200, body: '', headers: {} }),
  resolve: (...p) => p.join('/'),
};

const okCheck = (id: string, summary = 'fine'): DoctorCheck => ({
  id,
  label: id,
  run: async () => ({ status: 'ok', summary }),
});

const failCheck = (id: string, summary: string, action?: string): DoctorCheck => ({
  id,
  label: id,
  run: async () => ({ status: 'fail', summary, action }),
});

const warnCheck = (id: string, summary: string): DoctorCheck => ({
  id,
  label: id,
  run: async () => ({ status: 'warn', summary, action: 'do the thing' }),
});

describe('runDoctor', () => {
  it('aggregates results and reports the worst status', async () => {
    const r = await runDoctor('slots', [okCheck('a'), warnCheck('b', 'b warn'), failCheck('c', 'c fail')], stubEnv);
    expect(r.summary.ok).toBe(1);
    expect(r.summary.warn).toBe(1);
    expect(r.summary.fail).toBe(1);
    expect(r.worst).toBe('fail');
  });

  it('catches thrown errors and converts to fail', async () => {
    const throwing: DoctorCheck = {
      id: 't', label: 't', run: async () => { throw new Error('boom'); },
    };
    const r = await runDoctor('slots', [throwing], stubEnv);
    expect(r.checks[0].status).toBe('fail');
    expect(r.checks[0].detail).toContain('boom');
  });

  it('records duration for each check', async () => {
    const r = await runDoctor('slots', [okCheck('a')], stubEnv);
    expect(r.checks[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs sequentially when parallel=false', async () => {
    const order: string[] = [];
    const c = (id: string): DoctorCheck => ({
      id, label: id,
      run: async () => { order.push(id); return { status: 'ok', summary: '' }; },
    });
    await runDoctor('slots', [c('a'), c('b'), c('c')], stubEnv, { parallel: false });
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('exitCodeFor', () => {
  it('maps statuses to exit codes', () => {
    expect(exitCodeFor('ok')).toBe(0);
    expect(exitCodeFor('info')).toBe(0);
    expect(exitCodeFor('skipped')).toBe(0);
    expect(exitCodeFor('warn')).toBe(1);
    expect(exitCodeFor('fail')).toBe(2);
  });
});

describe('renderPretty', () => {
  it('shows header, status icons, runtime, and what-to-do block', async () => {
    const r = await runDoctor(
      'slots',
      [okCheck('rename-loop', '1 process'), warnCheck('env-drift', 'a4 stale'), failCheck('disk', 'full', 'free space')],
      stubEnv,
    );
    const text = renderPretty(r);
    expect(text).toContain('=== /agent-slots-doctor');
    expect(text).toContain('rename-loop');
    expect(text).toContain('env-drift');
    expect(text).toContain('What to do:');
    expect(text).toContain('do the thing');
    expect(text).toContain('free space');
  });

  it('omits what-to-do block when no warnings/failures with actions', async () => {
    const r = await runDoctor('slots', [okCheck('a')], stubEnv);
    const text = renderPretty(r);
    expect(text).not.toContain('What to do:');
  });
});
