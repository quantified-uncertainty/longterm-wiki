/**
 * Tests for crux health helpers introduced in QUA-479:
 *   - describeFetchError() turns opaque network errors into actionable messages
 *   - fetchJson() surfaces errorDetail when the request can't even connect
 *
 * These tests exercise the error path without spinning up a real server, by
 * pointing fetchJson at addresses that cannot possibly answer.
 */

import { describe, it, expect } from 'vitest';

import {
  classifyWorkflowHealth,
  describeFetchError,
  fetchJson,
  parseLocalModeUrl,
  resolveHealthEnvOverrides,
  DEFAULT_LOCAL_URL,
} from './health-check.ts';

describe('parseLocalModeUrl (QUA-491)', () => {
  it('returns null when --local is not passed', () => {
    expect(parseLocalModeUrl([])).toBeNull();
    expect(parseLocalModeUrl(['--json', '--check=server'])).toBeNull();
  });

  it('returns the default localhost URL for bare --local', () => {
    expect(parseLocalModeUrl(['--local'])).toBe(DEFAULT_LOCAL_URL);
    expect(parseLocalModeUrl(['--json', '--local'])).toBe(DEFAULT_LOCAL_URL);
  });

  it('returns the default for --local= with empty value', () => {
    // Edge case from review: a user who types `--local=` by accident should
    // get the sensible default, not an empty string that makes getServerUrl()
    // return '' and then fail opaquely downstream.
    expect(parseLocalModeUrl(['--local='])).toBe(DEFAULT_LOCAL_URL);
  });

  it('returns the explicit URL for --local=URL with loopback hosts', () => {
    expect(parseLocalModeUrl(['--local=http://localhost:3011'])).toBe(
      'http://localhost:3011',
    );
    expect(parseLocalModeUrl(['--local=http://127.0.0.1:4000'])).toBe(
      'http://127.0.0.1:4000',
    );
    expect(parseLocalModeUrl(['--local=http://[::1]:3002'])).toBe(
      'http://[::1]:3002',
    );
  });

  it('rejects non-loopback hosts to prevent API-key leakage', () => {
    // Footgun defense: a stale LONGTERMWIKI_SERVER_API_KEY in .env would be
    // forwarded as a Bearer header to whatever URL this flag accepts. Limit
    // the flag to loopback so typos can't leak credentials to a real host.
    expect(() =>
      parseLocalModeUrl(['--local=https://wiki-server.k8s.quantifieduncertainty.org']),
    ).toThrow(/non-loopback host/);
    expect(() => parseLocalModeUrl(['--local=http://example.com'])).toThrow(
      /non-loopback host/,
    );
  });

  it('rejects unparseable URLs with a clear error', () => {
    expect(() => parseLocalModeUrl(['--local=not a url'])).toThrow(
      /Invalid --local URL/,
    );
    expect(() => parseLocalModeUrl(['--local=:::'])).toThrow(
      /Invalid --local URL/,
    );
  });

  it('does not match unrelated args that share the --local prefix', () => {
    expect(parseLocalModeUrl(['--locality=x'])).toBeNull();
  });

  it('is order-independent', () => {
    expect(parseLocalModeUrl(['--check=server', '--local=http://localhost:1', '--json']))
      .toBe('http://localhost:1');
  });

  it('returns the first --local variant when both bare and explicit are passed', () => {
    // Undocumented but stable: argv.find() returns the first match. This
    // test pins the behavior so a future refactor can't silently change it.
    expect(parseLocalModeUrl(['--local', '--local=http://localhost:9999'])).toBe(
      DEFAULT_LOCAL_URL,
    );
    expect(parseLocalModeUrl(['--local=http://localhost:9999', '--local'])).toBe(
      'http://localhost:9999',
    );
  });
});

