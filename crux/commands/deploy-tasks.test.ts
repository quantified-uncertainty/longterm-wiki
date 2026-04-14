/**
 * Tests for deploy-tasks command handlers.
 *
 * Covers:
 * - checkPsqlRunnable: gates psql verify commands when psql or DATABASE_URL
 *   are missing from the local environment (QUA-319).
 */

import { describe, it, expect } from 'vitest';
import { checkPsqlRunnable, isPatBlockedError } from './deploy-tasks.ts';

describe('checkPsqlRunnable', () => {
  const PSQL_CMD =
    'psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"';
  const CURL_CMD = 'curl -sf "$WIKI_SERVER_URL/health" | jq .';

  it('returns runnable=true for non-psql commands regardless of env', () => {
    const result = checkPsqlRunnable(CURL_CMD, {
      hasPsql: () => false,
      getDatabaseUrl: () => undefined,
    });
    expect(result).toEqual({ runnable: true });
  });

  it('returns runnable=false with actionable reason when DATABASE_URL is unset', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => undefined,
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/DATABASE_URL is not set/);
      expect(result.reason).toMatch(/DB access|export DATABASE_URL/);
    }
  });

  it('returns runnable=false when DATABASE_URL is empty string', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => '',
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/DATABASE_URL is not set/);
    }
  });

  it('returns runnable=false when DATABASE_URL is whitespace-only', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => '   ',
    });
    expect(result.runnable).toBe(false);
  });

  it('returns runnable=false with actionable reason when psql is not on PATH', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => false,
      getDatabaseUrl: () => 'postgres://localhost/test',
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/psql is not installed/);
      expect(result.reason).toMatch(/Install the Postgres client|machine with psql/);
    }
  });

  it('returns runnable=true when both psql is present and DATABASE_URL is set', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => 'postgres://localhost/test',
    });
    expect(result).toEqual({ runnable: true });
  });

  it('prioritizes DATABASE_URL check over psql check', () => {
    // When both are missing, the DATABASE_URL message is more actionable
    // (env vars are faster to set than installing a binary).
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => false,
      getDatabaseUrl: () => undefined,
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/DATABASE_URL/);
      expect(result.reason).not.toMatch(/psql is not installed/);
    }
  });

  it('does not match commands that merely contain "psql" as a substring', () => {
    // `\bpsql\b` boundary means "psqlfoo" or "mypsql" shouldn't trigger
    const result = checkPsqlRunnable('echo mypsqlbar', {
      hasPsql: () => false,
      getDatabaseUrl: () => undefined,
    });
    expect(result).toEqual({ runnable: true });
  });
});

describe('isPatBlockedError (QUA-409)', () => {
  it('matches the canonical GitHub PAT error string', () => {
    expect(
      isPatBlockedError(
        'could not create workflow dispatch event: HTTP 403: Resource not accessible by personal access token',
      ),
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isPatBlockedError('RESOURCE NOT ACCESSIBLE BY PERSONAL ACCESS TOKEN')).toBe(true);
  });

  it('matches fine-grained PAT / installation token variants', () => {
    expect(isPatBlockedError('HTTP 403: Resource not accessible by integration')).toBe(true);
    expect(isPatBlockedError('HTTP 403: Resource not accessible by user')).toBe(true);
  });

  it('does NOT match unrelated 403s or other errors', () => {
    expect(isPatBlockedError('HTTP 403: forbidden')).toBe(false);
    expect(isPatBlockedError('HTTP 403: Must have admin rights')).toBe(false);
    expect(isPatBlockedError('psql: connection refused')).toBe(false);
    expect(isPatBlockedError('HTTP 404: Not Found')).toBe(false);
  });

  it('handles empty / undefined output safely', () => {
    expect(isPatBlockedError(undefined)).toBe(false);
    expect(isPatBlockedError('')).toBe(false);
  });
});
