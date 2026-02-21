/**
 * Backward compatibility test — verifies that the old wiki-server-client.ts
 * import path still exports all the same functions and types.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

describe('wiki-server-client backward compatibility', () => {
  let oldClient: typeof import('../wiki-server-client.ts');

  beforeEach(async () => {
    oldClient = await import('../wiki-server-client.ts');
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it('exports all config functions', () => {
    expect(typeof oldClient.getServerUrl).toBe('function');
    expect(typeof oldClient.getApiKey).toBe('function');
    expect(typeof oldClient.buildHeaders).toBe('function');
    expect(typeof oldClient.isServerAvailable).toBe('function');
  });

  it('exports all edit log functions', () => {
    expect(typeof oldClient.appendEditLogToServer).toBe('function');
    expect(typeof oldClient.appendEditLogBatch).toBe('function');
    expect(typeof oldClient.getEditLogsForPage).toBe('function');
    expect(typeof oldClient.getEditLogStats).toBe('function');
    expect(typeof oldClient.getEditLogLatestDates).toBe('function');
  });

  it('exports all citation functions', () => {
    expect(typeof oldClient.upsertCitationQuote).toBe('function');
    expect(typeof oldClient.upsertCitationQuoteBatch).toBe('function');
    expect(typeof oldClient.markCitationAccuracy).toBe('function');
    expect(typeof oldClient.markCitationAccuracyBatch).toBe('function');
    expect(typeof oldClient.createAccuracySnapshot).toBe('function');
    expect(typeof oldClient.getAccuracyDashboard).toBe('function');
  });

  it('exports all session functions', () => {
    expect(typeof oldClient.createSession).toBe('function');
    expect(typeof oldClient.createSessionBatch).toBe('function');
    expect(typeof oldClient.listSessions).toBe('function');
    expect(typeof oldClient.getSessionsByPage).toBe('function');
    expect(typeof oldClient.getSessionStats).toBe('function');
    expect(typeof oldClient.getSessionPageChanges).toBe('function');
  });

  it('exports all auto-update functions', () => {
    expect(typeof oldClient.recordAutoUpdateRun).toBe('function');
    expect(typeof oldClient.getAutoUpdateRuns).toBe('function');
    expect(typeof oldClient.getAutoUpdateStats).toBe('function');
    expect(typeof oldClient.insertAutoUpdateNewsItems).toBe('function');
    expect(typeof oldClient.getAutoUpdateNewsDashboard).toBe('function');
  });

  it('exports risk, summary, claims, links, resource, entity, and fact functions', () => {
    expect(typeof oldClient.recordRiskSnapshots).toBe('function');
    expect(typeof oldClient.upsertSummary).toBe('function');
    expect(typeof oldClient.upsertSummaryBatch).toBe('function');
    expect(typeof oldClient.insertClaim).toBe('function');
    expect(typeof oldClient.insertClaimBatch).toBe('function');
    expect(typeof oldClient.clearClaimsForEntity).toBe('function');
    expect(typeof oldClient.syncPageLinks).toBe('function');
    expect(typeof oldClient.upsertResource).toBe('function');
    expect(typeof oldClient.syncEntities).toBe('function');
    expect(typeof oldClient.getEntity).toBe('function');
    expect(typeof oldClient.listEntities).toBe('function');
    expect(typeof oldClient.searchEntities).toBe('function');
    expect(typeof oldClient.getEntityStats).toBe('function');
    expect(typeof oldClient.syncFacts).toBe('function');
    expect(typeof oldClient.getFactsByEntity).toBe('function');
    expect(typeof oldClient.getFactTimeseries).toBe('function');
    expect(typeof oldClient.getStaleFacts).toBe('function');
    expect(typeof oldClient.getFactStats).toBe('function');
  });

  it('exports new ApiResult utilities', () => {
    expect(typeof oldClient.apiOk).toBe('function');
    expect(typeof oldClient.apiErr).toBe('function');
    expect(typeof oldClient.unwrap).toBe('function');
  });

  describe('backward-compatible functions return T | null (not ApiResult)', () => {
    beforeEach(() => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
    });

    it('appendEditLogToServer returns null on unavailable', async () => {
      const result = await oldClient.appendEditLogToServer({
        pageId: 'test',
        date: '2026-02-20',
        tool: 'crux-fix',
        agency: 'automated',
      });
      expect(result).toBeNull();
    });

    it('getEditLogsForPage returns null on unavailable', async () => {
      const result = await oldClient.getEditLogsForPage('test');
      expect(result).toBeNull();
    });

    it('recordRiskSnapshots returns null on unavailable', async () => {
      const result = await oldClient.recordRiskSnapshots([
        { pageId: 'test', score: 50, level: 'medium', factors: [] },
      ]);
      expect(result).toBeNull();
    });

    it('syncPageLinks returns null on unavailable', async () => {
      const result = await oldClient.syncPageLinks([
        { sourceId: 'a', targetId: 'b', linkType: 'entity_link', weight: 1 },
      ]);
      expect(result).toBeNull();
    });
  });
});