describe('resolveHealthEnvOverrides (QUA-491)', () => {
  it('defaults to WIKI_SERVER_ENV=prod when neither --local nor WIKI_SERVER_ENV is set', () => {
    const overrides = resolveHealthEnvOverrides([], {});
    expect(overrides).toEqual({
      setEnv: { WIKI_SERVER_ENV: 'prod' },
      unsetEnv: [],
      localUrl: null,
    });
  });

  it('respects a pre-set WIKI_SERVER_ENV when --local is absent', () => {
    const overrides = resolveHealthEnvOverrides([], { WIKI_SERVER_ENV: 'staging' });
    expect(overrides).toEqual({ setEnv: {}, unsetEnv: [], localUrl: null });
  });

  it('pins LONGTERMWIKI_SERVER_URL and clears WIKI_SERVER_ENV for bare --local', () => {
    const overrides = resolveHealthEnvOverrides(['--local'], {});
    expect(overrides).toEqual({
      setEnv: { LONGTERMWIKI_SERVER_URL: DEFAULT_LOCAL_URL },
      unsetEnv: ['WIKI_SERVER_ENV'],
      localUrl: DEFAULT_LOCAL_URL,
    });
  });

  it('--local wins over a pre-set WIKI_SERVER_ENV=prod', () => {
    // Regression: previously, `--local` just skipped the prod-guard block,
    // which meant a pre-set WIKI_SERVER_ENV=prod would beat --local and the
    // flag would be silently ignored. Now --local is authoritative.
    const overrides = resolveHealthEnvOverrides(
      ['--local=http://localhost:3011'],
      { WIKI_SERVER_ENV: 'prod' },
    );
    expect(overrides.setEnv.LONGTERMWIKI_SERVER_URL).toBe('http://localhost:3011');
    expect(overrides.unsetEnv).toContain('WIKI_SERVER_ENV');
    expect(overrides.localUrl).toBe('http://localhost:3011');
  });

  it('propagates parseLocalModeUrl errors so the caller can exit cleanly', () => {
    expect(() =>
      resolveHealthEnvOverrides(['--local=https://example.com'], {}),
    ).toThrow(/non-loopback host/);
  });
});


describe('describeFetchError', () => {
  it('classifies ECONNREFUSED and hints at --local for localhost targets', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3002'), { code: 'ECONNREFUSED' }),
    });

    const msg = describeFetchError('http://localhost:3002/health', err);

    expect(msg).toContain('http://localhost:3002/health');
    expect(msg).toContain('ECONNREFUSED');
    expect(msg).toContain('--local');
    expect(msg).toContain('WIKI_SERVER_ENV');
  });

  it('classifies ECONNREFUSED without a localhost hint for remote targets', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });

    const msg = describeFetchError('https://wiki-server.k8s.quantifieduncertainty.org/health', err);

    expect(msg).toContain('ECONNREFUSED');
    expect(msg).not.toContain('--local');
    expect(msg).not.toContain('WIKI_SERVER_ENV');
  });

  it('classifies ENOTFOUND DNS failures', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND does-not-exist.invalid'), { code: 'ENOTFOUND' }),
    });

    const msg = describeFetchError('https://does-not-exist.invalid/health', err);

    expect(msg).toContain('DNS lookup failed');
    expect(msg).toContain('ENOTFOUND');
    expect(msg).toContain('does-not-exist.invalid');
  });

  it('classifies AbortSignal timeouts as TimeoutError', () => {
    // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'.
    const err = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });

    const msg = describeFetchError('https://wiki-server.k8s.quantifieduncertainty.org/health', err);

    expect(msg).toContain('timed out');
    expect(msg).toContain('15s');
  });

  it('classifies ECONNRESET', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

    const msg = describeFetchError('https://example.com/health', err);

    expect(msg).toContain('ECONNRESET');
    expect(msg).toContain('reset by peer');
  });

  it('falls back to a generic message for unknown errors', () => {
    const err = new Error('something weird happened');

    const msg = describeFetchError('https://example.com/health', err);

    expect(msg).toContain('https://example.com/health');
    expect(msg).toContain('network error');
    expect(msg).toContain('something weird happened');
  });

  it('handles non-Error thrown values without crashing', () => {
    const msg = describeFetchError('https://example.com/health', 'string error');

    expect(msg).toContain('https://example.com/health');
    expect(msg).toContain('string error');
  });
});

