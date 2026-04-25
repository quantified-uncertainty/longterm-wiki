/**
 * Unit tests — crux-side audit-context cache (QUA-442).
 *
 * Covers getCruxToolName() env handling and the cache semantics of
 * primeAuditSessionId() / getCachedAuditSessionId(). We don't hit the
 * wiki-server here — priming is a best-effort call that can return
 * without contacting the server when required env vars are missing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getCachedAuditSessionId,
  getCruxToolName,
  primeAuditSessionId,
  _resetAuditContextForTesting,
  _setAuditContextForTesting,
} from './audit-context.ts';

describe('getCruxToolName', () => {
  const originalCrux = process.env.CRUX_COMMAND;

  afterEach(() => {
    if (originalCrux === undefined) {
      delete process.env.CRUX_COMMAND;
    } else {
      process.env.CRUX_COMMAND = originalCrux;
    }
  });

  it('returns the trimmed CRUX_COMMAND env var when set', () => {
    process.env.CRUX_COMMAND = '  tb scaffold ';
    expect(getCruxToolName()).toBe('tb scaffold');
  });

  it('returns null when CRUX_COMMAND is unset', () => {
    delete process.env.CRUX_COMMAND;
    expect(getCruxToolName()).toBeNull();
  });

  it('returns null when CRUX_COMMAND is empty or whitespace-only', () => {
    process.env.CRUX_COMMAND = '   ';
    expect(getCruxToolName()).toBeNull();
  });
});

describe('audit-session cache', () => {
  const originalUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const originalProdUrl = process.env.PROD_LONGTERMWIKI_SERVER_URL;
  const originalEnvId = process.env.LW_AGENT_SESSION_ID;

  beforeEach(() => {
    _resetAuditContextForTesting();
  });

  afterEach(() => {
    _resetAuditContextForTesting();
    if (originalUrl === undefined) delete process.env.LONGTERMWIKI_SERVER_URL;
    else process.env.LONGTERMWIKI_SERVER_URL = originalUrl;
    if (originalProdUrl === undefined) delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
    else process.env.PROD_LONGTERMWIKI_SERVER_URL = originalProdUrl;
    if (originalEnvId === undefined) delete process.env.LW_AGENT_SESSION_ID;
    else process.env.LW_AGENT_SESSION_ID = originalEnvId;
  });

  it('returns null before priming', () => {
    expect(getCachedAuditSessionId()).toBeNull();
  });

  it('prefers LW_AGENT_SESSION_ID env var when set', async () => {
    process.env.LW_AGENT_SESSION_ID = 'env-override-123';
    // Forcing no wiki-server URLs so the DB lookup branch would be skipped
    // anyway; the env var is resolved before the URL check.
    delete process.env.LONGTERMWIKI_SERVER_URL;
    delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
    await primeAuditSessionId();
    expect(getCachedAuditSessionId()).toBe('env-override-123');
  });

  it('leaves the cache at null when no server URL is configured', async () => {
    delete process.env.LW_AGENT_SESSION_ID;
    delete process.env.LONGTERMWIKI_SERVER_URL;
    delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
    await primeAuditSessionId();
    expect(getCachedAuditSessionId()).toBeNull();
  });

  it('priming is a no-op on the second call (cache-first)', async () => {
    _setAuditContextForTesting('first-value');
    await primeAuditSessionId();
    expect(getCachedAuditSessionId()).toBe('first-value');
  });

  it('_setAuditContextForTesting + _resetAuditContextForTesting work as documented', () => {
    _setAuditContextForTesting('seeded');
    expect(getCachedAuditSessionId()).toBe('seeded');
    _resetAuditContextForTesting();
    expect(getCachedAuditSessionId()).toBeNull();
  });
});
