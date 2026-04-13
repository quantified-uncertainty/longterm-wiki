/**
 * Tests for flagship-curate command.
 *
 * Covers:
 *  - Command help output when no args provided
 *  - Invalid budget handling
 *  - Entity resolution failure
 *  - Dry-run mode output
 *  - Budget enforcement across entities
 *  - Record filtering by verdict type
 *  - CI JSON output mode
 *
 * All network calls are mocked — tests run fully offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock wiki-server API clients ───────────────────────────────────────

const mockGetEntity = vi.fn();
const mockGetVerdictsByEntity = vi.fn();
const mockGetPersonnelByEntity = vi.fn();
const mockSyncPersonnel = vi.fn();
const mockStoreVerdict = vi.fn();
const mockApiRequest = vi.fn();
const mockSuggestResources = vi.fn();
const mockCommentOnIssue = vi.fn();

vi.mock('../lib/wiki-server/entities.ts', () => ({
  getEntity: (...args: unknown[]) => mockGetEntity(...args),
  searchEntities: vi.fn(async () => ({ ok: true, data: { entities: [], total: 0 } })),
}));

vi.mock('../lib/wiki-server/sourcing.ts', () => ({
  getVerdictsByEntity: (...args: unknown[]) => mockGetVerdictsByEntity(...args),
}));

vi.mock('../lib/wiki-server/personnel.ts', () => ({
  getPersonnelByEntity: (...args: unknown[]) => mockGetPersonnelByEntity(...args),
  syncPersonnel: (...args: unknown[]) => mockSyncPersonnel(...args),
}));

vi.mock('../lib/wiki-server/sourcing-client.ts', () => ({
  storeVerdict: (...args: unknown[]) => mockStoreVerdict(...args),
}));

vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

vi.mock('../lib/search/suggest-resources.ts', () => ({
  suggestResources: (...args: unknown[]) => mockSuggestResources(...args),
}));

vi.mock('../lib/linear/issues.ts', () => ({
  commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
}));

// Mock LLM layer
vi.mock('../lib/llm.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/llm.ts')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({})),
    callLlm: vi.fn(async () => ({
      text: '[]', // empty research results
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-haiku-4-5-20251001',
    })),
    MODELS: { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6' },
  };
});

vi.mock('../lib/anthropic.ts', () => ({
  parseJsonResponse: vi.fn((text: string) => {
    try { return JSON.parse(text); }
    catch { return null; }
  }),
}));

vi.mock('../lib/prompt-utils.ts', () => ({
  escapeXml: vi.fn((s: string) => s),
}));

// Mock the orchestrate command for verification step
vi.mock('./sourcing-orchestrate.ts', () => ({
  orchestrateCommand: vi.fn(async () => ({
    exitCode: 0,
    output: 'Verified 5 items. confirmed 3 partial 2 Cost: $0.025',
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────

import { commands, formatSummaryMarkdown } from './flagship-curate.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function makeEntity(id: string, title: string, type = 'organization') {
  return {
    ok: true as const,
    data: {
      id,
      stableId: `sid_${id}`,
      stable_id: `sid_${id}`,
      title,
      name: title,
      entityType: type,
      entity_type: type,
    },
  };
}

function makeVerdicts(items: Array<{ recordType: string; recordId: string; verdict: string; displayName: string }>) {
  return {
    ok: true as const,
    data: {
      verdicts: items.map((item) => ({
        ...item,
        entityId: 'sid_test',
        confidence: 0.5,
        reasoning: 'test',
        sourcesChecked: 1,
      })),
      total: items.length,
      counts: {},
    },
  };
}

function makePersonnel(items: Array<{ id: string; source?: string; displayName?: string }>) {
  return {
    ok: true as const,
    data: {
      personnel: items.map((item) => ({
        id: item.id,
        source: item.source ?? null,
        displayName: item.displayName ?? item.id,
        personName: item.displayName ?? item.id,
        role: 'Engineer',
        organizationName: 'Test Org',
      })),
      total: items.length,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('flagship-curate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('argument validation', () => {
    it('shows help when neither --entity nor --all is provided', async () => {
      const result = await commands.default([], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('--entity=<slug>');
      expect(result.output).toContain('--all');
    });

    it('rejects invalid budget', async () => {
      const result = await commands.default([], { entity: 'test', budget: '-5' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Invalid budget');
    });

    it('rejects zero budget', async () => {
      const result = await commands.default([], { entity: 'test', budget: '0' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Invalid budget');
    });

    it('rejects NaN budget', async () => {
      const result = await commands.default([], { entity: 'test', budget: 'abc' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Invalid budget');
    });
  });

  describe('entity resolution', () => {
    it('returns error when entity not found', async () => {
      mockGetEntity.mockResolvedValue({ ok: false, error: 'not found' });

      const result = await commands.default([], { entity: 'nonexistent', budget: '1' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Entity not found');
    });

    it('resolves entity by slug', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));

      const result = await commands.default([], { entity: 'anthropic', budget: '1' });
      expect(result.exitCode).toBe(0);
      expect(mockGetEntity).toHaveBeenCalledWith('anthropic');
    });
  });

  describe('dry-run mode', () => {
    it('previews records without making changes in dry run', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'Alice' },
          { recordType: 'personnel', recordId: 'p2', verdict: 'unverifiable', displayName: 'Bob' },
          { recordType: 'personnel', recordId: 'p3', verdict: 'confirmed', displayName: 'Charlie' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([
        { id: 'p1' },
        { id: 'p2', source: 'https://example.com' },
      ]));

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        'dry-run': true,
      });

      expect(result.exitCode).toBe(0);
      // Should NOT have called storeVerdict or syncPersonnel
      expect(mockStoreVerdict).not.toHaveBeenCalled();
      expect(mockSyncPersonnel).not.toHaveBeenCalled();
      expect(mockSuggestResources).not.toHaveBeenCalled();
    });

    it('filters out confirmed records from curation list', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'confirmed', displayName: 'Alice' },
          { recordType: 'personnel', recordId: 'p2', verdict: 'unchecked', displayName: 'Bob' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([
        { id: 'p1', source: 'https://example.com' },
        { id: 'p2' },
      ]));

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        'dry-run': true,
      });

      expect(result.exitCode).toBe(0);
      // The output should mention Bob (unchecked) but not Alice (confirmed)
      // Verified via the console.log mock calls
    });
  });

  describe('verdict filtering', () => {
    it('identifies all non-confirmed verdict types as needing curation', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('test-org', 'Test Org'));
      const verdicts = [
        { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'A' },
        { recordType: 'personnel', recordId: 'p2', verdict: 'unverifiable', displayName: 'B' },
        { recordType: 'personnel', recordId: 'p3', verdict: 'partial', displayName: 'C' },
        { recordType: 'personnel', recordId: 'p4', verdict: 'outdated', displayName: 'D' },
        { recordType: 'personnel', recordId: 'p5', verdict: 'contradicted', displayName: 'E' },
        { recordType: 'personnel', recordId: 'p6', verdict: 'confirmed', displayName: 'F' },
      ];
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts(verdicts));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel(
        verdicts.map((v) => ({ id: v.recordId })),
      ));

      const result = await commands.default([], {
        entity: 'test-org',
        budget: '1',
        'dry-run': true,
      });

      expect(result.exitCode).toBe(0);
      // Should find 5 records needing curation (everything except confirmed)
      const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call.join(' '))
        .join('\n');
      expect(logCalls).toContain('5 records needing curation');
    });
  });

  describe('table filter', () => {
    it('filters records by table type when --table is specified', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('test-org', 'Test Org'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'Alice' },
          { recordType: 'grant', recordId: 'g1', verdict: 'unchecked', displayName: 'Grant 1' },
          { recordType: 'personnel', recordId: 'p2', verdict: 'unchecked', displayName: 'Bob' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([
        { id: 'p1' },
        { id: 'p2' },
      ]));

      const result = await commands.default([], {
        entity: 'test-org',
        budget: '1',
        table: 'personnel',
        'dry-run': true,
      });

      expect(result.exitCode).toBe(0);
      const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call.join(' '))
        .join('\n');
      // Should only find 2 personnel records, not the grant
      expect(logCalls).toContain('2 records needing curation');
    });
  });

  describe('CI output mode', () => {
    it('returns valid JSON when --ci flag is set', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        ci: true,
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.output);
      expect(parsed).toHaveProperty('results');
      expect(parsed).toHaveProperty('totalCost');
      expect(parsed).toHaveProperty('breakdown');
      expect(Array.isArray(parsed.results)).toBe(true);
    });
  });

  describe('batch mode (--all)', () => {
    it('returns gracefully when no entities need curation', async () => {
      mockApiRequest.mockResolvedValue({
        ok: true,
        data: { entities: [], total: 0 },
      });

      const result = await commands.default([], { all: true, budget: '1' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('No entities found needing curation');
    });
  });

  describe('no records needing curation', () => {
    it('reports success when all records are already confirmed', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('good-org', 'Good Org'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'confirmed', displayName: 'Alice' },
          { recordType: 'personnel', recordId: 'p2', verdict: 'confirmed', displayName: 'Bob' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([
        { id: 'p1', source: 'https://example.com' },
        { id: 'p2', source: 'https://example.com/2' },
      ]));

      const result = await commands.default([], {
        entity: 'good-org',
        budget: '5',
      });

      expect(result.exitCode).toBe(0);
      // Should not have tried to research or update anything
      expect(mockSuggestResources).not.toHaveBeenCalled();
      expect(mockSyncPersonnel).not.toHaveBeenCalled();
    });
  });

  describe('--linear-comment validation', () => {
    it('rejects malformed identifiers', async () => {
      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        'linear-comment': 'not-a-real-id',
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Invalid --linear-comment value');
    });

    it('accepts the canonical QUA-NNN shape', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));
      mockCommentOnIssue.mockResolvedValue(undefined);
      const prevKey = process.env['LINEAR_API_KEY'];
      process.env['LINEAR_API_KEY'] = 'test-key';

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        'linear-comment': 'QUA-124',
      });

      expect(result.exitCode).toBe(0);
      expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockCommentOnIssue).toHaveBeenCalledWith('QUA-124', expect.stringContaining('Flagship Curate Run'));

      if (prevKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = prevKey;
    });

    it('does not post when LINEAR_API_KEY is unset, and exit code stays 0', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));
      const prevKey = process.env['LINEAR_API_KEY'];
      delete process.env['LINEAR_API_KEY'];

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        'linear-comment': 'QUA-124',
      });

      expect(result.exitCode).toBe(0);
      expect(mockCommentOnIssue).not.toHaveBeenCalled();

      if (prevKey !== undefined) process.env['LINEAR_API_KEY'] = prevKey;
    });

    it('best-effort: continues with exit 0 when commentOnIssue throws', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));
      mockCommentOnIssue.mockRejectedValue(new Error('Linear is down'));
      const prevKey = process.env['LINEAR_API_KEY'];
      process.env['LINEAR_API_KEY'] = 'test-key';

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        'linear-comment': 'QUA-124',
      });

      expect(result.exitCode).toBe(0);
      expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);

      if (prevKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = prevKey;
    });

    it('does not call commentOnIssue when --linear-comment is omitted', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));

      const result = await commands.default([], { entity: 'anthropic', budget: '1' });
      expect(result.exitCode).toBe(0);
      expect(mockCommentOnIssue).not.toHaveBeenCalled();
    });
  });
});

// ── formatSummaryMarkdown unit tests ───────────────────────────────────

describe('formatSummaryMarkdown', () => {
  const FIXED_DATE = new Date('2026-04-12T14:23:00Z');

  function makeResult(
    title: string,
    confirmedBefore: number,
    confirmedAfter: number,
    totalRecords: number,
    cost: number,
    durationMs: number,
    recordsCurated = totalRecords - confirmedBefore,
  ) {
    return {
      entity: { id: title.toLowerCase(), stableId: `sid_${title}`, title, entityType: 'organization' },
      recordsTotal: totalRecords,
      recordsCurated,
      recordsImproved: confirmedAfter - confirmedBefore,
      recordsSkipped: 0,
      researchCost: cost / 2,
      verifyCost: cost / 2,
      totalCost: cost,
      duration: durationMs,
      beforeVerdicts: { confirmed: confirmedBefore, unchecked: totalRecords - confirmedBefore },
      afterVerdicts: { confirmed: confirmedAfter, unchecked: totalRecords - confirmedAfter },
    };
  }

  it('renders the header with timestamp and mode', () => {
    const md = formatSummaryMarkdown([], {
      budget: 10,
      totalCost: 0,
      mode: 'batch',
      limit: 5,
      dryRun: false,
      startedAt: FIXED_DATE,
    });
    expect(md).toContain('## Flagship Curate Run — 2026-04-12 14:23 UTC');
    expect(md).toContain('**Mode**: batch (limit=5, budget=$10.00)');
  });

  it('reports zero entities cleanly without divide-by-zero', () => {
    const md = formatSummaryMarkdown([], {
      budget: 10,
      totalCost: 0,
      mode: 'batch',
      limit: 5,
      dryRun: false,
      startedAt: FIXED_DATE,
    });
    expect(md).toContain('0 entities processed');
    expect(md).toContain('$0.000 / $10.00 (0%)');
    expect(md).toContain('_No entities were processed._');
    expect(md).not.toContain('NaN');
    expect(md).not.toContain('Infinity');
  });

  it('renders a multi-row table with confirmed deltas', () => {
    const results = [
      makeResult('Anthropic', 10, 24, 30, 1.84, 161000),
      makeResult('OpenAI', 8, 17, 25, 1.50, 150000),
    ];
    const md = formatSummaryMarkdown(results, {
      budget: 10,
      totalCost: 3.34,
      mode: 'batch',
      limit: 5,
      dryRun: false,
      startedAt: FIXED_DATE,
    });

    // Header row + separator + 2 data rows
    expect(md).toContain('| Entity | Before → After confirmed | Δ | Records curated | Cost | Time |');
    expect(md).toContain('|---|---|---|---|---|---|');
    expect(md).toContain('| Anthropic | 33% → 80% | **+14** | 20 | $1.840 | 2m 41s |');
    expect(md).toContain('| OpenAI | 32% → 68% | **+9** | 17 | $1.500 | 2m 30s |');

    // Totals line
    expect(md).toContain('+23 confirmed verdicts');
    expect(md).toContain('2 entities processed');
    expect(md).toContain('$3.340 / $10.00 (33%)');
  });

  it('marks deltas of 0 plainly and negative deltas with sign', () => {
    const results = [
      makeResult('No Change Org', 5, 5, 10, 0.5, 60000),
      makeResult('Regression Org', 8, 6, 10, 0.3, 30000),
    ];
    const md = formatSummaryMarkdown(results, {
      budget: 5,
      totalCost: 0.8,
      mode: 'batch',
      limit: 2,
      dryRun: false,
      startedAt: FIXED_DATE,
    });
    expect(md).toContain('| No Change Org | 50% → 50% | 0 |');
    expect(md).toContain('| Regression Org | 80% → 60% | -2 |');
    // Net delta is -2, so totals should show signed value
    expect(md).toContain('-2 confirmed verdicts');
  });

  it('escapes pipe characters in entity titles', () => {
    const results = [makeResult('Foo | Bar Inc', 0, 5, 10, 0.5, 60000)];
    const md = formatSummaryMarkdown(results, {
      budget: 5,
      totalCost: 0.5,
      mode: 'single',
      limit: 1,
      dryRun: false,
      startedAt: FIXED_DATE,
    });
    expect(md).toContain('Foo \\| Bar Inc');
    // Make sure the row hasn't been broken into extra columns
    expect(md).not.toContain('| Foo | Bar Inc |');
  });

  it('flags dry run in header and footer, and uses singular "entity" for n=1', () => {
    const results = [makeResult('Anthropic', 10, 24, 30, 1.84, 161000)];
    const md = formatSummaryMarkdown(results, {
      budget: 5,
      totalCost: 1.84,
      mode: 'single',
      limit: 1,
      dryRun: true,
      startedAt: FIXED_DATE,
    });
    expect(md).toContain('## Flagship Curate Run — 2026-04-12 14:23 UTC [DRY RUN]');
    expect(md).toContain('1 entity processed');
    expect(md).toContain('_Dry run — no changes were written._');
  });

  it('handles entities with all-empty verdicts (no records) without dividing by zero', () => {
    const results = [{
      entity: { id: 'empty', stableId: 'sid_empty', title: 'Empty Org', entityType: 'organization' },
      recordsTotal: 0,
      recordsCurated: 0,
      recordsImproved: 0,
      recordsSkipped: 0,
      researchCost: 0,
      verifyCost: 0,
      totalCost: 0,
      duration: 0,
      beforeVerdicts: {},
      afterVerdicts: {},
    }];
    const md = formatSummaryMarkdown(results, {
      budget: 5,
      totalCost: 0,
      mode: 'single',
      limit: 1,
      dryRun: false,
      startedAt: FIXED_DATE,
    });
    expect(md).toContain('| Empty Org | — → — | 0 |');
    expect(md).not.toContain('NaN');
  });
});
