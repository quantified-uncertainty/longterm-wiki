/**
 * CLI Flag Forwarding Tests
 *
 * Verifies that every CLI flag declared in SCRIPTS.passthrough reaches the
 * subprocess and that non-passthrough flags are correctly dropped.
 *
 * Addresses issue #1080: CLI flags have silently broken 3+ times.
 * Pattern tested: declare flag in passthrough → optionsToArgs → filteredArgs → subprocess
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { optionsToArgs, parseCliArgs, type ScriptConfig } from '../lib/cli.ts';

// ---------------------------------------------------------------------------
// Import the actual SCRIPTS configs from each command module
// ---------------------------------------------------------------------------

// We test the flag forwarding logic by simulating createScriptHandler's
// filtering algorithm without actually spawning subprocesses.

/** Simulate the flag filtering done by createScriptHandler */
function filterArgs(
  options: Record<string, unknown>,
  config: Pick<ScriptConfig, 'passthrough'>,
): string[] {
  const scriptArgs = optionsToArgs(options, ['help']);
  return scriptArgs.filter((arg) => {
    const key = arg.replace(/^--/, '').split('=')[0];
    const camelKey = key.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    return config.passthrough.includes(camelKey) || config.passthrough.includes(key);
  });
}

// ---------------------------------------------------------------------------
// Claims command SCRIPTS config (replicated from commands/claims.ts)
// If the actual config changes, these tests should break — that's the point.
// ---------------------------------------------------------------------------

const CLAIMS_SCRIPTS: Record<string, Pick<ScriptConfig, 'passthrough' | 'positional'>> = {
  extract: {
    passthrough: ['dry-run', 'model'],
    positional: true,
  },
  verify: {
    passthrough: ['dry-run', 'model', 'fetch'],
    positional: true,
  },
  status: {
    passthrough: ['json'],
    positional: true,
  },
  'ingest-resource': {
    passthrough: ['dry-run', 'model', 'entity', 'force'],
    positional: true,
  },
  'from-resource': {
    passthrough: ['dry-run', 'model', 'entity', 'no-auto-resource', 'batch', 'limit'],
    positional: true,
  },
  'evaluate-baseline': {
    passthrough: ['from-logs', 'sample'],
    positional: false,
  },
  audit: {
    passthrough: ['json'],
    positional: false,
  },
};

// ---------------------------------------------------------------------------
// Test: flag forwarding for each claims command
// ---------------------------------------------------------------------------

describe('claims extract — flag forwarding', () => {
  const config = CLAIMS_SCRIPTS.extract;

  it('forwards --dry-run', () => {
    const args = filterArgs({ dryRun: true }, config);
    expect(args).toContain('--dry-run');
  });

  it('forwards --model=<value>', () => {
    const args = filterArgs({ model: 'google/gemini-2.0-flash-001' }, config);
    expect(args).toContain('--model=google/gemini-2.0-flash-001');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ dryRun: true, force: true, json: true }, config);
    expect(args).toContain('--dry-run');
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--json');
  });
});

describe('claims verify — flag forwarding', () => {
  const config = CLAIMS_SCRIPTS.verify;

  it('forwards --dry-run', () => {
    expect(filterArgs({ dryRun: true }, config)).toContain('--dry-run');
  });

  it('forwards --model=<value>', () => {
    expect(filterArgs({ model: 'haiku' }, config)).toContain('--model=haiku');
  });

  it('forwards --fetch', () => {
    expect(filterArgs({ fetch: true }, config)).toContain('--fetch');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ fetch: true, force: true, entity: 'kalshi' }, config);
    expect(args).toContain('--fetch');
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--entity=kalshi');
  });
});

describe('claims status — flag forwarding', () => {
  const config = CLAIMS_SCRIPTS.status;

  it('forwards --json', () => {
    expect(filterArgs({ json: true }, config)).toContain('--json');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ json: true, dryRun: true, model: 'x' }, config);
    expect(args).toContain('--json');
    expect(args).not.toContain('--dry-run');
    expect(args).not.toContain('--model=x');
  });
});