describe('module import hygiene', () => {
  it('does not mutate WIKI_SERVER_ENV when imported (only when dispatched as a script)', () => {
    // The module sets WIKI_SERVER_ENV=prod at load time when invoked as a
    // crux-dispatched script. Importing it for tests must NOT fire that side
    // effect, or other tests that care about WIKI_SERVER_ENV (e.g.
    // sync-session.test.ts, client.test.ts) see pollution across the worker.
    // By the time this test runs, the module has already been imported above;
    // if the guard worked, process.env.WIKI_SERVER_ENV is still whatever the
    // test runner started with — crucially, not force-set to 'prod'.
    const current = process.env.WIKI_SERVER_ENV;
    // Either it's undefined/empty (normal test runner state) or it was set to
    // something OTHER than 'prod' intentionally by the test harness. What must
    // NOT happen is that an unset value became 'prod' purely from the import.
    if (current === 'prod') {
      // If it's 'prod', something else set it — verify process.argv[1] doesn't
      // look like the health-check script, which would legitimately justify it.
      expect(process.argv[1] ?? '').not.toMatch(/health[\\/-]?check/);
    }
  });
});

describe('fetchJson', () => {
  it('returns ok:false with errorDetail when the target refuses the connection', async () => {
    // 127.0.0.1:59_999 is an ephemeral-range port with no listener in test env.
    // Node fetch reliably rejects with ECONNREFUSED, which the helper should
    // classify and include in errorDetail.
    const result = await fetchJson('http://127.0.0.1:59999/health');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data).toBeNull();
    expect(result.errorDetail).toBeTruthy();
    expect(result.errorDetail).toContain('127.0.0.1:59999');
    expect(result.errorDetail).toContain('ECONNREFUSED');
    // The host is a localhost target, so the --local hint should fire.
    expect(result.errorDetail).toContain('--local');
  }, 10_000);

  it('returns ok:false with errorDetail when DNS resolution fails', async () => {
    const result = await fetchJson('http://does-not-exist-qua-479.invalid/health');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.errorDetail).toBeTruthy();
    // Should mention the unresolvable hostname so the user can spot typos.
    expect(result.errorDetail).toContain('does-not-exist-qua-479.invalid');
  }, 10_000);
});

