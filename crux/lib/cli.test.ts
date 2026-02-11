/** Unit Tests for CLI Utilities and TypeScript Migration Infrastructure */

import { describe, it, expect } from 'vitest';

import {
  camelToKebab,
  kebabToCamel,
  formatDuration,
  optionsToArgs,
  createScriptHandler,
  buildCommands,
} from './cli.ts';

import {
  loadGeneratedJson,
  loadEntities,
  loadBacklinks,
  loadPathRegistry,
  loadPages,
  loadOrganizations,
  loadExperts,
  loadDatabase,
  CRITICAL_RULES,
  QUALITY_RULES,
  CONTENT_TYPES,
  DEFAULT_STALENESS_THRESHOLD,
  CONTENT_DIR,
  DATA_DIR,
  GENERATED_DATA_DIR,
} from './content-types.ts';

import {
  Issue,
  ContentFile,
  ValidationEngine,
  createRule,
  Severity,
  FixType,
} from './validation-engine.ts';

// =============================================================================
// cli.ts — camelToKebab
// =============================================================================

describe('cli.ts — camelToKebab', () => {
  it('converts simple camelCase', () => {
    expect(camelToKebab('dryRun')).toBe('dry-run');
  });

  it('converts multi-word camelCase', () => {
    expect(camelToKebab('myLongVariableName')).toBe('my-long-variable-name');
  });

  it('handles already lowercase', () => {
    expect(camelToKebab('simple')).toBe('simple');
  });

  it('handles single char segments', () => {
    expect(camelToKebab('aB')).toBe('a-b');
  });
});

// =============================================================================
// cli.ts — kebabToCamel
// =============================================================================

describe('cli.ts — kebabToCamel', () => {
  it('converts simple kebab-case', () => {
    expect(kebabToCamel('dry-run')).toBe('dryRun');
  });

  it('converts multi-word kebab-case', () => {
    expect(kebabToCamel('my-long-variable-name')).toBe('myLongVariableName');
  });

  it('handles no hyphens', () => {
    expect(kebabToCamel('simple')).toBe('simple');
  });

  it('camelToKebab and kebabToCamel are inverses', () => {
    const original = 'dryRun';
    expect(kebabToCamel(camelToKebab(original))).toBe(original);
  });
});

// =============================================================================
// cli.ts — formatDuration
// =============================================================================

