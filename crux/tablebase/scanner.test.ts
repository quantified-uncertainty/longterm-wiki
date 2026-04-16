import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the wiki-server client before importing the scanner module.
vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: vi.fn(),
}));

describe('scanner — field-level completeness (QUA-24)', () => {
  let apiRequest: ReturnType<typeof vi.fn>;

  const orgA = { id: 'open-phil', stableId: 'sid_openphil', entityType: 'organization', title: 'Open Phil', website: 'https://openphil.org' };
  const orgB = { id: 'anthropic', stableId: 'sid_anthropic', entityType: 'organization', title: 'Anthropic', website: 'https://anthropic.com' };
  const modelA = { id: 'claude-4', stableId: 'sid_claude4', entityType: 'ai-model', title: 'Claude 4' };

  beforeEach(async () => {
    const client = await import('../lib/wiki-server/client.ts');
    apiRequest = vi.mocked(client.apiRequest);
    apiRequest.mockReset();
  });

  // ── scanDivisionsLead ───────────────────────────────────────────────────

  it('scanDivisionsLead: computes per-org fill rate and skips inactive divisions', async () => {
    const { runTableScan } = await import('./scanner.ts');
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/divisions/all')) {
        return { ok: true, data: {
          divisions: [
            { id: 'd1', parentOrgId: 'sid_openphil', name: 'Global Health', lead: 'sid_xx', status: 'active' },
            { id: 'd2', parentOrgId: 'sid_openphil', name: 'GCR', lead: null, status: 'active' },
            { id: 'd3', parentOrgId: 'sid_openphil', name: 'Old', lead: null, status: 'dissolved' },
            { id: 'd4', parentOrgId: 'sid_anthropic', name: 'Research', lead: null, status: 'active' },
            { id: 'd5', parentOrgId: 'sid_anthropic', name: 'Policy', lead: null, status: 'active' },
          ],
          total: 5,
        } };
      }
      if (url.startsWith('/api/entities')) {
        return { ok: true, data: { entities: [orgA, orgB], total: 2 } };
      }
      return { ok: false, message: `unexpected ${url}` };
    });

    const result = await runTableScan('divisions');
    expect(result).toBeTruthy();
    expect(result!.table).toBe('divisions');
    expect(result!.profiles).toHaveLength(2);

    const openphil = result!.profiles.find(p => p.entityId === 'sid_openphil')!;
    // 1 with lead, 1 without; dissolved excluded → 1/2 = 50%
    expect(openphil.completenessPercent).toBe(50);
    expect(openphil.totalRecords).toBe(2);
    expect(openphil.missingFields[0]).toContain('1 of 2 divisions missing lead');

    const anthropic = result!.profiles.find(p => p.entityId === 'sid_anthropic')!;
    expect(anthropic.completenessPercent).toBe(0);
    expect(anthropic.missingFields[0]).toContain('2 of 2 divisions missing lead');
  });

  it('scanDivisionsLead: orgs with no divisions are excluded from profiles', async () => {
    const { runTableScan } = await import('./scanner.ts');
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/divisions/all')) {
        return { ok: true, data: { divisions: [], total: 0 } };
      }
      if (url.startsWith('/api/entities')) {
        return { ok: true, data: { entities: [orgA, orgB], total: 2 } };
      }
      return { ok: false, message: `unexpected ${url}` };
    });

    const result = await runTableScan('divisions');
    expect(result!.profiles).toHaveLength(0);
    expect(result!.avgCompleteness).toBe(100); // no profiles = nothing to enrich
  });

  // ── scanDivisionPersonnelDates ─────────────────────────────────────────

  it('scanDivisionPersonnelDates: joins personnel via divisionId → parentOrgId and scores on startDate', async () => {
    const { runTableScan } = await import('./scanner.ts');
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/divisions/all')) {
        return { ok: true, data: {
          divisions: [
            { id: 'div1', parentOrgId: 'sid_openphil', name: 'GH', lead: null, status: 'active' },
            { id: 'div2', parentOrgId: 'sid_anthropic', name: 'Research', lead: null, status: 'active' },
          ],
          total: 2,
        } };
      }
      if (url.startsWith('/api/division-personnel/all')) {
        return { ok: true, data: {
          divisionPersonnel: [
            { id: 'p1', divisionId: 'div1', personId: 'sid_a', role: 'Lead', startDate: '2023-01', endDate: null },
            { id: 'p2', divisionId: 'div1', personId: 'sid_b', role: 'Analyst', startDate: null, endDate: null },
            { id: 'p3', divisionId: 'div2', personId: 'sid_c', role: 'Researcher', startDate: null, endDate: null },
            { id: 'p4', divisionId: 'div2', personId: 'sid_d', role: 'Director', startDate: null, endDate: null },
            // Orphan row (divisionId not in divisions map) should be ignored
            { id: 'p5', divisionId: 'ghost', personId: 'sid_e', role: 'Ghost', startDate: null, endDate: null },
          ],
          total: 5,
        } };
      }
      if (url.startsWith('/api/entities')) {
        return { ok: true, data: { entities: [orgA, orgB], total: 2 } };
      }
      return { ok: false, message: `unexpected ${url}` };
    });

    const result = await runTableScan('division_personnel');
    expect(result!.profiles).toHaveLength(2);
    const openphil = result!.profiles.find(p => p.entityId === 'sid_openphil')!;
    // 1 of 2 has startDate
    expect(openphil.completenessPercent).toBe(50);
    expect(openphil.totalRecords).toBe(2);

    const anthropic = result!.profiles.find(p => p.entityId === 'sid_anthropic')!;
    expect(anthropic.completenessPercent).toBe(0);
    expect(anthropic.missingFields[0]).toContain('2 of 2 division personnel missing startDate');
  });

  // ── scanFundingProgramFields ───────────────────────────────────────────

  it('scanFundingProgramFields: weights totalBudget always, deadline/URL only for open programs', async () => {
    const { runTableScan } = await import('./scanner.ts');
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/funding-programs/all')) {
        return { ok: true, data: {
          fundingPrograms: [
            // Open, fully filled → 3/3 slots filled
            { id: 'fp1', orgId: 'sid_openphil', name: 'RFP1', totalBudget: 1000000, applicationUrl: 'https://x.org', deadline: '2026-06-01', status: 'open' },
            // Open, missing deadline + url → 1/3 slots filled
            { id: 'fp2', orgId: 'sid_openphil', name: 'RFP2', totalBudget: 500000, applicationUrl: null, deadline: null, status: 'open' },
            // Closed, missing budget → 0/1 slots (deadline/url not scored for closed)
            { id: 'fp3', orgId: 'sid_anthropic', name: 'Closed Grant', totalBudget: null, applicationUrl: null, deadline: null, status: 'closed' },
            // Awarded program with budget but no deadline/url → should be treated as inactive: 1 slot, 1 filled
            { id: 'fp4', orgId: 'sid_anthropic', name: 'Awarded Fellowship', totalBudget: 250000, applicationUrl: null, deadline: null, status: 'awarded' },
          ],
          total: 4,
        } };
      }
      if (url.startsWith('/api/entities')) {
        return { ok: true, data: { entities: [orgA, orgB], total: 2 } };
      }
      return { ok: false, message: `unexpected ${url}` };
    });

    const result = await runTableScan('funding_programs');
    const openphil = result!.profiles.find(p => p.entityId === 'sid_openphil')!;
    // slots: fp1=3, fp2=3 → 6 slots; filled: fp1=3, fp2=1 → 4 filled → 67%
    expect(openphil.completenessPercent).toBe(67);
    expect(openphil.missingFields.some(m => m.includes('active programs missing deadline'))).toBe(true);
    expect(openphil.missingFields.some(m => m.includes('active programs missing applicationUrl'))).toBe(true);

    const anthropic = result!.profiles.find(p => p.entityId === 'sid_anthropic')!;
    // fp3 closed: 1 slot, 0 filled; fp4 awarded: 1 slot, 1 filled → 1/2 = 50%
    expect(anthropic.completenessPercent).toBe(50);
    expect(anthropic.missingFields[0]).toContain('1 programs missing totalBudget');
    // deadline/url should NOT appear in missing for closed/awarded programs
    expect(anthropic.missingFields.some(m => m.includes('missing deadline'))).toBe(false);
    expect(anthropic.missingFields.some(m => m.includes('missing applicationUrl'))).toBe(false);
  });

  // ── scanBenchmarkResultSources ─────────────────────────────────────────

  it('scanBenchmarkResultSources: scores per model by sourceUrl fill rate', async () => {
    const { runTableScan } = await import('./scanner.ts');
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/benchmark-results/all')) {
        return { ok: true, data: {
          benchmarkResults: [
            { id: 'br1', benchmarkId: 'mmlu', modelId: 'sid_claude4', score: 88.5, sourceUrl: 'https://anthropic.com/card' },
            { id: 'br2', benchmarkId: 'gpqa', modelId: 'sid_claude4', score: 70, sourceUrl: null },
            { id: 'br3', benchmarkId: 'humaneval', modelId: 'sid_claude4', score: 92, sourceUrl: '   ' }, // whitespace-only counts as missing
          ],
          total: 3,
        } };
      }
      if (url.startsWith('/api/entities')) {
        return { ok: true, data: { entities: [modelA], total: 1 } };
      }
      return { ok: false, message: `unexpected ${url}` };
    });

    const result = await runTableScan('benchmark_result_sources');
    expect(result!.profiles).toHaveLength(1);
    const p = result!.profiles[0];
    // 1 of 3 has a non-empty sourceUrl
    expect(p.completenessPercent).toBe(33);
    expect(p.missingFields[0]).toContain('2 of 3 benchmark results missing sourceUrl');
  });

  // ── ranker integration ────────────────────────────────────────────────

  it('task-ranker emits the new task types for the new tables', async () => {
    const { rankTasks } = await import('./task-ranker.ts');
    const scan = {
      tables: [
        {
          table: 'divisions', totalEntities: 1, entitiesWithRecords: 1, totalRecords: 2, avgCompleteness: 50,
          profiles: [{ entityId: 'sid_o', entityName: 'O', entityType: 'organization', table: 'divisions', totalRecords: 2, completenessPercent: 50, missingFields: ['1 of 2 divisions missing lead'] }],
        },
        {
          table: 'division_personnel', totalEntities: 1, entitiesWithRecords: 1, totalRecords: 5, avgCompleteness: 20,
          profiles: [{ entityId: 'sid_o', entityName: 'O', entityType: 'organization', table: 'division_personnel', totalRecords: 5, completenessPercent: 20, missingFields: ['4 of 5 division personnel missing startDate'] }],
        },
        {
          table: 'funding_programs', totalEntities: 1, entitiesWithRecords: 1, totalRecords: 3, avgCompleteness: 33,
          profiles: [{ entityId: 'sid_o', entityName: 'O', entityType: 'organization', table: 'funding_programs', totalRecords: 3, completenessPercent: 33, missingFields: ['2 programs missing totalBudget'] }],
        },
        {
          table: 'benchmark_result_sources', totalEntities: 1, entitiesWithRecords: 1, totalRecords: 10, avgCompleteness: 40,
          profiles: [{ entityId: 'sid_m', entityName: 'M', entityType: 'ai-model', table: 'benchmark_result_sources', totalRecords: 10, completenessPercent: 40, missingFields: ['6 of 10 benchmark results missing sourceUrl'] }],
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const tasks = rankTasks(scan, { excludeIds: new Set() });
    const byType = new Set(tasks.map(t => t.taskType));
    expect(byType.has('division-lead-fill')).toBe(true);
    expect(byType.has('division-personnel-dates')).toBe(true);
    expect(byType.has('funding-program-enrichment')).toBe(true);
    expect(byType.has('benchmark-source-fill')).toBe(true);
    expect(tasks.length).toBe(4);
  });
});

describe('scanner — field-gap profiler (QUA-551)', () => {
  let apiRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const client = await import('../lib/wiki-server/client.ts');
    apiRequest = vi.mocked(client.apiRequest);
    apiRequest.mockReset();
  });

  it('profileFields: counts null / empty / "n/a" correctly and reports percentages', async () => {
    const { profileFields } = await import('./scanner.ts');
    const rows = [
      { id: 'd1', lead: 'sid_a', status: 'active', startDate: '2023-01', notes: 'ok' },
      { id: 'd2', lead: null, status: 'active', startDate: null, notes: '' },
      { id: 'd3', lead: '', status: 'inactive', startDate: 'N/A', notes: '  ' }, // empty lead, n/a startDate, whitespace notes
      { id: 'd4', lead: '   ', status: null, startDate: null, notes: 'n/a' },     // whitespace = empty lead, n/a notes
      { id: 'd5', lead: 'sid_b', status: 'active', startDate: '2024-06', notes: null },
    ];
    const report = profileFields('divisions', rows, [
      { field: 'lead', columnType: 'id' },
      { field: 'status', columnType: 'enum' },
      { field: 'startDate', columnType: 'date' },
      { field: 'notes', columnType: 'string' },
    ]);

    expect(report.table).toBe('divisions');
    expect(report.totalRows).toBe(5);

    const lead = report.fields.find(f => f.field === 'lead')!;
    expect(lead.nullCount).toBe(1);
    expect(lead.emptyCount).toBe(2); // "" and "   " both count as empty
    expect(lead.naCount).toBe(0);
    expect(lead.nullPct).toBe(20); // 1/5
    expect(lead.emptyPct).toBe(40); // 2/5
    expect(lead.gapPct).toBe(60);

    const startDate = report.fields.find(f => f.field === 'startDate')!;
    expect(startDate.nullCount).toBe(2);
    expect(startDate.naCount).toBe(1); // "N/A" matches case-insensitively
    expect(startDate.gapPct).toBe(60);

    const notes = report.fields.find(f => f.field === 'notes')!;
    expect(notes.nullCount).toBe(1);
    expect(notes.emptyCount).toBe(2); // "" and "  "
    expect(notes.naCount).toBe(1); // "n/a"
    expect(notes.gapPct).toBe(80);

    const status = report.fields.find(f => f.field === 'status')!;
    expect(status.nullCount).toBe(1);
    expect(status.gapPct).toBe(20);
  });

  it('profileFields: sorts fields by gapPct descending and caps sample rows at 3', async () => {
    const { profileFields } = await import('./scanner.ts');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      a: null,          // 100% null
      b: i < 5 ? null : 'x', // 50% null
      c: 'always',      // 0% gap
    }));
    const report = profileFields('t', rows, [
      { field: 'c', columnType: 'string' },
      { field: 'a', columnType: 'string' },
      { field: 'b', columnType: 'string' },
    ]);

    // Sorted by gap desc: a (100), b (50), c (0)
    expect(report.fields.map(f => f.field)).toEqual(['a', 'b', 'c']);
    const a = report.fields[0];
    expect(a.nullPct).toBe(100);
    expect(a.sampleMissingRows).toEqual(['r0', 'r1', 'r2']); // capped at 3
    expect(a.sampleMissingRows.length).toBe(3);
  });

  it('profileFields: treats numeric 0 and boolean false as filled, not empty', async () => {
    const { profileFields } = await import('./scanner.ts');
    const rows = [
      { id: 'r1', score: 0, flag: false },
      { id: 'r2', score: null, flag: null },
    ];
    const report = profileFields('t', rows, [
      { field: 'score', columnType: 'number' },
      { field: 'flag', columnType: 'boolean' },
    ]);
    const score = report.fields.find(f => f.field === 'score')!;
    expect(score.nullCount).toBe(1);
    expect(score.emptyCount).toBe(0);
    expect(score.gapPct).toBe(50);

    const flag = report.fields.find(f => f.field === 'flag')!;
    expect(flag.nullCount).toBe(1);
    expect(flag.emptyCount).toBe(0);
  });

  it('profileFields: empty row list yields 0 totalRows and 0% gaps', async () => {
    const { profileFields } = await import('./scanner.ts');
    const report = profileFields('t', [], [{ field: 'x', columnType: 'string' }]);
    expect(report.totalRows).toBe(0);
    expect(report.fields[0].gapPct).toBe(0);
    expect(report.fields[0].total).toBe(0);
  });

  it('runFieldGapScan: fetches all 4 tables and returns per-table reports', async () => {
    const { runFieldGapScan } = await import('./scanner.ts');

    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/divisions/all')) {
        return { ok: true, data: {
          divisions: [
            { id: 'd1', parentOrgId: 'o1', name: 'A', divisionType: 'lab', lead: 'sid_x', status: 'active', startDate: null, endDate: null, website: null, source: null, notes: null },
            { id: 'd2', parentOrgId: 'o1', name: 'B', divisionType: null, lead: null, status: 'active', startDate: null, endDate: null, website: null, source: null, notes: null },
          ],
          total: 2,
        } };
      }
      if (url.startsWith('/api/division-personnel/all')) {
        return { ok: true, data: { divisionPersonnel: [{ id: 'p1', divisionId: 'd1', personId: 'sid_p', role: 'Lead', startDate: '2023', endDate: null, source: null, notes: null }], total: 1 } };
      }
      if (url.startsWith('/api/funding-programs/all')) {
        return { ok: true, data: { fundingPrograms: [{ id: 'fp1', orgId: 'o1', divisionId: null, name: 'RFP', description: 'Desc', programType: 'rfp', totalBudget: 100, currency: 'USD', applicationUrl: 'https://x', openDate: null, deadline: null, status: 'open', source: null, notes: null }], total: 1 } };
      }
      if (url.startsWith('/api/benchmark-results/all')) {
        return { ok: true, data: { benchmarkResults: [{ id: 'br1', benchmarkId: 'mmlu', modelId: 'm1', score: 90, unit: '%', date: '2024', sourceUrl: null, notes: null }], total: 1 } };
      }
      return { ok: false, message: `unexpected ${url}` };
    });

    const reports = await runFieldGapScan();
    expect(reports.length).toBe(4);
    const byTable = Object.fromEntries(reports.map(r => [r.table, r]));
    expect(byTable.divisions.totalRows).toBe(2);
    expect(byTable.division_personnel.totalRows).toBe(1);
    expect(byTable.funding_programs.totalRows).toBe(1);
    expect(byTable.benchmark_results.totalRows).toBe(1);

    // divisions: divisionType is 50% null, lead is 50% null
    const divType = byTable.divisions.fields.find(f => f.field === 'divisionType')!;
    expect(divType.nullPct).toBe(50);
  });

  it('runFieldGapScan: filters to a single table when passed', async () => {
    const { runFieldGapScan } = await import('./scanner.ts');
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/benchmark-results/all')) {
        return { ok: true, data: { benchmarkResults: [{ id: 'br1', benchmarkId: 'b', modelId: 'm', score: null, unit: null, date: null, sourceUrl: null, notes: null }], total: 1 } };
      }
      return { ok: false, message: `should not call ${url}` };
    });

    const reports = await runFieldGapScan(['benchmark_results']);
    expect(reports.length).toBe(1);
    expect(reports[0].table).toBe('benchmark_results');
    // score, unit, date, sourceUrl, notes all 100% null
    for (const f of reports[0].fields) {
      expect(f.nullPct).toBe(100);
      expect(f.gapPct).toBe(100);
    }
  });
});