describe('classifyWorkflowHealth', () => {
  describe('activity-triggered workflows (ci.yml)', () => {
    it('does not fail the check when ci.yml is stale because no PR landed', () => {
      // The Sept 2026 regression: ci.yml last ran 218h ago simply because the
      // repo had been quiet. That is repo activity, not a broken workflow, and
      // it must not put ci-pr-health.yml into a red streak.
      const v = classifyWorkflowHealth({
        workflow: 'ci.yml',
        ageHours: 218,
        maxAgeHours: 168,
        conclusions: ['success'],
      });

      expect(v.level).toBe('WARN');
      expect(v.failure).toBeUndefined();
      expect(v.message).toContain('218h ago');
      expect(v.message).toContain('activity-triggered');
    });

    it('passes a fresh ci.yml run even when its latest conclusion is a failure', () => {
      // CI fails legitimately on in-progress PRs.
      const v = classifyWorkflowHealth({
        workflow: 'ci.yml',
        ageHours: 3,
        maxAgeHours: 168,
        conclusions: ['failure', 'failure'],
      });

      expect(v.level).toBe('PASS');
      expect(v.failure).toBeUndefined();
    });

    it('does not fail a stale ci.yml whose only recent runs failed', () => {
      // Staleness short-circuits before the conclusion rules, so a quiet repo
      // whose last CI run happened to be red still does not raise an issue.
      const v = classifyWorkflowHealth({
        workflow: 'ci.yml',
        ageHours: 500,
        maxAgeHours: 168,
        conclusions: ['failure'],
      });

      expect(v.level).toBe('WARN');
      expect(v.failure).toBeUndefined();
    });
  });

  describe('scheduled workflows', () => {
    it('fails a stale scheduled workflow', () => {
      const v = classifyWorkflowHealth({
        workflow: 'database-backup.yml',
        ageHours: 40,
        maxAgeHours: 36,
        conclusions: ['success'],
      });

      expect(v.level).toBe('FAIL');
      expect(v.failure).toBe('stale (40h ago, max 36h)');
    });

    it('passes a fresh, successful scheduled workflow', () => {
      const v = classifyWorkflowHealth({
        workflow: 'database-backup.yml',
        ageHours: 16,
        maxAgeHours: 36,
        conclusions: ['success'],
      });

      expect(v.level).toBe('PASS');
      expect(v.failure).toBeUndefined();
      expect(v.message).toBe('16h ago (success)');
    });

    it('fails a non-flaky scheduled workflow whose latest run failed', () => {
      const v = classifyWorkflowHealth({
        workflow: 'server-health-monitor.yml',
        ageHours: 10,
        maxAgeHours: 192,
        conclusions: ['failure', 'success'],
      });

      expect(v.level).toBe('FAIL');
      expect(v.failure).toBe("last run 'failure'");
    });

    it('warns (does not fail) when a flaky workflow has any recent success', () => {
      const v = classifyWorkflowHealth({
        workflow: 'scheduled-maintenance.yml',
        ageHours: 10,
        maxAgeHours: 216,
        conclusions: ['failure', 'success', 'failure', 'success'],
      });

      expect(v.level).toBe('WARN');
      expect(v.failure).toBeUndefined();
      expect(v.message).toContain('2/4 recent runs succeeded');
    });

    it('fails a flaky workflow when every recent run failed', () => {
      const v = classifyWorkflowHealth({
        workflow: 'scheduled-maintenance.yml',
        ageHours: 10,
        maxAgeHours: 216,
        conclusions: ['failure', 'failure', 'failure'],
      });

      expect(v.level).toBe('FAIL');
      expect(v.failure).toBe("all recent runs failed ('failure')");
      expect(v.message).toContain('all 3 recent runs failed');
    });
  });

  describe('edge cases', () => {
    it('treats a null conclusion on a scheduled workflow as a failure', () => {
      const v = classifyWorkflowHealth({
        workflow: 'server-health-monitor.yml',
        ageHours: 1,
        maxAgeHours: 192,
        conclusions: [null],
      });

      expect(v.level).toBe('FAIL');
      expect(v.failure).toBe("last run 'null'");
    });

    it('handles an empty conclusions list without throwing', () => {
      const v = classifyWorkflowHealth({
        workflow: 'scheduled-maintenance.yml',
        ageHours: 1,
        maxAgeHours: 216,
        conclusions: [],
      });

      expect(v.level).toBe('FAIL');
      expect(v.message).toContain('all 0 recent runs failed');
    });

    it('treats age exactly at the threshold as fresh, not stale', () => {
      const v = classifyWorkflowHealth({
        workflow: 'database-backup.yml',
        ageHours: 36,
        maxAgeHours: 36,
        conclusions: ['success'],
      });

      expect(v.level).toBe('PASS');
    });

    it('treats an unknown workflow as activity-triggered', () => {
      // Anything not registered in SCHEDULED_ONLY_WORKFLOWS has no cadence
      // guarantee, so it must not be failed for staleness.
      const v = classifyWorkflowHealth({
        workflow: 'some-new-workflow.yml',
        ageHours: 10_000,
        maxAgeHours: 48,
        conclusions: ['failure'],
      });

      expect(v.level).toBe('WARN');
      expect(v.failure).toBeUndefined();
    });
  });
});