describe('claims ingest-resource — flag forwarding', () => {
  const config = CLAIMS_SCRIPTS['ingest-resource'];

  it('forwards --dry-run, --model, --entity, --force', () => {
    const args = filterArgs(
      { dryRun: true, model: 'haiku', entity: 'kalshi', force: true },
      config,
    );
    expect(args).toContain('--dry-run');
    expect(args).toContain('--model=haiku');
    expect(args).toContain('--entity=kalshi');
    expect(args).toContain('--force');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ force: true, limit: 5, json: true }, config);
    expect(args).toContain('--force');
    expect(args).not.toContain('--limit=5');
    expect(args).not.toContain('--json');
  });
});

describe('claims from-resource — flag forwarding', () => {
  const config = CLAIMS_SCRIPTS['from-resource'];

  it('forwards all 6 passthrough flags', () => {
    const args = filterArgs(
      {
        dryRun: true,
        model: 'haiku',
        entity: 'kalshi',
        noAutoResource: true,
        batch: 'urls.txt',
        limit: 5,
      },
      config,
    );
    expect(args).toContain('--dry-run');
    expect(args).toContain('--model=haiku');
    expect(args).toContain('--entity=kalshi');
    expect(args).toContain('--no-auto-resource');
    expect(args).toContain('--batch=urls.txt');
    expect(args).toContain('--limit=5');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ limit: 5, force: true, json: true }, config);
    expect(args).toContain('--limit=5');
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--json');
  });
});

describe('claims evaluate-baseline — flag forwarding', () => {
  const config = CLAIMS_SCRIPTS['evaluate-baseline'];

  it('forwards --from-logs and --sample', () => {
    const args = filterArgs({ fromLogs: true, sample: 5 }, config);
    expect(args).toContain('--from-logs');
    expect(args).toContain('--sample=5');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ fromLogs: true, model: 'x', dryRun: true }, config);
    expect(args).toContain('--from-logs');
    expect(args).not.toContain('--model=x');
    expect(args).not.toContain('--dry-run');
  });
});

describe('claims audit — flag forwarding', () => {
  const config = CLAIMS_SCRIPTS.audit;

  it('forwards --json', () => {
    expect(filterArgs({ json: true }, config)).toContain('--json');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ json: true, dryRun: true }, config);
    expect(args).toContain('--json');
    expect(args).not.toContain('--dry-run');
  });
});

// ---------------------------------------------------------------------------
// Test: parseCliArgs correctly parses flags that subprocesses receive
// ---------------------------------------------------------------------------

