import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseTargetField } from './field-improve.ts';

describe('parseTargetField', () => {
  it('parses TABLE.FIELD format', () => {
    expect(parseTargetField('divisions.lead_id')).toEqual({
      table: 'divisions',
      field: 'lead_id',
    });
  });

  it('parses TABLE:FIELD format (colon separator)', () => {
    expect(parseTargetField('divisions:lead_id')).toEqual({
      table: 'divisions',
      field: 'lead_id',
    });
  });

  it('parses TABLE/FIELD format (slash separator)', () => {
    expect(parseTargetField('funding_programs/total_budget')).toEqual({
      table: 'funding_programs',
      field: 'total_budget',
    });
  });

  it('preserves dots in field names (e.g. JSON paths)', () => {
    expect(parseTargetField('divisions.metadata.lead')).toEqual({
      table: 'divisions',
      field: 'metadata.lead',
    });
  });

  it('throws on missing separator', () => {
    expect(() => parseTargetField('divisions')).toThrow(/Invalid --target-field format/);
  });

  it('throws on empty input', () => {
    expect(() => parseTargetField('')).toThrow(/Invalid --target-field format/);
  });
});

describe('runFieldTargetedImprove', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns skipped entry and does not dispatch loop for unknown (table, field)', async () => {
    vi.doMock('./loop.ts', () => ({
      runLoop: vi.fn().mockRejectedValue(new Error('should not be called')),
    }));

    const { runFieldTargetedImprove } = await import('./field-improve.ts');
    const result = await runFieldTargetedImprove({
      target: 'divisions.unknown_field',
      budgetUsd: 5,
    });

    expect(result.targets).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      table: 'divisions',
      field: 'unknown_field',
    });
    expect(result.stoppedReason).toBe('no_mapping');
  });

  it('dispatches runLoop with the correct taskType filter for a known field', async () => {
    const runLoopMock = vi.fn().mockResolvedValue({
      tasksAttempted: 3,
      tasksSucceeded: 2,
      totalRecordsCreated: 5,
      totalCost: 1.23,
      totalDurationMs: 1000,
      results: [],
      stoppedReason: 'completed',
    });
    vi.doMock('./loop.ts', () => ({ runLoop: runLoopMock }));

    const { runFieldTargetedImprove } = await import('./field-improve.ts');
    const result = await runFieldTargetedImprove({
      target: 'divisions.lead_id',
      budgetUsd: 5,
      maxTasks: 10,
      model: 'auto',
    });

    expect(runLoopMock).toHaveBeenCalledTimes(1);
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskTypes: ['division-lead-fill'],
        budgetDollars: 5,
        maxTasks: 10,
        model: 'auto',
      }),
    );
    expect(result.targets).toEqual([
      { table: 'divisions', field: 'lead_id', taskType: 'division-lead-fill' },
    ]);
    expect(result.tasksAttempted).toBe(3);
    expect(result.totalCost).toBe(1.23);
  });

  it('forwards dry-run and skip-sourcing flags to the loop', async () => {
    const runLoopMock = vi.fn().mockResolvedValue({
      tasksAttempted: 0,
      tasksSucceeded: 0,
      totalRecordsCreated: 0,
      totalCost: 0,
      totalDurationMs: 0,
      results: [],
      stoppedReason: 'no_tasks',
    });
    vi.doMock('./loop.ts', () => ({ runLoop: runLoopMock }));

    const { runFieldTargetedImprove } = await import('./field-improve.ts');
    await runFieldTargetedImprove({
      target: 'divisions.lead_id',
      budgetUsd: 1,
      dryRun: true,
      skipSourcing: true,
    });

    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, skipSourcing: true }),
    );
  });
});