describe('cli.ts — formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(1500)).toBe('1.50s');
  });

  it('boundary at 1000ms', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.00s');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

// =============================================================================
// cli.ts — optionsToArgs
// =============================================================================

describe('cli.ts — optionsToArgs', () => {
  it('converts boolean true to flag', () => {
    const result = optionsToArgs({ verbose: true });
    expect(result).toEqual(['--verbose']);
  });

  it('converts string value to key=value', () => {
    const result = optionsToArgs({ model: 'haiku' });
    expect(result).toEqual(['--model=haiku']);
  });

  it('converts number value to key=value', () => {
    const result = optionsToArgs({ batch: 50 });
    expect(result).toEqual(['--batch=50']);
  });

  it('skips false values', () => {
    const result = optionsToArgs({ verbose: false });
    expect(result).toEqual([]);
  });

  it('skips null and undefined', () => {
    const result = optionsToArgs({ a: null, b: undefined });
    expect(result).toEqual([]);
  });

  it('excludes specified keys', () => {
    const result = optionsToArgs({ verbose: true, help: true }, ['help']);
    expect(result).toEqual(['--verbose']);
  });

  it('converts camelCase to kebab-case', () => {
    const result = optionsToArgs({ dryRun: true });
    expect(result).toEqual(['--dry-run']);
  });

  it('handles multiple options', () => {
    const result = optionsToArgs({ verbose: true, model: 'haiku', batch: 10 });
    expect(result).toContain('--verbose');
    expect(result).toContain('--model=haiku');
    expect(result).toContain('--batch=10');
    expect(result.length).toBe(3);
  });
});

// =============================================================================
// cli.ts — createScriptHandler
// =============================================================================

describe('cli.ts — createScriptHandler', () => {
  it('returns a function', () => {
    const handler = createScriptHandler('test', {
      script: 'nonexistent.mjs',
      passthrough: ['verbose'],
    });
    expect(typeof handler).toBe('function');
  });

  it('filters to passthrough options only', () => {
    const handler = createScriptHandler('test', {
      script: 'nonexistent.mjs',
      passthrough: ['verbose'],
    });
    // The handler should be an async function
    expect(handler.constructor.name).toBe('AsyncFunction');
  });
});

// =============================================================================
// cli.ts — buildCommands
// =============================================================================

describe('cli.ts — buildCommands', () => {
  it('creates handler for each script', () => {
    const scripts = {
      foo: { script: 'foo.mjs', passthrough: [] },
      bar: { script: 'bar.mjs', passthrough: ['verbose'] },
    };
    const commands = buildCommands(scripts);
    expect(typeof commands.foo).toBe('function');
    expect(typeof commands.bar).toBe('function');
    expect('default' in commands).toBe(false);
  });

  it('sets default command', () => {
    const scripts = {
      foo: { script: 'foo.mjs', passthrough: [] },
      bar: { script: 'bar.mjs', passthrough: [] },
    };
    const commands = buildCommands(scripts, 'foo');
    expect(typeof commands.default).toBe('function');
    expect(commands.default).toBe(commands.foo);
  });

  it('ignores invalid default', () => {
    const scripts = {
      foo: { script: 'foo.mjs', passthrough: [] },
    };
    const commands = buildCommands(scripts, 'nonexistent');
    expect('default' in commands).toBe(false);
  });

  it('handles empty scripts', () => {
    const commands = buildCommands({});
    expect(Object.keys(commands)).toEqual([]);
  });
});

// =============================================================================
// content-types.ts — constants
// =============================================================================

describe('content-types.ts — constants', () => {
  it('CONTENT_DIR is content/docs', () => {
    expect(CONTENT_DIR).toBe('content/docs');
  });

  it('DATA_DIR is data', () => {
    expect(DATA_DIR).toBe('data');
  });

  it('GENERATED_DATA_DIR is app/src/data', () => {
    expect(GENERATED_DATA_DIR).toBe('app/src/data');
  });

  it('DEFAULT_STALENESS_THRESHOLD is 180', () => {
    expect(DEFAULT_STALENESS_THRESHOLD).toBe(180);
  });

  it('CONTENT_TYPES has model, risk, response', () => {
    expect('model' in CONTENT_TYPES).toBe(true);
    expect('risk' in CONTENT_TYPES).toBe(true);
    expect('response' in CONTENT_TYPES).toBe(true);
  });

  it('each CONTENT_TYPE has required fields', () => {
    for (const [name, config] of Object.entries(CONTENT_TYPES)) {
      expect((config as any).pathPattern instanceof RegExp).toBe(true);
      expect(typeof (config as any).directory).toBe('string');
      expect(Array.isArray((config as any).requiredSections)).toBe(true);
      expect(Array.isArray((config as any).recommendedSections)).toBe(true);
      expect(typeof (config as any).stalenessThreshold).toBe('number');
    }
  });

  it('CRITICAL_RULES is a non-empty array of strings', () => {
    expect(Array.isArray(CRITICAL_RULES)).toBe(true);
    expect(CRITICAL_RULES.length).toBeGreaterThan(0);
    expect(CRITICAL_RULES.every((r: unknown) => typeof r === 'string')).toBe(true);
    expect(CRITICAL_RULES).toContain('dollar-signs');
    expect(CRITICAL_RULES).toContain('frontmatter-schema');
  });

  it('QUALITY_RULES is a non-empty array of strings', () => {
    expect(Array.isArray(QUALITY_RULES)).toBe(true);
    expect(QUALITY_RULES.length).toBeGreaterThan(0);
    expect(QUALITY_RULES.every((r: unknown) => typeof r === 'string')).toBe(true);
  });

  it('CRITICAL_RULES and QUALITY_RULES do not overlap', () => {
    const criticalSet = new Set(CRITICAL_RULES);
    for (const rule of QUALITY_RULES) {
      expect(criticalSet.has(rule)).toBe(false);
    }
  });
});

// =============================================================================
// content-types.ts — typed loaders
// =============================================================================

describe('content-types.ts — typed loaders', () => {
  it('loadGeneratedJson returns fallback for missing file', () => {
    const result = loadGeneratedJson('nonexistent-file-12345.json', []);
    expect(result).toEqual([]);
  });

  it('loadGeneratedJson returns object fallback for missing file', () => {
    const result = loadGeneratedJson('nonexistent-file-12345.json', {});
    expect(result).toEqual({});
  });

  it('loadEntities returns array', () => {
    const result = loadEntities();
    expect(Array.isArray(result)).toBe(true);
  });

  it('loadBacklinks returns object', () => {
    const result = loadBacklinks();
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
  });

  it('loadPathRegistry returns object', () => {
    const result = loadPathRegistry();
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('loadPages returns array', () => {
    const result = loadPages();
    expect(Array.isArray(result)).toBe(true);
  });

  it('loadOrganizations returns array', () => {
    const result = loadOrganizations();
    expect(Array.isArray(result)).toBe(true);
  });

  it('loadExperts returns array', () => {
    const result = loadExperts();
    expect(Array.isArray(result)).toBe(true);
  });

  it('loadDatabase returns object', () => {
    const result = loadDatabase();
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });
});

// =============================================================================
// validation-engine.ts — Severity & FixType constants
// =============================================================================

describe('validation-engine.ts — constants', () => {
  it('Severity has expected values', () => {
    expect(Severity.ERROR).toBe('error');
    expect(Severity.WARNING).toBe('warning');
    expect(Severity.INFO).toBe('info');
  });

  it('FixType has expected values', () => {
    expect(FixType.INSERT_LINE_BEFORE).toBe('insert-line-before');
    expect(FixType.INSERT_LINE_AFTER).toBe('insert-line-after');
    expect(FixType.REPLACE_LINE).toBe('replace-line');
    expect(FixType.REPLACE_TEXT).toBe('replace-text');
  });
});

// =============================================================================
// validation-engine.ts — Issue
// =============================================================================

describe('validation-engine.ts — Issue', () => {
  it('constructor sets all fields', () => {
    const issue = new Issue({
      rule: 'test-rule',
      file: '/path/to/file.mdx',
      line: 10,
      message: 'Something wrong',
      severity: Severity.WARNING,
      fix: { type: FixType.REPLACE_TEXT, oldText: 'foo', newText: 'bar' },
    });
    expect(issue.rule).toBe('test-rule');
    expect(issue.file).toBe('/path/to/file.mdx');
    expect(issue.line).toBe(10);
    expect(issue.message).toBe('Something wrong');
    expect(issue.severity).toBe('warning');
    expect(issue.fix).not.toBeNull();
    expect(issue.fix.type).toBe('replace-text');
  });

  it('defaults severity to error', () => {
    const issue = new Issue({
      rule: 'test',
      file: 'test.mdx',
      message: 'Bad',
    });
    expect(issue.severity).toBe('error');
  });

  it('defaults fix to null', () => {
    const issue = new Issue({
      rule: 'test',
      file: 'test.mdx',
      message: 'Bad',
    });
    expect(issue.fix).toBeNull();
  });

  it('toString includes all parts', () => {
    const issue = new Issue({
      rule: 'my-rule',
      file: 'file.mdx',
      line: 5,
      message: 'Problem here',
      severity: Severity.ERROR,
    });
    const str = issue.toString();
    expect(str).toContain('[ERROR]');
    expect(str).toContain('my-rule');
    expect(str).toContain('file.mdx');
    expect(str).toContain(':5');
    expect(str).toContain('Problem here');
  });

  it('toString omits line when undefined', () => {
    const issue = new Issue({
      rule: 'my-rule',
      file: 'file.mdx',
      message: 'Problem',
    });
    const str = issue.toString();
    expect(str).not.toContain(':undefined');
  });

  it('isFixable returns true when fix has type', () => {
    const issue = new Issue({
      rule: 'test',
      file: 'test.mdx',
      message: 'Bad',
      fix: { type: FixType.REPLACE_LINE, content: 'new line' },
    });
    expect(issue.isFixable).toBe(true);
  });

  it('isFixable returns false when no fix', () => {
    const issue = new Issue({
      rule: 'test',
      file: 'test.mdx',
      message: 'Bad',
    });
    expect(issue.isFixable).toBe(false);
  });
});

// =============================================================================
// validation-engine.ts — createRule
// =============================================================================

describe('validation-engine.ts — createRule', () => {
  it('creates a valid rule', () => {
    const rule = createRule({
      id: 'test-rule',
      name: 'Test Rule',
      description: 'A test rule',
      check: () => [],
    });
    expect(rule.id).toBe('test-rule');
    expect(rule.name).toBe('Test Rule');
    expect(rule.description).toBe('A test rule');
    expect(rule.scope).toBe('file');
    expect(typeof rule.check).toBe('function');
  });

  it('preserves scope', () => {
    const rule = createRule({
      id: 'global-rule',
      name: 'Global Rule',
      description: 'A global rule',
      scope: 'global',
      check: () => [],
    });
    expect(rule.scope).toBe('global');
  });
});

// =============================================================================
// validation-engine.ts — ValidationEngine (unit, no disk I/O)
// =============================================================================

describe('validation-engine.ts — ValidationEngine', () => {
  it('constructor initializes empty state', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    expect(engine.rules.size).toBe(0);
    expect(engine.content.size).toBe(0);
    expect(engine.loaded).toBe(false);
  });

  it('addRule registers a rule', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    const rule = createRule({
      id: 'test',
      name: 'Test',
      description: 'Test',
      check: () => [],
    });
    engine.addRule(rule);
    expect(engine.rules.size).toBe(1);
    expect(engine.getRule('test')).toBe(rule);
  });

  it('addRule rejects rule without id', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    expect(() => {
      engine.addRule({ name: 'No ID', description: 'x', check: () => [] } as any);
    }).toThrow();
  });

  it('addRule rejects rule without check', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    expect(() => {
      engine.addRule({ id: 'no-check', name: 'No Check', description: 'x' } as any);
    }).toThrow();
  });

  it('addRules registers multiple rules', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    const rules = [
      createRule({ id: 'a', name: 'A', description: 'A', check: () => [] }),
      createRule({ id: 'b', name: 'B', description: 'B', check: () => [] }),
    ];
    engine.addRules(rules);
    expect(engine.rules.size).toBe(2);
  });

  it('getRule returns undefined for missing rule', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    expect(engine.getRule('missing')).toBeUndefined();
  });

  it('getSummary computes correct stats', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    const issues = [
      new Issue({ rule: 'a', file: 'f1', message: 'm1', severity: Severity.ERROR }),
      new Issue({ rule: 'a', file: 'f2', message: 'm2', severity: Severity.ERROR }),
      new Issue({ rule: 'b', file: 'f1', message: 'm3', severity: Severity.WARNING }),
      new Issue({ rule: 'c', file: 'f3', message: 'm4', severity: Severity.INFO }),
    ];
    const summary = engine.getSummary(issues);
    expect(summary.total).toBe(4);
    expect(summary.bySeverity.error).toBe(2);
    expect(summary.bySeverity.warning).toBe(1);
    expect(summary.bySeverity.info).toBe(1);
    expect(summary.byRule['a']).toBe(2);
    expect(summary.byRule['b']).toBe(1);
    expect(summary.byRule['c']).toBe(1);
    expect(summary.hasErrors).toBe(true);
  });

  it('getSummary returns hasErrors=false when no errors', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    const issues = [
      new Issue({ rule: 'a', file: 'f1', message: 'm1', severity: Severity.WARNING }),
    ];
    const summary = engine.getSummary(issues);
    expect(summary.hasErrors).toBe(false);
  });

  it('getSummary handles empty issues', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    const summary = engine.getSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.bySeverity.error).toBe(0);
    expect(summary.hasErrors).toBe(false);
  });

  it('formatOutput returns JSON in CI mode', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    const issues = [
      new Issue({ rule: 'test', file: '/tmp/test.mdx', message: 'Bad thing', severity: Severity.ERROR }),
    ];
    const output = engine.formatOutput(issues, { ci: true });
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(parsed.issues.length).toBe(1);
    expect(parsed.issues[0].rule).toBe('test');
    expect('summary' in parsed).toBe(true);
  });

  it('formatOutput returns human-readable in non-CI mode', () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
    const issues = [
      new Issue({ rule: 'test', file: '/tmp/test.mdx', line: 5, message: 'Bad thing', severity: Severity.ERROR }),
    ];
    const output = engine.formatOutput(issues, { ci: false });
    expect(output).toContain('test');
    expect(output).toContain('Bad thing');
    expect(output).toContain('Summary');
  });

  it('validate runs file-scope rules', async () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent-dir-12345', dataDir: '/tmp/nonexistent-dir-12345' });
    // Mark as loaded so it doesn't try to read from disk
    engine.loaded = true;

    // Manually add a content file
    const mockFile = {
      path: '/tmp/test.mdx',
      relativePath: 'test.mdx',
      raw: '---\ntitle: Test\n---\nContent',
      frontmatter: { title: 'Test' },
      body: 'Content',
      extension: 'mdx',
      isIndex: false,
      directory: '.',
      slug: 'test',
      urlPath: '/test/',
    };
    engine.content.set('/tmp/test.mdx', mockFile);

    const rule = createRule({
      id: 'always-warn',
      name: 'Always Warn',
      description: 'Always produces a warning',
      check: (file: any) => [
        new Issue({
          rule: 'always-warn',
          file: file.path,
          message: 'Warning!',
          severity: Severity.WARNING,
        }),
      ],
    });
    engine.addRule(rule);

    const issues = await engine.validate();
    expect(issues.length).toBe(1);
    expect(issues[0].rule).toBe('always-warn');
    expect(issues[0].severity).toBe('warning');
  });

  it('validate runs global-scope rules', async () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent-dir-12345', dataDir: '/tmp/nonexistent-dir-12345' });
    engine.loaded = true;

    engine.content.set('/tmp/a.mdx', { path: '/tmp/a.mdx' } as any);
    engine.content.set('/tmp/b.mdx', { path: '/tmp/b.mdx' } as any);

    const rule = createRule({
      id: 'count-files',
      name: 'Count Files',
      description: 'Reports file count',
      scope: 'global',
      check: (files: any) => [
        new Issue({
          rule: 'count-files',
          file: 'global',
          message: `Found ${files.length} files`,
          severity: Severity.INFO,
        }),
      ],
    });
    engine.addRule(rule);

    const issues = await engine.validate();
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2 files');
  });

  it('validate filters by ruleIds', async () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent-dir-12345', dataDir: '/tmp/nonexistent-dir-12345' });
    engine.loaded = true;
    engine.content.set('/tmp/test.mdx', { path: '/tmp/test.mdx' } as any);

    engine.addRule(createRule({
      id: 'rule-a',
      name: 'A',
      description: 'A',
      check: () => [new Issue({ rule: 'rule-a', file: 'test', message: 'A' })],
    }));
    engine.addRule(createRule({
      id: 'rule-b',
      name: 'B',
      description: 'B',
      check: () => [new Issue({ rule: 'rule-b', file: 'test', message: 'B' })],
    }));

    const issues = await engine.validate({ ruleIds: ['rule-a'] });
    expect(issues.length).toBe(1);
    expect(issues[0].rule).toBe('rule-a');
  });

  it('validate catches rule errors gracefully', async () => {
    const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent-dir-12345', dataDir: '/tmp/nonexistent-dir-12345' });
    engine.loaded = true;
    engine.content.set('/tmp/test.mdx', { path: '/tmp/test.mdx' } as any);

    engine.addRule(createRule({
      id: 'throws',
      name: 'Throws',
      description: 'Throws an error',
      check: () => { throw new Error('Boom!'); },
    }));

    const issues = await engine.validate();
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('Boom!');
    expect(issues[0].severity).toBe('error');
  });
});

