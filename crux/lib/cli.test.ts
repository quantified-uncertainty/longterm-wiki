#!/usr/bin/env node
/**
 * Unit Tests for CLI Utilities and TypeScript Migration Infrastructure
 *
 * Tests:
 *   - cli.mjs: camelToKebab, kebabToCamel, formatDuration, optionsToArgs,
 *              createScriptHandler, buildCommands
 *   - content-types.ts: loadGeneratedJson, typed loaders, constants
 *   - validation-engine.ts: Issue, ContentFile, ValidationEngine, createRule,
 *                           Severity, FixType
 *
 * Run: node --import tsx/esm crux/lib/cli.test.ts
 */

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
} from './validation-engine.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  try {
    const result = fn();
    // Support async tests
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).then(
        () => { console.log(`✓ ${name}`); passed++; },
        (e: unknown) => { const error = e instanceof Error ? e : new Error(String(e)); console.log(`✗ ${name}`); console.log(`  ${error.message}`); failed++; }
      );
    }
    console.log(`✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.log(`✗ ${name}`);
    console.log(`  ${error.message}`);
    failed++;
  }
}

function assert(condition: boolean, message?: string): void {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(message || `Expected ${e}, got ${a}`);
  }
}

// =============================================================================
// cli.mjs — camelToKebab
// =============================================================================

console.log('\n🔧 cli.mjs — camelToKebab');

test('camelToKebab converts simple camelCase', () => {
  assertEqual(camelToKebab('dryRun'), 'dry-run');
});

test('camelToKebab converts multi-word camelCase', () => {
  assertEqual(camelToKebab('myLongVariableName'), 'my-long-variable-name');
});

test('camelToKebab handles already lowercase', () => {
  assertEqual(camelToKebab('simple'), 'simple');
});

test('camelToKebab handles single char segments', () => {
  assertEqual(camelToKebab('aB'), 'a-b');
});

// =============================================================================
// cli.mjs — kebabToCamel
// =============================================================================

console.log('\n🔧 cli.mjs — kebabToCamel');

test('kebabToCamel converts simple kebab-case', () => {
  assertEqual(kebabToCamel('dry-run'), 'dryRun');
});

test('kebabToCamel converts multi-word kebab-case', () => {
  assertEqual(kebabToCamel('my-long-variable-name'), 'myLongVariableName');
});

test('kebabToCamel handles no hyphens', () => {
  assertEqual(kebabToCamel('simple'), 'simple');
});

test('camelToKebab and kebabToCamel are inverses', () => {
  const original = 'dryRun';
  assertEqual(kebabToCamel(camelToKebab(original)), original);
});

// =============================================================================
// cli.mjs — formatDuration
// =============================================================================

console.log('\n🔧 cli.mjs — formatDuration');

test('formatDuration formats milliseconds', () => {
  assertEqual(formatDuration(500), '500ms');
});

test('formatDuration formats seconds', () => {
  assertEqual(formatDuration(1500), '1.50s');
});

test('formatDuration boundary at 1000ms', () => {
  assertEqual(formatDuration(999), '999ms');
  assertEqual(formatDuration(1000), '1.00s');
});

test('formatDuration formats zero', () => {
  assertEqual(formatDuration(0), '0ms');
});

// =============================================================================
// cli.mjs — optionsToArgs
// =============================================================================

console.log('\n🔧 cli.mjs — optionsToArgs');

test('optionsToArgs converts boolean true to flag', () => {
  const result = optionsToArgs({ verbose: true });
  assertDeepEqual(result, ['--verbose']);
});

test('optionsToArgs converts string value to key=value', () => {
  const result = optionsToArgs({ model: 'haiku' });
  assertDeepEqual(result, ['--model=haiku']);
});

test('optionsToArgs converts number value to key=value', () => {
  const result = optionsToArgs({ batch: 50 });
  assertDeepEqual(result, ['--batch=50']);
});

test('optionsToArgs skips false values', () => {
  const result = optionsToArgs({ verbose: false });
  assertDeepEqual(result, []);
});

test('optionsToArgs skips null and undefined', () => {
  const result = optionsToArgs({ a: null, b: undefined });
  assertDeepEqual(result, []);
});

test('optionsToArgs excludes specified keys', () => {
  const result = optionsToArgs({ verbose: true, help: true }, ['help']);
  assertDeepEqual(result, ['--verbose']);
});

test('optionsToArgs converts camelCase to kebab-case', () => {
  const result = optionsToArgs({ dryRun: true });
  assertDeepEqual(result, ['--dry-run']);
});

test('optionsToArgs handles multiple options', () => {
  const result = optionsToArgs({ verbose: true, model: 'haiku', batch: 10 });
  assert(result.includes('--verbose'));
  assert(result.includes('--model=haiku'));
  assert(result.includes('--batch=10'));
  assertEqual(result.length, 3);
});

// =============================================================================
// cli.mjs — createScriptHandler
// =============================================================================

console.log('\n🔧 cli.mjs — createScriptHandler');

test('createScriptHandler returns a function', () => {
  const handler = createScriptHandler('test', {
    script: 'nonexistent.mjs',
    passthrough: ['verbose'],
  });
  assert(typeof handler === 'function', 'Should return a function');
});

test('createScriptHandler filters to passthrough options only', async () => {
  // We can't easily test subprocess execution, but we can verify the handler
  // is created properly and returns the expected structure
  const handler = createScriptHandler('test', {
    script: 'nonexistent.mjs',
    passthrough: ['verbose'],
  });
  // The handler should be an async function
  assert(handler.constructor.name === 'AsyncFunction', 'Should be async');
});

// =============================================================================
// cli.mjs — buildCommands
// =============================================================================

console.log('\n🔧 cli.mjs — buildCommands');

test('buildCommands creates handler for each script', () => {
  const scripts = {
    foo: { script: 'foo.mjs', passthrough: [] },
    bar: { script: 'bar.mjs', passthrough: ['verbose'] },
  };
  const commands = buildCommands(scripts);
  assert(typeof commands.foo === 'function', 'Should have foo command');
  assert(typeof commands.bar === 'function', 'Should have bar command');
  assert(!('default' in commands), 'Should not have default without specifying');
});

test('buildCommands sets default command', () => {
  const scripts = {
    foo: { script: 'foo.mjs', passthrough: [] },
    bar: { script: 'bar.mjs', passthrough: [] },
  };
  const commands = buildCommands(scripts, 'foo');
  assert(typeof commands.default === 'function', 'Should have default command');
  assert(commands.default === commands.foo, 'Default should reference foo');
});

test('buildCommands ignores invalid default', () => {
  const scripts = {
    foo: { script: 'foo.mjs', passthrough: [] },
  };
  const commands = buildCommands(scripts, 'nonexistent');
  assert(!('default' in commands), 'Should not set default for nonexistent command');
});

test('buildCommands handles empty scripts', () => {
  const commands = buildCommands({});
  assertDeepEqual(Object.keys(commands), []);
});

// =============================================================================
// content-types.ts — constants
// =============================================================================

console.log('\n📋 content-types.ts — constants');

test('CONTENT_DIR is content/docs', () => {
  assertEqual(CONTENT_DIR, 'content/docs');
});

test('DATA_DIR is data', () => {
  assertEqual(DATA_DIR, 'data');
});

test('GENERATED_DATA_DIR is app/src/data', () => {
  assertEqual(GENERATED_DATA_DIR, 'app/src/data');
});

test('DEFAULT_STALENESS_THRESHOLD is 180', () => {
  assertEqual(DEFAULT_STALENESS_THRESHOLD, 180);
});

test('CONTENT_TYPES has model, risk, response', () => {
  assert('model' in CONTENT_TYPES, 'Should have model');
  assert('risk' in CONTENT_TYPES, 'Should have risk');
  assert('response' in CONTENT_TYPES, 'Should have response');
});

test('each CONTENT_TYPE has required fields', () => {
  for (const [name, config] of Object.entries(CONTENT_TYPES)) {
    assert((config as any).pathPattern instanceof RegExp, `${name} should have pathPattern RegExp`);
    assert(typeof (config as any).directory === 'string', `${name} should have directory string`);
    assert(Array.isArray((config as any).requiredSections), `${name} should have requiredSections array`);
    assert(Array.isArray((config as any).recommendedSections), `${name} should have recommendedSections array`);
    assert(typeof (config as any).stalenessThreshold === 'number', `${name} should have stalenessThreshold number`);
  }
});

test('CRITICAL_RULES is a non-empty array of strings', () => {
  assert(Array.isArray(CRITICAL_RULES), 'Should be array');
  assert(CRITICAL_RULES.length > 0, 'Should not be empty');
  assert(CRITICAL_RULES.every((r: unknown) => typeof r === 'string'), 'All entries should be strings');
  assert(CRITICAL_RULES.includes('dollar-signs'), 'Should include dollar-signs');
  assert(CRITICAL_RULES.includes('frontmatter-schema'), 'Should include frontmatter-schema');
});

test('QUALITY_RULES is a non-empty array of strings', () => {
  assert(Array.isArray(QUALITY_RULES), 'Should be array');
  assert(QUALITY_RULES.length > 0, 'Should not be empty');
  assert(QUALITY_RULES.every((r: unknown) => typeof r === 'string'), 'All entries should be strings');
});

test('CRITICAL_RULES and QUALITY_RULES do not overlap', () => {
  const criticalSet = new Set(CRITICAL_RULES);
  for (const rule of QUALITY_RULES) {
    assert(!criticalSet.has(rule), `Rule ${rule} should not be in both CRITICAL and QUALITY`);
  }
});

// =============================================================================
// content-types.ts — typed loaders
// =============================================================================

console.log('\n📋 content-types.ts — typed loaders');

test('loadGeneratedJson returns fallback for missing file', () => {
  const result = loadGeneratedJson('nonexistent-file-12345.json', []);
  assertDeepEqual(result, []);
});

test('loadGeneratedJson returns object fallback for missing file', () => {
  const result = loadGeneratedJson('nonexistent-file-12345.json', {});
  assertDeepEqual(result, {});
});

test('loadEntities returns array', () => {
  const result = loadEntities();
  assert(Array.isArray(result), 'Should return array');
  // entities.json may or may not exist; either way, should be an array
});

test('loadBacklinks returns object', () => {
  const result = loadBacklinks();
  assert(typeof result === 'object' && result !== null, 'Should return object');
  assert(!Array.isArray(result), 'Should not be an array');
});

test('loadPathRegistry returns object', () => {
  const result = loadPathRegistry();
  assert(typeof result === 'object' && result !== null, 'Should return object');
});

test('loadPages returns array', () => {
  const result = loadPages();
  assert(Array.isArray(result), 'Should return array');
});

test('loadOrganizations returns array', () => {
  const result = loadOrganizations();
  assert(Array.isArray(result), 'Should return array');
});

test('loadExperts returns array', () => {
  const result = loadExperts();
  assert(Array.isArray(result), 'Should return array');
});

test('loadDatabase returns object', () => {
  const result = loadDatabase();
  assert(typeof result === 'object' && result !== null, 'Should return object');
});

// =============================================================================
// validation-engine.ts — Severity & FixType constants
// =============================================================================

console.log('\n⚙️  validation-engine.ts — constants');

test('Severity has expected values', () => {
  assertEqual(Severity.ERROR, 'error');
  assertEqual(Severity.WARNING, 'warning');
  assertEqual(Severity.INFO, 'info');
});

test('FixType has expected values', () => {
  assertEqual(FixType.INSERT_LINE_BEFORE, 'insert-line-before');
  assertEqual(FixType.INSERT_LINE_AFTER, 'insert-line-after');
  assertEqual(FixType.REPLACE_LINE, 'replace-line');
  assertEqual(FixType.REPLACE_TEXT, 'replace-text');
});

// =============================================================================
// validation-engine.ts — Issue
// =============================================================================

console.log('\n⚙️  validation-engine.ts — Issue');

test('Issue constructor sets all fields', () => {
  const issue = new Issue({
    rule: 'test-rule',
    file: '/path/to/file.mdx',
    line: 10,
    message: 'Something wrong',
    severity: Severity.WARNING,
    fix: { type: FixType.REPLACE_TEXT, oldText: 'foo', newText: 'bar' },
  });
  assertEqual(issue.rule, 'test-rule');
  assertEqual(issue.file, '/path/to/file.mdx');
  assertEqual(issue.line, 10);
  assertEqual(issue.message, 'Something wrong');
  assertEqual(issue.severity, 'warning');
  assert(issue.fix !== null, 'Should have fix');
  assertEqual(issue.fix.type, 'replace-text');
});

test('Issue defaults severity to error', () => {
  const issue = new Issue({
    rule: 'test',
    file: 'test.mdx',
    message: 'Bad',
  });
  assertEqual(issue.severity, 'error');
});

test('Issue defaults fix to null', () => {
  const issue = new Issue({
    rule: 'test',
    file: 'test.mdx',
    message: 'Bad',
  });
  assertEqual(issue.fix, null);
});

test('Issue toString includes all parts', () => {
  const issue = new Issue({
    rule: 'my-rule',
    file: 'file.mdx',
    line: 5,
    message: 'Problem here',
    severity: Severity.ERROR,
  });
  const str = issue.toString();
  assert(str.includes('[ERROR]'), 'Should include severity');
  assert(str.includes('my-rule'), 'Should include rule');
  assert(str.includes('file.mdx'), 'Should include file');
  assert(str.includes(':5'), 'Should include line');
  assert(str.includes('Problem here'), 'Should include message');
});

test('Issue toString omits line when undefined', () => {
  const issue = new Issue({
    rule: 'my-rule',
    file: 'file.mdx',
    message: 'Problem',
  });
  const str = issue.toString();
  assert(!str.includes(':undefined'), 'Should not include :undefined');
});

test('Issue isFixable returns true when fix has type', () => {
  const issue = new Issue({
    rule: 'test',
    file: 'test.mdx',
    message: 'Bad',
    fix: { type: FixType.REPLACE_LINE, content: 'new line' },
  });
  assert(issue.isFixable === true, 'Should be fixable');
});

test('Issue isFixable returns false when no fix', () => {
  const issue = new Issue({
    rule: 'test',
    file: 'test.mdx',
    message: 'Bad',
  });
  assert(issue.isFixable === false, 'Should not be fixable');
});

// =============================================================================
// validation-engine.ts — createRule
// =============================================================================

console.log('\n⚙️  validation-engine.ts — createRule');

test('createRule creates a valid rule', () => {
  const rule = createRule({
    id: 'test-rule',
    name: 'Test Rule',
    description: 'A test rule',
    check: () => [],
  });
  assertEqual(rule.id, 'test-rule');
  assertEqual(rule.name, 'Test Rule');
  assertEqual(rule.description, 'A test rule');
  assertEqual(rule.scope, 'file');
  assert(typeof rule.check === 'function');
});

test('createRule preserves scope', () => {
  const rule = createRule({
    id: 'global-rule',
    name: 'Global Rule',
    description: 'A global rule',
    scope: 'global',
    check: () => [],
  });
  assertEqual(rule.scope, 'global');
});

// =============================================================================
// validation-engine.ts — ValidationEngine (unit, no disk I/O)
// =============================================================================

console.log('\n⚙️  validation-engine.ts — ValidationEngine');

test('ValidationEngine constructor initializes empty state', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  assertEqual(engine.rules.size, 0);
  assertEqual(engine.content.size, 0);
  assertEqual(engine.loaded, false);
});

test('ValidationEngine.addRule registers a rule', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  const rule = createRule({
    id: 'test',
    name: 'Test',
    description: 'Test',
    check: () => [],
  });
  engine.addRule(rule);
  assertEqual(engine.rules.size, 1);
  assertEqual(engine.getRule('test'), rule);
});

test('ValidationEngine.addRule rejects rule without id', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  let threw = false;
  try {
    engine.addRule({ name: 'No ID', description: 'x', check: () => [] } as any);
  } catch {
    threw = true;
  }
  assert(threw, 'Should throw for rule without id');
});

test('ValidationEngine.addRule rejects rule without check', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  let threw = false;
  try {
    engine.addRule({ id: 'no-check', name: 'No Check', description: 'x' } as any);
  } catch {
    threw = true;
  }
  assert(threw, 'Should throw for rule without check');
});

test('ValidationEngine.addRules registers multiple rules', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  const rules = [
    createRule({ id: 'a', name: 'A', description: 'A', check: () => [] }),
    createRule({ id: 'b', name: 'B', description: 'B', check: () => [] }),
  ];
  engine.addRules(rules);
  assertEqual(engine.rules.size, 2);
});

test('ValidationEngine.getRule returns undefined for missing rule', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  assertEqual(engine.getRule('missing'), undefined);
});

test('ValidationEngine.getSummary computes correct stats', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  const issues = [
    new Issue({ rule: 'a', file: 'f1', message: 'm1', severity: Severity.ERROR }),
    new Issue({ rule: 'a', file: 'f2', message: 'm2', severity: Severity.ERROR }),
    new Issue({ rule: 'b', file: 'f1', message: 'm3', severity: Severity.WARNING }),
    new Issue({ rule: 'c', file: 'f3', message: 'm4', severity: Severity.INFO }),
  ];
  const summary = engine.getSummary(issues);
  assertEqual(summary.total, 4);
  assertEqual(summary.bySeverity.error, 2);
  assertEqual(summary.bySeverity.warning, 1);
  assertEqual(summary.bySeverity.info, 1);
  assertEqual(summary.byRule['a'], 2);
  assertEqual(summary.byRule['b'], 1);
  assertEqual(summary.byRule['c'], 1);
  assert(summary.hasErrors === true, 'Should have errors');
});

test('ValidationEngine.getSummary returns hasErrors=false when no errors', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  const issues = [
    new Issue({ rule: 'a', file: 'f1', message: 'm1', severity: Severity.WARNING }),
  ];
  const summary = engine.getSummary(issues);
  assert(summary.hasErrors === false, 'Should not have errors');
});

test('ValidationEngine.getSummary handles empty issues', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  const summary = engine.getSummary([]);
  assertEqual(summary.total, 0);
  assertEqual(summary.bySeverity.error, 0);
  assert(summary.hasErrors === false);
});

test('ValidationEngine.formatOutput returns JSON in CI mode', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  const issues = [
    new Issue({ rule: 'test', file: '/tmp/test.mdx', message: 'Bad thing', severity: Severity.ERROR }),
  ];
  const output = engine.formatOutput(issues, { ci: true });
  const parsed = JSON.parse(output);
  assert(Array.isArray(parsed.issues), 'CI output should have issues array');
  assertEqual(parsed.issues.length, 1);
  assertEqual(parsed.issues[0].rule, 'test');
  assert('summary' in parsed, 'CI output should have summary');
});

test('ValidationEngine.formatOutput returns human-readable in non-CI mode', () => {
  const engine = new ValidationEngine({ contentDir: '/tmp/nonexistent', dataDir: '/tmp/nonexistent' });
  const issues = [
    new Issue({ rule: 'test', file: '/tmp/test.mdx', line: 5, message: 'Bad thing', severity: Severity.ERROR }),
  ];
  const output = engine.formatOutput(issues, { ci: false });
  assert(output.includes('test'), 'Should include rule name');
  assert(output.includes('Bad thing'), 'Should include message');
  assert(output.includes('Summary'), 'Should include summary');
});

// Test validate with in-memory content
await test('ValidationEngine.validate runs file-scope rules', async () => {
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
  assertEqual(issues.length, 1);
  assertEqual(issues[0].rule, 'always-warn');
  assertEqual(issues[0].severity, 'warning');
});

await test('ValidationEngine.validate runs global-scope rules', async () => {
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
  assertEqual(issues.length, 1);
  assert(issues[0].message.includes('2 files'), 'Should report 2 files');
});

await test('ValidationEngine.validate filters by ruleIds', async () => {
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
  assertEqual(issues.length, 1);
  assertEqual(issues[0].rule, 'rule-a');
});

await test('ValidationEngine.validate catches rule errors gracefully', async () => {
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
  assertEqual(issues.length, 1);
  assert(issues[0].message.includes('Boom!'), 'Should capture error message');
  assertEqual(issues[0].severity, 'error');
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n' + '─'.repeat(50));
console.log(`\n✅ Passed: ${passed}`);
if (failed > 0) {
  console.log(`❌ Failed: ${failed}`);
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!');
}