describe('runScanReportImprove', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = mkdtempSync(join(tmpdir(), 'field-improve-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('unions task types from all mapped gaps into a single loop filter', async () => {
    const report = {
      timestamp: '2026-04-16T00:00:00Z',
      gaps: [
        { table: 'divisions', field: 'lead_id', nullCount: 100, nullPercent: 50, totalRows: 200 },
        { table: 'funding_programs', field: 'deadline', nullCount: 50, nullPercent: 25, totalRows: 200 },
        { table: 'divisions', field: 'lead_id', nullCount: 100, nullPercent: 50, totalRows: 200 }, // dup
      ],
    };
    const reportPath = join(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));

    const runLoopMock = vi.fn().mockResolvedValue({
      tasksAttempted: 2,
      tasksSucceeded: 2,
      totalRecordsCreated: 4,
      totalCost: 2.5,
      totalDurationMs: 0,
      results: [],
      stoppedReason: 'completed',
    });
    vi.doMock('./loop.ts', () => ({ runLoop: runLoopMock }));

    const { runScanReportImprove } = await import('./field-improve.ts');
    const result = await runScanReportImprove({ reportPath, budgetUsd: 10 });

    expect(runLoopMock).toHaveBeenCalledTimes(1);
    const loopArgs = runLoopMock.mock.calls[0][0];
    // Task type set should dedupe the duplicate divisions.lead_id entry
    expect(new Set(loopArgs.taskTypes)).toEqual(
      new Set(['division-lead-fill', 'funding-program-enrichment']),
    );
    expect(loopArgs.budgetDollars).toBe(10);

    expect(result.targets).toHaveLength(3); // targets preserves order/duplicates
    expect(result.skipped).toHaveLength(0);
  });

  it('records unmapped gaps as skipped but still dispatches mapped ones', async () => {
    const report = {
      gaps: [
        { table: 'divisions', field: 'lead_id', nullCount: 10, nullPercent: 5, totalRows: 200 },
        { table: 'divisions', field: 'mystery_field', nullCount: 100, nullPercent: 50, totalRows: 200 },
      ],
    };
    const reportPath = join(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));

    const runLoopMock = vi.fn().mockResolvedValue({
      tasksAttempted: 1,
      tasksSucceeded: 1,
      totalRecordsCreated: 1,
      totalCost: 0.5,
      totalDurationMs: 0,
      results: [],
      stoppedReason: 'completed',
    });
    vi.doMock('./loop.ts', () => ({ runLoop: runLoopMock }));

    const { runScanReportImprove } = await import('./field-improve.ts');
    const result = await runScanReportImprove({ reportPath, budgetUsd: 5 });

    expect(result.targets).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].field).toBe('mystery_field');
    expect(runLoopMock).toHaveBeenCalledTimes(1);
  });

  it('returns no_mapped_gaps and skips the loop when no gaps are mappable', async () => {
    const report = {
      gaps: [{ table: 'unknown', field: 'x', nullCount: 5, nullPercent: 50, totalRows: 10 }],
    };
    const reportPath = join(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));

    const runLoopMock = vi.fn();
    vi.doMock('./loop.ts', () => ({ runLoop: runLoopMock }));

    const { runScanReportImprove } = await import('./field-improve.ts');
    const result = await runScanReportImprove({ reportPath, budgetUsd: 5 });

    expect(result.stoppedReason).toBe('no_mapped_gaps');
    expect(result.skipped).toHaveLength(1);
    expect(runLoopMock).not.toHaveBeenCalled();
  });

  it('returns no_gaps and skips the loop when report is empty', async () => {
    const reportPath = join(tmpDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify({ gaps: [] }));

    const runLoopMock = vi.fn();
    vi.doMock('./loop.ts', () => ({ runLoop: runLoopMock }));

    const { runScanReportImprove } = await import('./field-improve.ts');
    const result = await runScanReportImprove({ reportPath, budgetUsd: 5 });

    expect(result.stoppedReason).toBe('no_gaps');
    expect(runLoopMock).not.toHaveBeenCalled();
  });
});
