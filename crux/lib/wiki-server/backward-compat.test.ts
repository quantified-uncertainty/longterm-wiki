/**
 * wiki-server-client.ts barrel export test — verifies that the old
 * import path still exports all functions and types.
 *
 * All functions now return ApiResult<T> (the _compat T|null wrappers
 * have been removed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

describe('wiki-server-client barrel exports', () => {
  let client: typeof import('../wiki-server-client.ts');

  beforeEach(async () => {
    client = await import('../wiki-server-client.ts');
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it('exports all config functions', () => {
    expect(typeof client.getServerUrl).toBe('function');
    expect(typeof client.getApiKey).toBe('function');
    expect(typeof client.buildHeaders).toBe('function');
    expect(typeof client.isServerAvailable).toBe('function');
  });

  it('exports all edit log functions', () => {
    expect(typeof client.appendEditLogToServer).toBe('function');
    expect(typeof client.appendEditLogBatch).toBe('function');
    expect(typeof client.getEditLogsForPage).toBe('function');
    expect(typeof client.getEditLogStats).toBe('function');
    expect(typeof client.getEditLogLatestDates).toBe('function');
  });

  it('exports all citation functions', () => {
    expect(typeof client.upsertCitationQuote).toBe('function');
    expect(typeof client.upsertCitationQuoteBatch).toBe('function');
    expect(typeof client.markCitationAccuracy).toBe('function');
    expect(typeof client.markCitationAccuracyBatch).toBe('function');
    expect(typeof client.createAccuracySnapshot).toBe('function');
    expect(typeof client.getAccuracyDashboard).toBe('function');
  });

  it('exports all session functions', () => {
    expect(typeof client.createSession).toBe('function');
    expect(typeof client.createSessionBatch).toBe('function');
    expect(typeof client.listSessions).toBe('function');
    expect(typeof client.getSessionsByPage).toBe('function');
    expect(typeof client.getSessionStats).toBe('function');
    expect(typeof client.getSessionPageChanges).toBe('function');
  });

  it('exports all auto-update functions', () => {
    expect(typeof client.recordAutoUpdateRun).toBe('function');
    expect(typeof client.getAutoUpdateRuns).toBe('function');
    expect(typeof client.getAutoUpdateStats).toBe('function');
    expect(typeof client.insertAutoUpdateNewsItems).toBe('function');
    expect(typeof client.getAutoUpdateNewsDashboard).toBe('function');
  });

  it('exports risk, summary, claims, links, resource, entity, and fact functions', () => {
    expect(typeof client.recordRiskSnapshots).toBe('function');
    expect(typeof client.upsertSummary).toBe('function');
    expect(typeof client.upsertSummaryBatch).toBe('function');
    expect(typeof client.insertClaim).toBe('function');
    expect(typeof client.insertClaimBatch).toBe('function');
    expect(typeof client.clearClaimsForEntity).toBe('function');
    expect(typeof client.syncPageLinks).toBe('function');
    expect(typeof client.upsertResource).toBe('function');
    expect(typeof client.syncEntities).toBe('function');
    expect(typeof client.getEntity).toBe('function');
    expect(typeof client.listEntities).toBe('function');
    expect(typeof client.searchEntities).toBe('function');
    expect(typeof client.getEntityStats).toBe('function');
    expect(typeof client.syncFacts).toBe('function');
    expect(typeof client.getFactsByEntity).toBe('function');
    expect(typeof client.getFactTimeseries).toBe('function');
    expect(typeof client.getStaleFacts).toBe('function');
    expect(typeof client.getFactStats).toBe('function');
  });

  it('exports page query functions', () => {
    expect(typeof client.searchPages).toBe('function');
    expect(typeof client.getPage).toBe('function');
    expect(typeof client.getRelatedPages).toBe('function');
    expect(typeof client.getBacklinks).toBe('function');
    expect(typeof client.getCitationQuotes).toBe('function');
  });

  it('exports ApiResult utilities', () => {
    expect(typeof client.apiOk).toBe('function');
    expect(typeof client.apiErr).toBe('function');
    expect(typeof client.unwrap).toBe('function');
  });

  describe('functions return ApiResult (not T | null)', () => {
    beforeEach(() => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
    });

    it('appendEditLogToServer returns ApiResult error on unavailable', async () => {
      const result = await client.appendEditLogToServer({
        pageId: 'test',
        date: '2026-02-20',
        tool: 'crux-fix',
        agency: 'automated',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });

    it('getEditLogsForPage returns ApiResult error on unavailable', async () => {
      const result = await client.getEditLogsForPage('test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });

    it('recordRiskSnapshots returns ApiResult error on unavailable', async () => {
      const result = await client.recordRiskSnapshots([
        { pageId: 'test', score: 50, level: 'medium', factors: [] },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });

    it('syncPageLinks returns ApiResult error on unavailable', async () => {
      const result = await client.syncPageLinks([
        { sourceId: 'a', targetId: 'b', linkType: 'entity_link', weight: 1 },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });
});