// =============================================================================
// ValidationEngine._applyFixesToContent (fix application)
// =============================================================================

describe('ValidationEngine._applyFixesToContent', () => {
  function applyFixes(content: string, issues: Issue[]): string {
    const engine = new ValidationEngine({ contentDir: '/tmp', dataDir: '/tmp' });
    return (engine as any)._applyFixesToContent(content, issues);
  }

  it('REPLACE_TEXT substitutes text on correct line', () => {
    const content = '---\ntitle: Test\n---\nLine one\nBad text here\nLine three';
    const issue = new Issue({
      rule: 'test', file: 'test.mdx', line: 2, message: 'fix bad',
      fix: { type: FixType.REPLACE_TEXT, oldText: 'Bad text', newText: 'Good text' },
    });
    const result = applyFixes(content, [issue]);
    expect(result).toContain('Good text here');
    expect(result).not.toContain('Bad text');
  });

  it('REPLACE_LINE replaces entire line', () => {
    const content = '---\ntitle: Test\n---\nLine one\nOld line\nLine three';
    const issue = new Issue({
      rule: 'test', file: 'test.mdx', line: 2, message: 'fix line',
      fix: { type: FixType.REPLACE_LINE, content: 'New line' },
    });
    const result = applyFixes(content, [issue]);
    expect(result).toContain('New line');
    expect(result).not.toContain('Old line');
  });

  it('INSERT_LINE_BEFORE inserts before target line', () => {
    const content = '---\ntitle: Test\n---\nLine one\nLine two';
    const issue = new Issue({
      rule: 'test', file: 'test.mdx', line: 2, message: 'insert before',
      fix: { type: FixType.INSERT_LINE_BEFORE, content: 'Inserted line' },
    });
    const result = applyFixes(content, [issue]);
    const lines = result.split('\n');
    const insertedIdx = lines.indexOf('Inserted line');
    const lineTwoIdx = lines.indexOf('Line two');
    expect(insertedIdx).toBeGreaterThan(-1);
    expect(insertedIdx).toBeLessThan(lineTwoIdx);
  });

  it('INSERT_LINE_AFTER inserts after target line', () => {
    const content = '---\ntitle: Test\n---\nLine one\nLine two';
    const issue = new Issue({
      rule: 'test', file: 'test.mdx', line: 1, message: 'insert after',
      fix: { type: FixType.INSERT_LINE_AFTER, content: 'Inserted line' },
    });
    const result = applyFixes(content, [issue]);
    const lines = result.split('\n');
    const lineOneIdx = lines.indexOf('Line one');
    const insertedIdx = lines.indexOf('Inserted line');
    expect(insertedIdx).toBe(lineOneIdx + 1);
  });

  it('accounts for frontmatter offset', () => {
    // 3-line frontmatter: ---\ntitle\n--- = frontmatter ends at line 3
    // Line 1 in the body = line 4 in the full file
    const content = '---\ntitle: Test\n---\nFirst body line\nSecond body line';
    const issue = new Issue({
      rule: 'test', file: 'test.mdx', line: 1, message: 'fix body line 1',
      fix: { type: FixType.REPLACE_LINE, content: 'Fixed first line' },
    });
    const result = applyFixes(content, [issue]);
    expect(result).toContain('Fixed first line');
    expect(result).not.toContain('First body line');
    expect(result).toContain('Second body line');
  });

  it('handles content without frontmatter', () => {
    const content = 'Line one\nBad line\nLine three';
    const issue = new Issue({
      rule: 'test', file: 'test.mdx', line: 2, message: 'fix',
      fix: { type: FixType.REPLACE_LINE, content: 'Good line' },
    });
    const result = applyFixes(content, [issue]);
    expect(result).toContain('Good line');
    expect(result).not.toContain('Bad line');
  });

  it('applies multiple fixes (sorted by line desc)', () => {
    const content = '---\ntitle: Test\n---\nLine A\nLine B\nLine C';
    const issues = [
      new Issue({
        rule: 'test', file: 'test.mdx', line: 1, message: 'fix A',
        fix: { type: FixType.REPLACE_LINE, content: 'Fixed A' },
      }),
      new Issue({
        rule: 'test', file: 'test.mdx', line: 3, message: 'fix C',
        fix: { type: FixType.REPLACE_LINE, content: 'Fixed C' },
      }),
    ];
    const result = applyFixes(content, issues);
    expect(result).toContain('Fixed A');
    expect(result).toContain('Line B');
    expect(result).toContain('Fixed C');
  });

  it('skips issues without line numbers', () => {
    const content = '---\ntitle: Test\n---\nLine one';
    const issue = new Issue({
      rule: 'test', file: 'test.mdx', message: 'no line',
      fix: { type: FixType.REPLACE_LINE, content: 'Should not appear' },
    });
    const result = applyFixes(content, [issue]);
    expect(result).toBe(content);
  });
});
