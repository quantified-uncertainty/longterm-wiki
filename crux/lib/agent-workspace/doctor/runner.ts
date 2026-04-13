/**
 * Doctor runner — executes a list of checks and renders the result.
 *
 * Output modes:
 *   - pretty: human-scannable text per the QUA-326 specs
 *   - json:   structured object (for `--json` flag)
 *
 * Exit code: worst result wins (fail → 2, warn → 1, ok → 0).
 */

import type { CheckResult, CheckStatus, DoctorCheck, DoctorEnv } from './types.ts';

export interface RunOptions {
  /** Run checks in parallel. Default true; set false for deterministic test ordering. */
  parallel?: boolean;
}

export interface RunReport {
  role: 'slots' | 'releases';
  startedAt: string;
  runtimeMs: number;
  checks: CheckResult[];
  summary: Record<CheckStatus, number>;
  /** Worst status among all checks. */
  worst: CheckStatus;
}

const STATUS_ORDER: Record<CheckStatus, number> = {
  ok: 0,
  info: 0,
  skipped: 0,
  warn: 1,
  fail: 2,
};

const ICONS: Record<CheckStatus, string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: '–',
  skipped: '–',
};

export async function runDoctor(
  role: 'slots' | 'releases',
  checks: DoctorCheck[],
  env: DoctorEnv,
  opts: RunOptions = {},
): Promise<RunReport> {
  const startedAt = env.now();
  const startMs = startedAt.getTime();

  const runOne = async (c: DoctorCheck): Promise<CheckResult> => {
    const t0 = Date.now();
    try {
      const partial = await c.run(env);
      return { id: c.id, label: c.label, durationMs: Date.now() - t0, ...partial };
    } catch (err) {
      return {
        id: c.id,
        label: c.label,
        status: 'fail',
        summary: 'check threw an error',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
    }
  };

  const parallel = opts.parallel ?? true;
  const results: CheckResult[] = parallel
    ? await Promise.all(checks.map(runOne))
    : await checksSequential(checks, runOne);

  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0, skipped: 0 };
  let worst: CheckStatus = 'ok';
  for (const r of results) {
    summary[r.status] += 1;
    if (STATUS_ORDER[r.status] > STATUS_ORDER[worst]) worst = r.status;
  }

  return {
    role,
    startedAt: formatTimestamp(startedAt),
    runtimeMs: Date.now() - startMs,
    checks: results,
    summary,
    worst,
  };
}

async function checksSequential(
  checks: DoctorCheck[],
  runOne: (c: DoctorCheck) => Promise<CheckResult>,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of checks) out.push(await runOne(c));
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderPretty(report: RunReport): string {
  const lines: string[] = [];
  const header = `=== /agent-${report.role}-doctor — ${report.startedAt} ===`;
  lines.push(header, '');

  const labelWidth = Math.max(...report.checks.map((c) => c.label.length), 12);
  for (const c of report.checks) {
    const icon = ICONS[c.status];
    const label = c.label.padEnd(labelWidth);
    lines.push(`${icon} ${label}  ${c.summary}`);
    if (c.detail && c.status !== 'ok') {
      for (const dl of c.detail.split('\n')) lines.push(`    ${dl}`);
    }
  }

  lines.push('');
  const issues =
    `${report.summary.fail} failure${report.summary.fail === 1 ? '' : 's'}, ` +
    `${report.summary.warn} warning${report.summary.warn === 1 ? '' : 's'}` +
    (report.summary.skipped ? `, ${report.summary.skipped} skipped` : '');
  lines.push(`Runtime: ${(report.runtimeMs / 1000).toFixed(1)}s  Issues: ${issues}`);

  const actionable = report.checks.filter((c) => c.action && (c.status === 'warn' || c.status === 'fail'));
  if (actionable.length > 0) {
    lines.push('', 'What to do:');
    for (const c of actionable) {
      lines.push(`  ${ICONS[c.status]} ${c.label}: ${c.action}`);
    }
  }

  return lines.join('\n');
}

export function renderJson(report: RunReport): string {
  return JSON.stringify(report, null, 2);
}

export function exitCodeFor(worst: CheckStatus): number {
  if (worst === 'fail') return 2;
  if (worst === 'warn') return 1;
  return 0;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
