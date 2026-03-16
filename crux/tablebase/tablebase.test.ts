import { describe, it, expect, vi } from 'vitest';
import type { ScanSummary, EnrichmentTask, TableProfile } from './types.ts';
import { TASK_TYPE_WEIGHTS } from './types.ts';

// ---------------------------------------------------------------------------
// Task Ranker Tests
// ---------------------------------------------------------------------------

describe('task-ranker', () => {
  // Dynamic import to avoid module-level side effects
  async function importRanker() {
    return import('./task-ranker.ts');
  }

  const makeScan = (profiles: TableProfile[]): ScanSummary => ({
    tables: [{
      table: 'personnel',
      totalEntities: profiles.length,
      entitiesWithRecords: profiles.filter(p => p.totalRecords > 0).length,
      totalRecords: profiles.reduce((s, p) => s + p.totalRecords, 0),
      avgCompleteness: profiles.length > 0
        ? Math.round(profiles.reduce((s, p) => s + p.completenessPercent, 0) / profiles.length)
        : 0,
      profiles,
    }],
    timestamp: new Date().toISOString(),
  });

  it('ranks tasks by impact score descending', async () => {
    const { rankTasks } = await importRanker();

    const scan = makeScan([
      {
        entityId: 'org-a', entityName: 'Org A', entityType: 'organization',
        table: 'personnel', totalRecords: 0, completenessPercent: 0, missingFields: ['no personnel'],
      },
      {
        entityId: 'org-b', entityName: 'Org B', entityType: 'organization',
        table: 'personnel', totalRecords: 3, completenessPercent: 60, missingFields: ['only 3 records'],
      },
    ]);

    const tasks = rankTasks(scan, { excludeIds: new Set() });
    expect(tasks.length).toBe(2);
    expect(tasks[0].impactScore).toBeGreaterThan(tasks[1].impactScore);
    expect(tasks[0].entityId).toBe('org-a'); // 0% complete = higher impact
  });

  it('excludes completed tasks', async () => {
    const { rankTasks } = await importRanker();

    const scan = makeScan([
      {
        entityId: 'org-a', entityName: 'Org A', entityType: 'organization',
        table: 'personnel', totalRecords: 0, completenessPercent: 0, missingFields: ['no personnel'],
      },
    ]);

    const tasks = rankTasks(scan, { excludeIds: new Set() });
    expect(tasks.length).toBe(1);

    // Now exclude that task
    const excludeIds = new Set([tasks[0].id]);
    const filtered = rankTasks(scan, { excludeIds });
    expect(filtered.length).toBe(0);
  });

  it('filters by task type', async () => {
    const { rankTasks } = await importRanker();

    const scan: ScanSummary = {
      tables: [
        {
          table: 'personnel', totalEntities: 1, entitiesWithRecords: 0, totalRecords: 0, avgCompleteness: 0,
          profiles: [{
            entityId: 'org-a', entityName: 'Org A', entityType: 'organization',
            table: 'personnel', totalRecords: 0, completenessPercent: 0, missingFields: [],
          }],
        },
        {
          table: 'grants', totalEntities: 1, entitiesWithRecords: 1, totalRecords: 10, avgCompleteness: 50,
          profiles: [{
            entityId: 'org-a', entityName: 'Org A', entityType: 'organization',
            table: 'grants', totalRecords: 10, completenessPercent: 50, missingFields: ['5 grants missing granteeId'],
          }],
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const personnelOnly = rankTasks(scan, { excludeIds: new Set(), taskTypes: ['personnel-enrichment'] });
    expect(personnelOnly.every(t => t.taskType === 'personnel-enrichment')).toBe(true);

    const grantOnly = rankTasks(scan, { excludeIds: new Set(), taskTypes: ['grant-grantee-backfill'] });
    expect(grantOnly.every(t => t.taskType === 'grant-grantee-backfill')).toBe(true);
  });

  it('skips fully complete entities', async () => {
    const { rankTasks } = await importRanker();

    const scan = makeScan([
      {
        entityId: 'org-a', entityName: 'Org A', entityType: 'organization',
        table: 'personnel', totalRecords: 10, completenessPercent: 100, missingFields: [],
      },
    ]);

    const tasks = rankTasks(scan, { excludeIds: new Set() });
    expect(tasks.length).toBe(0);
  });

  it('applies task type weights correctly', async () => {
    const { rankTasks } = await importRanker();

    // personnel weight = 1.5, grants weight = 1.2
    // Same gap (50%) but different weights should produce different scores
    const scan: ScanSummary = {
      tables: [
        {
          table: 'personnel', totalEntities: 1, entitiesWithRecords: 0, totalRecords: 0, avgCompleteness: 50,
          profiles: [{
            entityId: 'org-a', entityName: 'Org A', entityType: 'organization',
            table: 'personnel', totalRecords: 2, completenessPercent: 50, missingFields: [],
          }],
        },
        {
          table: 'grants', totalEntities: 1, entitiesWithRecords: 1, totalRecords: 10, avgCompleteness: 50,
          profiles: [{
            entityId: 'org-a', entityName: 'Org A', entityType: 'organization',
            table: 'grants', totalRecords: 10, completenessPercent: 50, missingFields: [],
          }],
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const tasks = rankTasks(scan, { excludeIds: new Set() });
    const personnelTask = tasks.find(t => t.taskType === 'personnel-enrichment');
    const grantTask = tasks.find(t => t.taskType === 'grant-grantee-backfill');

    expect(personnelTask).toBeDefined();
    expect(grantTask).toBeDefined();
    // Same gap, personnel should have higher impact due to 1.5x vs 1.2x weight
    expect(personnelTask!.impactScore).toBeGreaterThan(grantTask!.impactScore);
  });
});

// ---------------------------------------------------------------------------
// Types Tests
// ---------------------------------------------------------------------------

describe('types', () => {
  it('TASK_TYPE_WEIGHTS covers all task types', async () => {
    const { TASK_TYPES, TASK_TYPE_WEIGHTS: weights } = await import('./types.ts');
    for (const tt of TASK_TYPES) {
      expect(weights[tt]).toBeDefined();
      expect(typeof weights[tt]).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Reporter Tests
// ---------------------------------------------------------------------------

describe('reporter', () => {
  it('formatScanSummary includes table names', async () => {
    const { formatScanSummary } = await import('./reporter.ts');

    const scan: ScanSummary = {
      tables: [{
        table: 'personnel',
        totalEntities: 10,
        entitiesWithRecords: 5,
        totalRecords: 25,
        avgCompleteness: 50,
        profiles: [],
      }],
      timestamp: '2026-01-01T00:00:00Z',
    };

    const output = formatScanSummary(scan);
    expect(output).toContain('personnel');
    expect(output).toContain('25'); // total records
  });

  it('formatGaps shows task IDs and types', async () => {
    const { formatGaps } = await import('./reporter.ts');

    const tasks: EnrichmentTask[] = [{
      id: 'abc123',
      taskType: 'personnel-enrichment',
      entityId: 'org-a',
      entityName: 'Test Org',
      entityType: 'organization',
      table: 'personnel',
      impactScore: 100,
      reasons: ['no personnel records'],
      existingRecordCount: 0,
    }];

    const output = formatGaps(tasks);
    expect(output).toContain('abc123');
    expect(output).toContain('personnel-enrichment');
    expect(output).toContain('Test Org');
  });
});