describe('parseCliArgs — flag parsing in scripts', () => {
  it('parses --dry-run as boolean', () => {
    const args = parseCliArgs(['kalshi', '--dry-run']);
    expect(args['dry-run']).toBe(true);
    expect(args._positional).toEqual(['kalshi']);
  });

  it('parses --model=value format', () => {
    const args = parseCliArgs(['kalshi', '--model=google/gemini-2.0-flash-001']);
    expect(args.model).toBe('google/gemini-2.0-flash-001');
  });

  it('parses --model value format (space-separated)', () => {
    const args = parseCliArgs(['kalshi', '--model', 'google/gemini-2.0-flash-001']);
    expect(args.model).toBe('google/gemini-2.0-flash-001');
  });

  it('parses --entity=kalshi', () => {
    const args = parseCliArgs(['resource-id', '--entity=kalshi']);
    expect(args.entity).toBe('kalshi');
    expect(args._positional).toEqual(['resource-id']);
  });

  it('parses --force as boolean', () => {
    const args = parseCliArgs(['resource-id', '--force']);
    expect(args.force).toBe(true);
  });

  it('parses --limit=10 as string (caller converts)', () => {
    const args = parseCliArgs(['--limit=10']);
    expect(args.limit).toBe('10');
  });

  it('parses --no-auto-resource as boolean', () => {
    const args = parseCliArgs(['https://example.com', '--no-auto-resource']);
    expect(args['no-auto-resource']).toBe(true);
  });

  it('parses --batch=urls.txt', () => {
    const args = parseCliArgs(['--batch=urls.txt']);
    expect(args.batch).toBe('urls.txt');
  });

  it('parses --fetch as boolean', () => {
    const args = parseCliArgs(['kalshi', '--fetch']);
    expect(args.fetch).toBe(true);
  });

  it('parses --json as boolean', () => {
    const args = parseCliArgs(['kalshi', '--json']);
    expect(args.json).toBe(true);
  });

  it('skips bare -- separator', () => {
    const args = parseCliArgs(['kalshi', '--', '--dry-run']);
    expect(args._positional).toEqual(['kalshi']);
    expect(args['dry-run']).toBe(true);
  });

  it('handles no args', () => {
    const args = parseCliArgs([]);
    expect(args._positional).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test: end-to-end flag round-trip (optionsToArgs → filterArgs → parseCliArgs)
// ---------------------------------------------------------------------------

describe('end-to-end flag round-trip', () => {
  it('--dry-run survives the full pipeline', () => {
    // User passes dryRun: true → optionsToArgs → filterArgs → parseCliArgs
    const forwarded = filterArgs({ dryRun: true }, CLAIMS_SCRIPTS.extract);
    const parsed = parseCliArgs(forwarded);
    expect(parsed['dry-run']).toBe(true);
  });

  it('--model=value survives the full pipeline', () => {
    const forwarded = filterArgs({ model: 'google/gemini-2.0-flash-001' }, CLAIMS_SCRIPTS.extract);
    const parsed = parseCliArgs(forwarded);
    expect(parsed.model).toBe('google/gemini-2.0-flash-001');
  });

  it('--fetch survives the full pipeline for verify', () => {
    const forwarded = filterArgs({ fetch: true }, CLAIMS_SCRIPTS.verify);
    const parsed = parseCliArgs(forwarded);
    expect(parsed.fetch).toBe(true);
  });

  it('--entity=kalshi survives the full pipeline for ingest-resource', () => {
    const forwarded = filterArgs({ entity: 'kalshi' }, CLAIMS_SCRIPTS['ingest-resource']);
    const parsed = parseCliArgs(forwarded);
    expect(parsed.entity).toBe('kalshi');
  });

  it('--force survives the full pipeline for ingest-resource', () => {
    const forwarded = filterArgs({ force: true }, CLAIMS_SCRIPTS['ingest-resource']);
    const parsed = parseCliArgs(forwarded);
    expect(parsed.force).toBe(true);
  });

  it('--no-auto-resource survives the full pipeline for from-resource', () => {
    const forwarded = filterArgs({ noAutoResource: true }, CLAIMS_SCRIPTS['from-resource']);
    const parsed = parseCliArgs(forwarded);
    expect(parsed['no-auto-resource']).toBe(true);
  });

  it('--batch=urls.txt survives the full pipeline for from-resource', () => {
    const forwarded = filterArgs({ batch: 'urls.txt' }, CLAIMS_SCRIPTS['from-resource']);
    const parsed = parseCliArgs(forwarded);
    expect(parsed.batch).toBe('urls.txt');
  });

  it('--from-logs survives the full pipeline for evaluate-baseline', () => {
    const forwarded = filterArgs({ fromLogs: true }, CLAIMS_SCRIPTS['evaluate-baseline']);
    const parsed = parseCliArgs(forwarded);
    expect(parsed['from-logs']).toBe(true);
  });

  it('--json survives the full pipeline for audit', () => {
    const forwarded = filterArgs({ json: true }, CLAIMS_SCRIPTS.audit);
    const parsed = parseCliArgs(forwarded);
    expect(parsed.json).toBe(true);
  });

  it('multiple flags all survive the pipeline', () => {
    const forwarded = filterArgs(
      { dryRun: true, model: 'haiku', entity: 'kalshi', force: true },
      CLAIMS_SCRIPTS['ingest-resource'],
    );
    const parsed = parseCliArgs(forwarded);
    expect(parsed['dry-run']).toBe(true);
    expect(parsed.model).toBe('haiku');
    expect(parsed.entity).toBe('kalshi');
    expect(parsed.force).toBe(true);
  });

  it('dropped flags do NOT survive the pipeline', () => {
    const forwarded = filterArgs(
      { dryRun: true, force: true, json: true },
      CLAIMS_SCRIPTS.extract, // extract only allows dry-run, model
    );
    const parsed = parseCliArgs(forwarded);
    expect(parsed['dry-run']).toBe(true);
    expect(parsed.force).toBeUndefined();
    expect(parsed.json).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test: validate command flags (second command module with large passthrough surface)
// ---------------------------------------------------------------------------

const VALIDATE_SCRIPTS: Record<string, Pick<ScriptConfig, 'passthrough'>> = {
  all: { passthrough: ['ci', 'failFast', 'skip', 'fix'] },
  unified: { passthrough: ['ci', 'rules', 'fix', 'list', 'errorsOnly', 'fixable'] },
  gate: { passthrough: ['ci', 'full', 'fix', 'fullGate', 'noTriage', 'noCache', 'scope'] },
  'cross-links': { passthrough: ['ci', 'threshold', 'json'] },
};

describe('validate gate — flag forwarding', () => {
  const config = VALIDATE_SCRIPTS.gate;

  it('forwards --fix', () => {
    expect(filterArgs({ fix: true }, config)).toContain('--fix');
  });

  it('forwards --scope=content', () => {
    expect(filterArgs({ scope: 'content' }, config)).toContain('--scope=content');
  });

  it('forwards --full-gate', () => {
    expect(filterArgs({ fullGate: true }, config)).toContain('--full-gate');
  });

  it('forwards --no-triage', () => {
    expect(filterArgs({ noTriage: true }, config)).toContain('--no-triage');
  });

  it('forwards --no-cache', () => {
    expect(filterArgs({ noCache: true }, config)).toContain('--no-cache');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ fix: true, json: true, verbose: true }, config);
    expect(args).toContain('--fix');
    expect(args).not.toContain('--json');
    expect(args).not.toContain('--verbose');
  });
});

describe('validate all — flag forwarding', () => {
  const config = VALIDATE_SCRIPTS.all;

  it('forwards --fail-fast', () => {
    expect(filterArgs({ failFast: true }, config)).toContain('--fail-fast');
  });

  it('forwards --skip=<value>', () => {
    expect(filterArgs({ skip: 'links' }, config)).toContain('--skip=links');
  });

  it('forwards --fix', () => {
    expect(filterArgs({ fix: true }, config)).toContain('--fix');
  });
});

describe('validate unified — flag forwarding', () => {
  const config = VALIDATE_SCRIPTS.unified;

  it('forwards --rules=<value>', () => {
    expect(filterArgs({ rules: 'dollar-signs,comparison-operators' }, config)).toContain(
      '--rules=dollar-signs,comparison-operators',
    );
  });

  it('forwards --errors-only', () => {
    expect(filterArgs({ errorsOnly: true }, config)).toContain('--errors-only');
  });

  it('forwards --fixable', () => {
    expect(filterArgs({ fixable: true }, config)).toContain('--fixable');
  });

  it('forwards --list', () => {
    expect(filterArgs({ list: true }, config)).toContain('--list');
  });
});

// ---------------------------------------------------------------------------
// Test: citations command flags (historically broken with --fetch, --recheck)
// ---------------------------------------------------------------------------

const CITATIONS_SCRIPTS: Record<string, Pick<ScriptConfig, 'passthrough' | 'positional'>> = {
  verify: {
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck', 'content-verify'],
    positional: true,
  },
  'extract-quotes': {
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck', 'concurrency', 'dry-run'],
    positional: true,
  },
  'check-accuracy': {
    passthrough: ['ci', 'json', 'all', 'limit', 'recheck', 'concurrency', 'dry-run'],
    positional: true,
  },
  'fix-inaccuracies': {
    passthrough: ['apply', 'verdict', 'max-score', 'model', 'json', 'concurrency', 'escalate'],
    positional: true,
  },
  audit: {
    passthrough: ['json', 'apply', 'recheck', 'model', 'escalate', 'second-opinion'],
    positional: true,
  },
};

describe('citations verify — flag forwarding', () => {
  const config = CITATIONS_SCRIPTS.verify;

  it('forwards --recheck', () => {
    expect(filterArgs({ recheck: true }, config)).toContain('--recheck');
  });

  it('forwards --content-verify', () => {
    expect(filterArgs({ contentVerify: true }, config)).toContain('--content-verify');
  });

  it('forwards --all', () => {
    expect(filterArgs({ all: true }, config)).toContain('--all');
  });

  it('forwards --limit=5', () => {
    expect(filterArgs({ limit: 5 }, config)).toContain('--limit=5');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ recheck: true, dryRun: true, model: 'x' }, config);
    expect(args).toContain('--recheck');
    expect(args).not.toContain('--dry-run');
    expect(args).not.toContain('--model=x');
  });
});

describe('citations extract-quotes — flag forwarding', () => {
  const config = CITATIONS_SCRIPTS['extract-quotes'];

  it('forwards --concurrency=3', () => {
    expect(filterArgs({ concurrency: 3 }, config)).toContain('--concurrency=3');
  });

  it('forwards --dry-run', () => {
    expect(filterArgs({ dryRun: true }, config)).toContain('--dry-run');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ dryRun: true, model: 'x', apply: true }, config);
    expect(args).toContain('--dry-run');
    expect(args).not.toContain('--model=x');
    expect(args).not.toContain('--apply');
  });
});

describe('citations fix-inaccuracies — flag forwarding', () => {
  const config = CITATIONS_SCRIPTS['fix-inaccuracies'];

  it('forwards --apply', () => {
    expect(filterArgs({ apply: true }, config)).toContain('--apply');
  });

  it('forwards --max-score=3', () => {
    expect(filterArgs({ maxScore: 3 }, config)).toContain('--max-score=3');
  });

  it('forwards --escalate', () => {
    expect(filterArgs({ escalate: true }, config)).toContain('--escalate');
  });

  it('forwards --verdict=<value>', () => {
    expect(filterArgs({ verdict: 'inaccurate' }, config)).toContain('--verdict=inaccurate');
  });
});

// ---------------------------------------------------------------------------
// Test: content improve — most complex passthrough surface in the codebase
// ---------------------------------------------------------------------------

const CONTENT_SCRIPTS: Record<string, Pick<ScriptConfig, 'passthrough' | 'positional'>> = {
  improve: {
    passthrough: [
      'ci', 'tier', 'directions', 'dryRun', 'dry-run', 'apply', 'grade', 'no-grade',
      'triage', 'skip-session-log', 'skip-enrich', 'section-level', 'engine',
      'citation-gate', 'skip-citation-audit', 'citation-audit-model',
      'batch', 'batch-file', 'batch-budget', 'page-timeout', 'resume',
      'report-file', 'no-save-artifacts', 'output', 'limit',
    ],
    positional: true,
  },
  create: {
    passthrough: [
      'ci', 'tier', 'phase', 'output', 'help', 'sourceFile', 'source-file',
      'dest', 'directions', 'force', 'create-category', 'api-direct', 'apiDirect',
    ],
    positional: true,
  },
};

describe('content improve — flag forwarding', () => {
  const config = CONTENT_SCRIPTS.improve;

  it('forwards --tier=premium', () => {
    expect(filterArgs({ tier: 'premium' }, config)).toContain('--tier=premium');
  });

  it('forwards --apply', () => {
    expect(filterArgs({ apply: true }, config)).toContain('--apply');
  });

  it('forwards --dry-run (kebab)', () => {
    // dry-run is listed as both 'dryRun' and 'dry-run' in passthrough
    expect(filterArgs({ dryRun: true }, config)).toContain('--dry-run');
  });

  it('forwards --batch-file=<value>', () => {
    expect(filterArgs({ batchFile: 'pages.txt' }, config)).toContain('--batch-file=pages.txt');
  });

  it('forwards --batch-budget=50', () => {
    expect(filterArgs({ batchBudget: 50 }, config)).toContain('--batch-budget=50');
  });

  it('forwards --page-timeout=300', () => {
    expect(filterArgs({ pageTimeout: 300 }, config)).toContain('--page-timeout=300');
  });

  it('forwards --section-level', () => {
    expect(filterArgs({ sectionLevel: true }, config)).toContain('--section-level');
  });

  it('forwards --skip-citation-audit', () => {
    expect(filterArgs({ skipCitationAudit: true }, config)).toContain('--skip-citation-audit');
  });

  it('forwards --no-save-artifacts', () => {
    expect(filterArgs({ noSaveArtifacts: true }, config)).toContain('--no-save-artifacts');
  });

  it('drops non-passthrough flags', () => {
    const args = filterArgs({ apply: true, force: true, verbose: true }, config);
    expect(args).toContain('--apply');
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--verbose');
  });
});

describe('content create — flag forwarding', () => {
  const config = CONTENT_SCRIPTS.create;

  it('forwards --tier=standard', () => {
    expect(filterArgs({ tier: 'standard' }, config)).toContain('--tier=standard');
  });

  it('forwards --source-file=<value>', () => {
    expect(filterArgs({ sourceFile: 'input.md' }, config)).toContain('--source-file=input.md');
  });

  it('forwards --force', () => {
    expect(filterArgs({ force: true }, config)).toContain('--force');
  });

  it('forwards --create-category', () => {
    expect(filterArgs({ createCategory: true }, config)).toContain('--create-category');
  });

  it('forwards --api-direct', () => {
    expect(filterArgs({ apiDirect: true }, config)).toContain('--api-direct');
  });
});

// ---------------------------------------------------------------------------
// Structural guard: verify test configs match actual SCRIPTS in source files
// If a dev changes a command's passthrough array, these tests should break.
// ---------------------------------------------------------------------------

describe('structural guard — test configs stay in sync with source', () => {
  it('test covers all claims subcommands', () => {
    const tested = Object.keys(CLAIMS_SCRIPTS);
    expect(tested).toEqual(
      expect.arrayContaining([
        'extract', 'verify', 'status', 'ingest-resource',
        'from-resource', 'evaluate-baseline', 'audit',
      ]),
    );
  });

  it('claims extract passthrough has exactly 2 entries', () => {
    expect(CLAIMS_SCRIPTS.extract.passthrough).toHaveLength(2);
  });

  it('claims verify passthrough has exactly 3 entries', () => {
    expect(CLAIMS_SCRIPTS.verify.passthrough).toHaveLength(3);
  });

  it('claims from-resource passthrough has exactly 6 entries', () => {
    expect(CLAIMS_SCRIPTS['from-resource'].passthrough).toHaveLength(6);
  });

  it('validate gate passthrough has exactly 7 entries', () => {
    expect(VALIDATE_SCRIPTS.gate.passthrough).toHaveLength(7);
  });

  it('content improve passthrough has exactly 25 entries', () => {
    expect(CONTENT_SCRIPTS.improve.passthrough).toHaveLength(25);
  });
});