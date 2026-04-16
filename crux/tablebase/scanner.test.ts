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

  // Minimal fake for fetchAllPaginated: returns all rows in a single page.
  function mockEndpoint(path: string, resultKey: string, rows: unknown[]) {
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (!url.startsWith(path)) return { ok: false, message: `unexpected ${url}` };
      // fetchAllPaginated asks for limit=200 and expects a `total`.
      return { ok: true, data: { [resultKey]: rows, total: rows.length } };
    });
  }

  // Route-aware mock for scanners that need multiple endpoints.
  function mockRoutes(routes: Record<string, unknown[]>, entitiesByType?: Record<string, unknown[]>) {
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      for (const [path, rows] of Object.entries(routes)) {
        if (url.startsWith(path)) {
          // Infer the resultKey from the path (tests pass the full response shape elsewhere)
          const resultKey = path.includes('/divisions/all') ? 'divisions'
            : path.includes('/division-personnel/all') ? 'divisionPersonnel'
            : path.includes('/funding-programs/all') ? 'fundingPrograms'
            : path.includes('/benchmark-results/all') ? 'benchmarkResults'
            : 'items';
          return { ok: true, data: { [resultKey]: rows, total: rows.length } };
        }
      }
      if (entitiesByType && url.startsWith('/api/entities')) {
        const match = url.match(/entityType=([^&]+)/);
        const type = match ? decodeURIComponent(match[1]) : '';
        return { ok: true, data: { entities: entitiesByType[type] ?? [], total: (entitiesByType[type] ?? []).length } };
      }
      return { ok: false, message: `unexpected ${url}` };
    });
  }

  beforeEach(async () => {
    const client = await import('../lib/wiki-server/client.ts');
    apiRequest = vi.mocked(client.apiRequest);
    apiRequest.mockReset();
  });

  // ── scanDivisionsLead ───────────────────────────────────────────────────

  it('scanDivisionsLead: computes per-org fill rate and skips inactive divisions', async () => {
    mockEndpoint('/api/divisions/all', 'divisions', [
      { id: 'd1', parentOrgId: 'sid_openphil', name: 'Global Health', lead: 'sid_xx', status: 'active' },
      { id: 'd2', parentOrgId: 'sid_openphil', name: 'GCR', lead: null, status: 'active' },
      { id: 'd3', parentOrgId: 'sid_openphil', name: 'Old Program', lead: null, status: 'dissolved' }, // skipped
      { id: 'd4', parentOrgId: 'sid_anthropic', name: 'Research', lead: null, status: 'active' },
      { id: 'd5', parentOrgId: 'sid_anthropic', name: 'Policy', lead: null, status: 'active' },
    ]);

    const { runTableScan } = await import('./scanner.ts');
    // runTableScan('divisions') calls fetchEntitiesByType in-line; stub that too.
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

  it('scanFundingProgramFields: weights totalBudget always, deadline/URL only for active programs', async () => {
    const { runTableScan } = await import('./scanner.ts');
    apiRequest.mockImplementation(async (_method: string, url: string) => {
      if (url.startsWith('/api/funding-programs/all')) {
        return { ok: true, data: {
          fundingPrograms: [
            // Active, fully filled → 3/3 slots filled
            { id: 'fp1', orgId: 'sid_openphil', name: 'RFP1', totalBudget: 1000000, applicationUrl: 'https://x.org', deadline: '2026-06-01', status: 'open' },
            // Active, missing deadline + url → 1/3 slots filled
            { id: 'fp2', orgId: 'sid_openphil', name: 'RFP2', totalBudget: 500000, applicationUrl: null, deadline: null, status: 'open' },
            // Closed, missing budget → 0/1 slots (deadline/url not scored for closed)
            { id: 'fp3', orgId: 'sid_anthropic', name: 'Closed Grant', totalBudget: null, applicationUrl: null, deadline: null, status: 'closed' },
          ],
          total: 3,
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
    // closed program: 1 slot (budget only), 0 filled → 0%
    expect(anthropic.completenessPercent).toBe(0);
    expect(anthropic.missingFields[0]).toContain('1 programs missing totalBudget');
    // deadline/url should NOT appear in missing for closed programs
    expect(anthropic.missingFields.some(m => m.includes('missing deadline'))).toBe(false);
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
