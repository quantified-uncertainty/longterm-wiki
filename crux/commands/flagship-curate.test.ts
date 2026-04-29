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
// Hoisted so the `vi.mock('../lib/llm.ts', ...)` factory (itself hoisted to
// the top of the file) can reference it directly. The QUA-378 tests cast the
// imported `callLlm` symbol to a vi.fn and call `.mockRejectedValueOnce()` on
// it — that only works if `callLlm` IS the hoisted vi.fn, not a wrapper.
const { mockCallLlm } = vi.hoisted(() => ({
  mockCallLlm: vi.fn(async () => ({
    text: '[]',
    usage: { input_tokens: 100, output_tokens: 50 },
    model: 'claude-haiku-4-5-20251001',
  })),
}));

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
    callLlm: mockCallLlm,
    MODELS: { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6' },
  };
});

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

import {
  commands,
  formatSummary,
  formatSummaryMarkdown,
  formatConfirmedDelta,
} from './flagship-curate.ts';
import { CreditExhaustedError } from '../lib/resilience.ts';
import { callLlm } from '../lib/llm.ts';
import { orchestrateCommand } from './sourcing-orchestrate.ts';

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
    // Reset the callLlm mock to its default empty-array response.
    mockCallLlm.mockImplementation(async () => ({
      text: '[]',
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-haiku-4-5-20251001',
    }));
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

  // ── Wiki-server unavailable (QUA-452) ────────────────────────────
  describe('wiki-server unavailable (QUA-452)', () => {
    it('exits non-zero and surfaces the error when /api/entities fails', async () => {
      // Batch mode: no explicit --entity, so flagship-curate calls
      // findEntitiesNeedingCuration → /api/entities. Simulate server down.
      mockApiRequest.mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'wiki-server connection refused',
        status: 503,
      });

      const result = await commands.default([], {
        all: true,
        limit: '1',
        budget: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/Failed to fetch entities from wiki-server/);
      expect(result.output).toMatch(/unavailable/);
      // Human-readable message preserved alongside the error code (review finding).
      expect(result.output).toMatch(/wiki-server connection refused/);
      expect(result.output).toMatch(/QUA-452/);
      // Must NOT silently report "no entities found" — that was the bug.
      expect(result.output).not.toMatch(/No entities found needing curation/);
    });
  });

  // ── Sourcing endpoint unavailable — inner loop (QUA-460) ─────────
  describe('sourcing endpoint unavailable, inner loop (QUA-460)', () => {
    it('aborts after 6 consecutive getVerdictsByEntity failures instead of silently reporting 0 needsCuration', async () => {
      // Outer call succeeds (10 orgs returned)…
      mockApiRequest.mockResolvedValue({
        ok: true,
        data: {
          entities: Array.from({ length: 10 }, (_, i) => ({
            id: `org-${i}`,
            stableId: `sid_${i}`,
            title: `Org ${i}`,
            entityType: 'organization',
          })),
          total: 10,
        },
        status: 200,
      });
      // …but every per-entity verdict fetch fails. Pre-QUA-460, this
      // would silently `continue` on each one, producing zero curation
      // candidates and reporting "No entities found needing curation"
      // even though the sourcing endpoint is down.
      mockGetVerdictsByEntity.mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'sourcing service 503',
        status: 503,
      });

      const result = await commands.default([], {
        all: true,
        limit: '1',
        budget: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/Failed to fetch entities from wiki-server/);
      expect(result.output).toMatch(/consecutive entities/i);
      expect(result.output).toMatch(/sourcing service 503/);
      // Must NOT silently report "no entities found".
      expect(result.output).not.toMatch(/No entities found needing curation/);
    });

    it('tolerates up to 5 consecutive failures before aborting (threshold boundary)', async () => {
      // 6 entities: 5 fail, then 1 succeeds with a curation candidate.
      // The counter resets on success, so the sweep continues.
      mockApiRequest.mockResolvedValue({
        ok: true,
        data: {
          entities: Array.from({ length: 6 }, (_, i) => ({
            id: `org-${i}`,
            stableId: `sid_${i}`,
            title: `Org ${i}`,
            entityType: 'organization',
          })),
          total: 6,
        },
        status: 200,
      });

      mockGetVerdictsByEntity
        .mockResolvedValueOnce({ ok: false, error: 'e', message: 'm', status: 503 })
        .mockResolvedValueOnce({ ok: false, error: 'e', message: 'm', status: 503 })
        .mockResolvedValueOnce({ ok: false, error: 'e', message: 'm', status: 503 })
        .mockResolvedValueOnce({ ok: false, error: 'e', message: 'm', status: 503 })
        .mockResolvedValueOnce({ ok: false, error: 'e', message: 'm', status: 503 })
        .mockResolvedValueOnce(
          makeVerdicts([
            { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'Alice' },
          ]),
        );

      // After 5 failures and 1 success, the sweep finds 1 entity. With
      // dry-run, processing is lightweight and exits 0.
      const result = await commands.default([], {
        all: true,
        limit: '1',
        budget: '1',
        'dry-run': true,
      });

      // Did NOT abort with QUA-460 consecutive-failures error.
      expect(result.output).not.toMatch(/consecutive entities/i);
    });
  });

  // ── Credit-exhaustion handling (QUA-378) ────────────────────────────
  describe('credit exhaustion (QUA-378)', () => {
    it('aborts with exit code 2 when research throws CreditExhaustedError', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'Alice' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));
      // Make the research call fail with credit-exhausted on the first attempt.
      (callLlm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new CreditExhaustedError(
          '400 invalid_request_error: Your credit balance is too low',
          null,
        ),
      );

      // Silence stderr for the abort banner.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
      });

      expect(result.exitCode).toBe(2);
      const bannerText = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(bannerText).toContain('ABORTED');
      expect(bannerText).toContain('credit balance');
      expect(bannerText).toContain('QUA-378');
      // Reset at Step 4 must not have run (Step 2 threw before we got there).
      expect(mockStoreVerdict).not.toHaveBeenCalled();
    });

    it('aborts with exit code 2 when verification output contains credit-balance error', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'Alice' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));

      // Make orchestrate-sourcing return output with the credit-exhausted
      // fingerprint (simulating every per-item LLM call returning a 400).
      (orchestrateCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        exitCode: 0,
        output:
          '[1/1] RECORD Personnel: Alice\n' +
          '  ERROR: LLM call failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."},"request_id":"req_X"}\n' +
          'Verification complete. Cost: $0.000',
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        // Skip research so we reach verification with an empty researched set.
        'skip-research': true,
      });

      expect(result.exitCode).toBe(2);
      expect(
        errorSpy.mock.calls.map((c) => c.join(' ')).join('\n'),
      ).toContain('ABORTED');
    });

    it('batch mode: halts remaining orgs after the first credit-exhausted org', async () => {
      // Three candidate orgs; findEntitiesNeedingCuration fetches all and
      // then sorts by non-confirmed verdict count. We give each the same
      // count so order is stable (insertion order wins on ties).
      mockApiRequest.mockResolvedValue({
        ok: true,
        data: {
          entities: [
            { id: 'alpha', stableId: 'sid_alpha', title: 'Alpha', entityType: 'organization' },
            { id: 'bravo', stableId: 'sid_bravo', title: 'Bravo', entityType: 'organization' },
            { id: 'charlie', stableId: 'sid_charlie', title: 'Charlie', entityType: 'organization' },
          ],
          total: 3,
        },
      });
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'X' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));

      // First call succeeds (alpha processes normally). Second call — during
      // bravo's research — throws credit-exhausted. Everything after must
      // be skipped without invoking callLlm again.
      (callLlm as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          text: '[]',
          usage: { input_tokens: 10, output_tokens: 10 },
          model: 'claude-haiku-4-5-20251001',
        })
        .mockRejectedValueOnce(new CreditExhaustedError('credit balance is too low', null))
        .mockImplementation(async () => {
          throw new Error('callLlm should not be invoked after credit exhaustion');
        });

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await commands.default([], {
        all: true,
        budget: '5',
        limit: '3',
        iterations: '1', // single-iteration so alpha completes on its one research call
        ci: true,
      });

      expect(result.exitCode).toBe(2);
      const json = JSON.parse(result.output);
      expect(json.aborted).toBe('credit_exhausted');
      // Alpha completed its one iteration; bravo threw during its research
      // call; charlie never started. Both bravo (abandoned) and charlie
      // (never started) count as skippedDueToCredits.
      expect(json.results.length).toBe(1);
      expect(json.results[0].entity).toBe('Alpha');
      expect(json.skippedDueToCredits).toBe(2);
    });

    it('detects credit errors via the raw substring match (not just CreditExhaustedError instance)', async () => {
      // If a caller forgets to wrap a raw error, the top-level batch loop
      // still catches it via isCreditExhaustedError(). This guards against
      // the "works in unit tests, fails in prod" drift.
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'unchecked', displayName: 'Alice' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));
      (callLlm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        // NOT wrapped in CreditExhaustedError — raw 400 body
        new Error(
          '400 invalid_request_error: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
        ),
      );

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
      });

      expect(result.exitCode).toBe(2);
    });
  });

  describe('Step 4 reset guard (QUA-382)', () => {
    // Helper: set up an entity with 3 records that all need curation. All
    // three have verdict=partial so discoverRecordsNeedingCuration preserves
    // their insertion order when passing them to the research step.
    // The research LLM returns URLs for indexes 0 and 1, skipping index 2.
    function setupThreeRecordScenario() {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'partial', displayName: 'Alice' },
          { recordType: 'personnel', recordId: 'p2', verdict: 'partial', displayName: 'Bob' },
          { recordType: 'personnel', recordId: 'p3', verdict: 'partial', displayName: 'Carol' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(
        makePersonnel([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]),
      );
      mockSyncPersonnel.mockResolvedValue({ ok: true, data: { updated: 2 } });
      mockStoreVerdict.mockResolvedValue({ ok: true });
      // Research LLM: return URLs for p1 (index 0) and p2 (index 1), skip p3.
      mockCallLlm.mockResolvedValue({
        text: JSON.stringify([
          { index: 0, urls: ['https://example.com/alice'], reasoning: 'Team page' },
          { index: 1, urls: ['https://example.com/bob'], reasoning: 'Team page' },
        ]),
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-haiku-4-5-20251001',
      });
    }

    function resetCalls() {
      return mockStoreVerdict.mock.calls
        .map((call) => call[0] as { recordId: string; verdict: string } | undefined)
        .filter((arg) => arg?.verdict === 'unchecked');
    }

    it('resets only records whose URLs were successfully ingested in Step 3', async () => {
      setupThreeRecordScenario();
      // p1 URL succeeds, p2 URL fails.
      mockSuggestResources.mockResolvedValue({
        resources: [
          { url: 'https://example.com/alice', resourceId: 'r1', status: 'ok', contentLength: 100, title: 'Alice' },
          { url: 'https://example.com/bob', resourceId: 'r2', status: 'error', contentLength: 0, title: null },
        ],
        fetchedCount: 1,
        cachedCount: 0,
        errorCount: 1,
      });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      const resets = resetCalls();
      const resetIds = resets.map((r) => r!.recordId).sort();
      // Only p1 should be reset. p2's URL errored, p3 had no URL.
      expect(resetIds).toEqual(['p1']);
    });

    it('skips Step 4 entirely when Step 3 produces no successful ingests', async () => {
      setupThreeRecordScenario();
      // All URLs fail.
      mockSuggestResources.mockResolvedValue({
        resources: [
          { url: 'https://example.com/alice', resourceId: 'r1', status: 'error', contentLength: 0, title: null },
          { url: 'https://example.com/bob', resourceId: 'r2', status: 'error', contentLength: 0, title: null },
        ],
        fetchedCount: 0,
        cachedCount: 0,
        errorCount: 2,
      });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(resetCalls()).toEqual([]);
    });

    it('skips Step 4 entirely when suggestResources throws', async () => {
      setupThreeRecordScenario();
      mockSuggestResources.mockRejectedValue(new Error('firecrawl not installed'));

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(resetCalls()).toEqual([]);
    });

    it('skips Step 4 entirely when Step 2 research returns no URLs', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'partial', displayName: 'Alice' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));
      mockStoreVerdict.mockResolvedValue({ ok: true });
      // Research LLM returns empty array — no new URLs.
      mockCallLlm.mockResolvedValue({
        text: '[]',
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-haiku-4-5-20251001',
      });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(mockSuggestResources).not.toHaveBeenCalled();
      expect(resetCalls()).toEqual([]);
    });

    it('--skip-research resets all eligible records (no Step 3 gate)', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'partial', displayName: 'Alice' },
          { recordType: 'personnel', recordId: 'p2', verdict: 'unverifiable', displayName: 'Bob' },
          { recordType: 'personnel', recordId: 'p3', verdict: 'confirmed', displayName: 'Carol' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(
        makePersonnel([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]),
      );
      mockStoreVerdict.mockResolvedValue({ ok: true });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        'skip-research': true,
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      // suggestResources must not have been called — research was skipped.
      expect(mockSuggestResources).not.toHaveBeenCalled();
      // p1 (partial) and p2 (unverifiable) reset; p3 (confirmed) is excluded
      // before reset because it doesn't appear in records-needing-curation.
      const resetIds = resetCalls().map((r) => r!.recordId).sort();
      expect(resetIds).toEqual(['p1', 'p2']);
    });

    it('treats fresh-cache hits (status=ok, contentLength=null) as successful', async () => {
      // The cached path in suggest-resources.ts returns status 'ok' with
      // contentLength null (content exists but wasn't re-fetched, so length
      // is unknown). These should still count as successful ingests.
      setupThreeRecordScenario();
      mockSuggestResources.mockResolvedValue({
        resources: [
          { url: 'https://example.com/alice', resourceId: 'r1', status: 'ok', contentLength: null, title: 'Alice (cached)' },
          { url: 'https://example.com/bob', resourceId: 'r2', status: 'ok', contentLength: null, title: 'Bob (cached)' },
        ],
        fetchedCount: 0,
        cachedCount: 2,
        errorCount: 0,
      });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      const resetIds = resetCalls().map((r) => r!.recordId).sort();
      expect(resetIds).toEqual(['p1', 'p2']);
    });

    it('treats paywall and dead statuses as failures (records not reset)', async () => {
      // Records whose URLs all came back as paywall/dead should not be
      // reset — the verifier may reject paywall content and strand them
      // at 'unchecked', which is the original QUA-382 bug.
      setupThreeRecordScenario();
      mockSuggestResources.mockResolvedValue({
        resources: [
          { url: 'https://example.com/alice', resourceId: 'r1', status: 'paywall', contentLength: 500, title: 'Alice' },
          { url: 'https://example.com/bob', resourceId: 'r2', status: 'dead', contentLength: 0, title: null },
        ],
        fetchedCount: 0,
        cachedCount: 0,
        errorCount: 0,
      });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(resetCalls()).toEqual([]);
    });

    it('skips Step 4 entirely when the verify budget is exhausted', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'partial', displayName: 'Alice' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));
      mockStoreVerdict.mockResolvedValue({ ok: true });
      // Research LLM burns the entire budget so verifyBudget ends up ≤ 0.
      mockCallLlm.mockResolvedValue({
        text: JSON.stringify([
          { index: 0, urls: ['https://example.com/alice'], reasoning: 'Team page' },
        ]),
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        model: 'claude-haiku-4-5-20251001',
      });
      mockSuggestResources.mockResolvedValue({
        resources: [
          { url: 'https://example.com/alice', resourceId: 'r1', status: 'ok', contentLength: 100, title: 'Alice' },
        ],
        fetchedCount: 1,
        cachedCount: 0,
        errorCount: 0,
      });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '0.0001', // too small — verifyBudget drops to ≤ 0 after research
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(resetCalls()).toEqual([]);
    });

    it('guard still applies across multiple iterations (iterations=2)', async () => {
      // With iterations=2, the guard must hold on both passes: Step 4 of
      // iteration 2 must still only reset records that got new sources in
      // iteration 2's own Step 3. Here Step 3 fails on both iterations, so
      // no resets should ever fire.
      setupThreeRecordScenario();
      mockSuggestResources.mockResolvedValue({
        resources: [
          { url: 'https://example.com/alice', resourceId: 'r1', status: 'error', contentLength: 0, title: null },
          { url: 'https://example.com/bob', resourceId: 'r2', status: 'error', contentLength: 0, title: null },
        ],
        fetchedCount: 0,
        cachedCount: 0,
        errorCount: 2,
      });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        iterations: '2',
      });

      expect(result.exitCode).toBe(0);
      expect(resetCalls()).toEqual([]);
    });

    it('reset payload sets needsRecheck=true and nextCheckDue (QUA-723)', async () => {
      // Without these fields, the weekly sourcing-recheck cron skips
      // reset rows permanently — they become orphans if Step 5's
      // in-process verify is cut off by budget/timeout.
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'partial', displayName: 'Alice' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));
      mockStoreVerdict.mockResolvedValue({ ok: true });

      const before = Date.now();
      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        'skip-research': true,
        iterations: '1',
      });
      const after = Date.now();

      expect(result.exitCode).toBe(0);
      const resets = mockStoreVerdict.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((arg) => arg?.['verdict'] === 'unchecked');
      expect(resets).toHaveLength(1);
      const payload = resets[0]!;
      expect(payload['needsRecheck']).toBe(true);
      expect(typeof payload['nextCheckDue']).toBe('string');
      const due = new Date(payload['nextCheckDue'] as string).getTime();
      expect(due).toBeGreaterThanOrEqual(before);
      expect(due).toBeLessThanOrEqual(after);
    });

    it('does not reset contradicted records (only unverifiable/partial/outdated are resettable)', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(
        makeVerdicts([
          { recordType: 'personnel', recordId: 'p1', verdict: 'contradicted', displayName: 'Alice' },
        ]),
      );
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([{ id: 'p1' }]));
      mockStoreVerdict.mockResolvedValue({ ok: true });

      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '5',
        'skip-research': true,
        iterations: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(resetCalls()).toEqual([]);
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

      try {
        const result = await commands.default([], {
          entity: 'anthropic',
          budget: '1',
          'linear-comment': 'QUA-124',
        });

        expect(result.exitCode).toBe(0);
        expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
        expect(mockCommentOnIssue).toHaveBeenCalledWith('QUA-124', expect.stringContaining('Flagship Curate Run'));
      } finally {
        if (prevKey === undefined) delete process.env['LINEAR_API_KEY'];
        else process.env['LINEAR_API_KEY'] = prevKey;
      }
    });

    it('rejects unknown team keys (not in the QUA allowlist)', async () => {
      // The shared parseLinearId rejects anything outside the QUA team key
      // allowlist — so `FOO-123` should be 1, not 0.
      const result = await commands.default([], {
        entity: 'anthropic',
        budget: '1',
        'linear-comment': 'FOO-123',
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Invalid --linear-comment value');
    });

    it('does not post when LINEAR_API_KEY is unset, and exit code stays 0', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));
      const prevKey = process.env['LINEAR_API_KEY'];
      delete process.env['LINEAR_API_KEY'];

      try {
        const result = await commands.default([], {
          entity: 'anthropic',
          budget: '1',
          'linear-comment': 'QUA-124',
        });

        expect(result.exitCode).toBe(0);
        expect(mockCommentOnIssue).not.toHaveBeenCalled();
      } finally {
        if (prevKey !== undefined) process.env['LINEAR_API_KEY'] = prevKey;
      }
    });

    it('best-effort: continues with exit 0 when commentOnIssue throws', async () => {
      mockGetEntity.mockResolvedValue(makeEntity('anthropic', 'Anthropic'));
      mockGetVerdictsByEntity.mockResolvedValue(makeVerdicts([]));
      mockGetPersonnelByEntity.mockResolvedValue(makePersonnel([]));
      mockCommentOnIssue.mockRejectedValue(new Error('Linear is down'));
      const prevKey = process.env['LINEAR_API_KEY'];
      process.env['LINEAR_API_KEY'] = 'test-key';

      try {
        const result = await commands.default([], {
          entity: 'anthropic',
          budget: '1',
          'linear-comment': 'QUA-124',
        });

        expect(result.exitCode).toBe(0);
        expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
      } finally {
        if (prevKey === undefined) delete process.env['LINEAR_API_KEY'];
        else process.env['LINEAR_API_KEY'] = prevKey;
      }
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

  it('strips newlines from entity titles to keep table rows intact', () => {
    const results = [makeResult('Foo\nBar Inc', 0, 5, 10, 0.5, 60000)];
    const md = formatSummaryMarkdown(results, {
      budget: 5,
      totalCost: 0.5,
      mode: 'single',
      limit: 1,
      dryRun: false,
      startedAt: FIXED_DATE,
    });
    // The row containing the title should be a single line
    const titleLine = md.split('\n').find((l) => l.includes('Bar Inc'));
    expect(titleLine).toBeDefined();
    expect(titleLine).toContain('Foo Bar Inc');
    expect(titleLine).not.toMatch(/\n/);
  });

  it('escapes markdown link brackets and backticks in entity titles', () => {
    const results = [makeResult('[Click](javascript:alert(1)) `code` org', 0, 5, 10, 0.5, 60000)];
    const md = formatSummaryMarkdown(results, {
      budget: 5,
      totalCost: 0.5,
      mode: 'single',
      limit: 1,
      dryRun: false,
      startedAt: FIXED_DATE,
    });
    // Bracket should be escaped so it can't form a markdown link
    expect(md).toContain('\\[Click');
    // Backticks should be replaced (not escaped) so they can't open inline code
    expect(md).not.toMatch(/`code`/);
    expect(md).toContain("'code'");
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

// ── formatSummary console output tests (QUA-379) ───────────────────────

describe('formatSummary console output', () => {
  /**
   * Strip ANSI escape codes so assertions don't need to know about colors.
   * Matches the CSI sequence `ESC [ ... m` that c.green / c.red / etc. emit.
   */
  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  function makeResult(
    title: string,
    confirmedBefore: number,
    confirmedAfter: number,
    totalRecords: number,
    cost = 0.5,
    durationMs = 60000,
  ) {
    return {
      entity: { id: title.toLowerCase(), stableId: `sid_${title}`, title, entityType: 'organization' },
      recordsTotal: totalRecords,
      recordsCurated: Math.max(0, totalRecords - confirmedBefore),
      // Note: recordsImproved is clamped to >= 0 per the existing CurationResult
      // contract. formatSummary must NOT rely on it to compute the delta.
      recordsImproved: Math.max(0, confirmedAfter - confirmedBefore),
      recordsSkipped: 0,
      researchCost: cost / 2,
      verifyCost: cost / 2,
      totalCost: cost,
      duration: durationMs,
      beforeVerdicts: { confirmed: confirmedBefore, unchecked: totalRecords - confirmedBefore },
      afterVerdicts: { confirmed: confirmedAfter, unchecked: totalRecords - confirmedAfter },
    };
  }

  describe('formatConfirmedDelta', () => {
    it('labels improvements with a green plus prefix', () => {
      const out = formatConfirmedDelta(10, 14);
      expect(stripAnsi(out)).toBe('+4');
      expect(out).toContain('\x1b[32m'); // green
    });

    it('labels regressions with a red minus prefix — the QUA-379 regression case', () => {
      const out = formatConfirmedDelta(14, 10);
      expect(stripAnsi(out)).toBe('-4');
      expect(out).toContain('\x1b[31m'); // red
    });

    it('labels exact zero as dim "no change"', () => {
      const out = formatConfirmedDelta(10, 10);
      expect(stripAnsi(out)).toBe('no change');
      expect(out).toContain('\x1b[2m'); // dim
    });

    it('does not render +0 or -0 for the zero case', () => {
      const out = stripAnsi(formatConfirmedDelta(0, 0));
      expect(out).not.toContain('+0');
      expect(out).not.toContain('-0');
    });
  });

  describe('per-entity line rendering', () => {
    it('renders a regression with a red minus, not "no change" — QUA-379 Anthropic case', () => {
      // Reproducing the exact 2026-04-13 evidence: Anthropic 37% → 33% confirmed
      // with the old formatter labeled this "no change" because the delta
      // display was gated on `confirmedAfter > confirmedBefore`.
      const results = [makeResult('Anthropic', 10, 8, 27)];
      const out = stripAnsi(formatSummary(results));
      // Old (buggy) output would have been: "37% → 30% confirmed (no change)"
      expect(out).toContain('Anthropic: 37% → 30% confirmed (-2)');
      expect(out).not.toMatch(/Anthropic.*no change/);
    });

    it('renders an improvement with a green plus', () => {
      const results = [makeResult('OpenAI', 8, 12, 25)];
      const out = stripAnsi(formatSummary(results));
      expect(out).toContain('OpenAI: 32% → 48% confirmed (+4)');
    });

    it('renders exact zero delta as "no change"', () => {
      const results = [makeResult('StableOrg', 5, 5, 10)];
      const out = stripAnsi(formatSummary(results));
      expect(out).toContain('StableOrg: 50% → 50% confirmed (no change)');
    });

    it('renders mixed results (improvement + no-change + regression) accurately across a batch', () => {
      // Mirrors a realistic partial-sweep: some orgs gained confirmed verdicts,
      // some flipped neutral, some regressed. All three must be distinguishable
      // in the console output — the entire point of QUA-379.
      const results = [
        makeResult('GoodOrg', 5, 10, 20, 0.5, 60000),
        makeResult('FlatOrg', 8, 8, 16, 0.2, 30000),
        makeResult('RegressOrg', 10, 6, 20, 0.3, 45000),
      ];
      const out = stripAnsi(formatSummary(results));
      expect(out).toContain('GoodOrg: 25% → 50% confirmed (+5)');
      expect(out).toContain('FlatOrg: 50% → 50% confirmed (no change)');
      expect(out).toContain('RegressOrg: 50% → 30% confirmed (-4)');
    });
  });

  describe('totals line', () => {
    it('reports a signed net confirmed-delta across all entities (QUA-379 accounting fix)', () => {
      // GoodOrg: +5, FlatOrg: 0, RegressOrg: -4 → net +1 net delta.
      // The old formatter summed `recordsImproved` (clamped ≥ 0 per-org)
      // which would have reported +5 — hiding the regression entirely.
      const results = [
        makeResult('GoodOrg', 5, 10, 20),
        makeResult('FlatOrg', 8, 8, 16),
        makeResult('RegressOrg', 10, 6, 20),
      ];
      const out = stripAnsi(formatSummary(results));
      expect(out).toContain('Confirmed delta: +1');
      // The misleading old label should be gone.
      expect(out).not.toContain('Records improved:');
    });

    it('reports negative totals when the net is a regression', () => {
      const results = [
        makeResult('OrgA', 10, 8, 20),
        makeResult('OrgB', 10, 7, 20),
      ];
      const out = stripAnsi(formatSummary(results));
      expect(out).toContain('Confirmed delta: -5');
    });

    it('reports "0" (not "+0" or "-0") when net delta is exactly zero', () => {
      const results = [
        makeResult('OrgA', 5, 8, 15), // +3
        makeResult('OrgB', 5, 2, 15), // -3
      ];
      const out = stripAnsi(formatSummary(results));
      expect(out).toContain('Confirmed delta: 0');
      expect(out).not.toContain('Confirmed delta: +0');
      expect(out).not.toContain('Confirmed delta: -0');
    });

    it('colors the totals line red on net regression', () => {
      const results = [makeResult('Regress', 10, 6, 20)];
      const out = formatSummary(results);
      // The totals line should contain a red ANSI code for the net delta.
      const totalsLine = out.split('\n').find((l) => l.includes('Confirmed delta:'));
      expect(totalsLine).toBeDefined();
      expect(totalsLine).toContain('\x1b[31m');
    });

    it('colors the totals line green on net improvement', () => {
      const results = [makeResult('Grow', 5, 10, 20)];
      const totalsLine = formatSummary(results).split('\n').find((l) => l.includes('Confirmed delta:'));
      expect(totalsLine).toContain('\x1b[32m');
    });
  });
});
