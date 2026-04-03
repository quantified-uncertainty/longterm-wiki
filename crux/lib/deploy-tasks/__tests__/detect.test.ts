import { describe, it, expect } from 'vitest';
import { parseDeployTasksFromBody, formatDeployTasksSection } from '../detect.ts';
import type { DeployTask } from '../types.ts';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<DeployTask> & { id: string }): DeployTask {
  return {
    description: 'Test task',
    category: 'migration',
    phase: 'post-deploy',
    automated: true,
    sourceFiles: [],
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// parseDeployTasksFromBody
// ────────────────────────────────────────────────────────────────────────────

describe('parseDeployTasksFromBody', () => {
  // 1. Standard case with mixed checked/unchecked items
  it('parses mixed checked and unchecked tasks from PR body', () => {
    const body = `## Summary
Some PR description.

## Deploy Checklist
<!-- deploy-tasks:v1 -->
- [ ] \`migration\` Verify migration 0060 applied
- [x] \`env\` Set \`API_KEY\` in production
- [ ] \`ci\` Verify workflow auto-update.yml runs
<!-- /deploy-tasks -->

## Test plan
- [x] Tests pass`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(3);
    expect(result!.checked).toBe(1);
    expect(result!.unchecked).toBe(2);
    expect(result!.items).toHaveLength(3);
    expect(result!.items[0]).toEqual({
      text: '`migration` Verify migration 0060 applied',
      checked: false,
    });
    expect(result!.items[1]).toEqual({
      text: '`env` Set `API_KEY` in production',
      checked: true,
    });
    expect(result!.items[2]).toEqual({
      text: '`ci` Verify workflow auto-update.yml runs',
      checked: false,
    });
  });

  // 2. All items checked
  it('parses body where all items are checked', () => {
    const body = `## Deploy Checklist
<!-- deploy-tasks:v1 -->
- [x] \`migration\` Verify migration 0060 applied
- [x] \`env\` Set API_KEY in production
- [x] \`ci\` Verify workflow runs
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(3);
    expect(result!.checked).toBe(3);
    expect(result!.unchecked).toBe(0);
    expect(result!.items.every((i) => i.checked)).toBe(true);
  });

  // 3. All items unchecked
  it('parses body where all items are unchecked', () => {
    const body = `## Deploy Checklist
<!-- deploy-tasks:v1 -->
- [ ] Task one
- [ ] Task two
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(2);
    expect(result!.checked).toBe(0);
    expect(result!.unchecked).toBe(2);
    expect(result!.items.every((i) => !i.checked)).toBe(true);
  });

  // 4. No deploy tasks section at all
  it('returns null when no deploy tasks section exists', () => {
    const body = '## Summary\nJust a normal PR.\n\n## Test plan\n- [x] done';
    expect(parseDeployTasksFromBody(body)).toBeNull();
  });

  // 5. "No deploy tasks required." section
  it('handles "No deploy tasks required" section', () => {
    const body = `## Deploy Checklist
<!-- deploy-tasks:v1 -->
No deploy tasks required.
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(0);
    expect(result!.checked).toBe(0);
    expect(result!.unchecked).toBe(0);
    expect(result!.items).toHaveLength(0);
  });

  // 6. Malformed delimiters
  describe('malformed delimiters', () => {
    it('returns null when only start marker is present (missing end)', () => {
      const body = `<!-- deploy-tasks:v1 -->
- [ ] Some task`;
      expect(parseDeployTasksFromBody(body)).toBeNull();
    });

    it('returns null when only end marker is present (missing start)', () => {
      const body = `- [ ] Some task
<!-- /deploy-tasks -->`;
      expect(parseDeployTasksFromBody(body)).toBeNull();
    });

    it('returns null when markers are in reversed order', () => {
      const body = `<!-- /deploy-tasks -->
- [ ] Some task
<!-- deploy-tasks:v1 -->`;
      // endIdx (0) <= startIdx (after the end marker) means reversed
      expect(parseDeployTasksFromBody(body)).toBeNull();
    });
  });

  // 7. Empty body string
  it('returns null for empty body', () => {
    expect(parseDeployTasksFromBody('')).toBeNull();
  });

  // 8. Deploy tasks section with no checkbox items (just text)
  it('returns zero items when section has text but no checkboxes', () => {
    const body = `## Deploy Checklist
<!-- deploy-tasks:v1 -->
This is some text without any checkboxes.
Just notes about the deploy.
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(0);
    expect(result!.items).toHaveLength(0);
  });

  // 9. Multiple deploy task sections (should parse only the first)
  it('parses only the first deploy tasks section when multiple exist', () => {
    const body = `## Deploy Checklist
<!-- deploy-tasks:v1 -->
- [ ] First section task A
- [x] First section task B
<!-- /deploy-tasks -->

## Old Deploy Checklist
<!-- deploy-tasks:v1 -->
- [ ] Second section task C
- [ ] Second section task D
- [ ] Second section task E
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    // indexOf finds the FIRST occurrence of start marker and the FIRST occurrence of end marker
    // Since the first end marker comes before the second start marker, it parses the first section
    expect(result!.total).toBe(2);
    expect(result!.items[0].text).toBe('First section task A');
    expect(result!.items[1].text).toBe('First section task B');
  });

  // 10. Checkbox items with special characters (backticks, pipes, parentheses)
  it('handles items with special characters', () => {
    const body = `<!-- deploy-tasks:v1 -->
- [ ] \`migration\` Run \`SELECT * FROM users\` — verify (important!) output | check column
- [x] Set \`FOO_BAR\` env var (see: https://example.com?key=val&other=1)
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(2);
    expect(result!.items[0].text).toContain('SELECT * FROM users');
    expect(result!.items[0].text).toContain('(important!)');
    expect(result!.items[0].text).toContain('| check column');
    expect(result!.items[0].checked).toBe(false);
    expect(result!.items[1].text).toContain('FOO_BAR');
    expect(result!.items[1].text).toContain('https://example.com?key=val&other=1');
    expect(result!.items[1].checked).toBe(true);
  });

  // 11. Case-insensitive [X] vs [x] matching
  it('recognizes uppercase [X] as checked', () => {
    const body = `<!-- deploy-tasks:v1 -->
- [X] Uppercase checked task
- [x] Lowercase checked task
- [ ] Unchecked task
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(3);
    expect(result!.checked).toBe(2);
    expect(result!.unchecked).toBe(1);
    expect(result!.items[0]).toEqual({ text: 'Uppercase checked task', checked: true });
    expect(result!.items[1]).toEqual({ text: 'Lowercase checked task', checked: true });
    expect(result!.items[2]).toEqual({ text: 'Unchecked task', checked: false });
  });

  // 12. Items with extra whitespace/indentation
  it('handles items with leading whitespace and indentation', () => {
    const body = `<!-- deploy-tasks:v1 -->
   - [ ] Indented unchecked task
      - [x] Deeply indented checked task
- [ ] Normal task
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    // The regex uses trimmed lines, so indentation should be stripped
    expect(result!.total).toBe(3);
    expect(result!.items[0]).toEqual({ text: 'Indented unchecked task', checked: false });
    expect(result!.items[1]).toEqual({ text: 'Deeply indented checked task', checked: true });
    expect(result!.items[2]).toEqual({ text: 'Normal task', checked: false });
  });

  // 13. Deploy tasks section embedded in code blocks (should NOT parse... but does?)
  it('parses section markers even inside markdown — no code-block awareness', () => {
    // The current implementation does indexOf on the raw body string,
    // so markers inside code blocks WILL be found. This test documents
    // the actual behavior (not necessarily ideal behavior).
    const body = "```\n<!-- deploy-tasks:v1 -->\n- [ ] Task inside code block\n<!-- /deploy-tasks -->\n```";

    const result = parseDeployTasksFromBody(body);
    // Current behavior: it parses them (no code-block skipping logic)
    expect(result).not.toBeNull();
    expect(result!.total).toBe(1);
    expect(result!.items[0].text).toBe('Task inside code block');
  });

  // Additional edge cases

  it('handles body that is only whitespace', () => {
    expect(parseDeployTasksFromBody('   \n\n  ')).toBeNull();
  });

  it('handles markers with no content between them', () => {
    const body = `<!-- deploy-tasks:v1 --><!-- /deploy-tasks -->`;
    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(0);
    expect(result!.items).toHaveLength(0);
  });

  it('handles markers on the same line with a task between', () => {
    // Unlikely in practice, but tests boundary
    const body = `<!-- deploy-tasks:v1 -->\n- [ ] Inline task\n<!-- /deploy-tasks -->`;
    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(1);
  });

  it('does not match partially checked checkbox like [X ] or [ x]', () => {
    const body = `<!-- deploy-tasks:v1 -->
- [X ] Not a valid checkbox
- [ x] Also not valid
- [xx] Definitely not valid
- [ ] Valid unchecked
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    // Only "- [ ] Valid unchecked" matches the regex patterns
    expect(result!.total).toBe(1);
    expect(result!.items[0].text).toBe('Valid unchecked');
  });

  it('ignores lines that look like checkboxes but have wrong prefix', () => {
    const body = `<!-- deploy-tasks:v1 -->
* [ ] Asterisk bullet (not dash)
+ [ ] Plus bullet (not dash)
[ ] No bullet at all
- [ ] Valid dash bullet
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(1);
    expect(result!.items[0].text).toBe('Valid dash bullet');
  });

  it('handles a single task correctly', () => {
    const body = `<!-- deploy-tasks:v1 -->
- [ ] Only one task
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(1);
    expect(result!.checked).toBe(0);
    expect(result!.unchecked).toBe(1);
  });

  it('preserves the full text content of complex task descriptions', () => {
    const body = `<!-- deploy-tasks:v1 -->
- [ ] \`migration\` Verify migration 0060 applied on server start — \`psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"\`
<!-- /deploy-tasks -->`;

    const result = parseDeployTasksFromBody(body);
    expect(result).not.toBeNull();
    expect(result!.items[0].text).toContain('psql "$DATABASE_URL"');
    expect(result!.items[0].text).toContain('__drizzle_migrations');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatDeployTasksSection
// ────────────────────────────────────────────────────────────────────────────

describe('formatDeployTasksSection', () => {
  // 1. Single task with verify command
  it('formats a single task with verify command', () => {
    const tasks: DeployTask[] = [
      makeTask({
        id: 'migration-0060',
        description: 'Verify migration 0060 applied',
        category: 'migration',
        verifyCommand: 'psql "$DATABASE_URL" -c "SELECT 1"',
        sourceFiles: ['apps/wiki-server/drizzle/0060_foo.sql'],
      }),
    ];

    const section = formatDeployTasksSection(tasks);
    expect(section).toContain('## Deploy Checklist');
    expect(section).toContain('<!-- deploy-tasks:v1 -->');
    expect(section).toContain('<!-- /deploy-tasks -->');
    expect(section).toContain('- [ ] `migration` Verify migration 0060 applied');
    expect(section).toContain('`psql "$DATABASE_URL" -c "SELECT 1"`');
    // Verify the separator between description and verify command
    expect(section).toContain('Verify migration 0060 applied — `psql');
  });

  // 2. Single task without verify command
  it('formats a single task without verify command', () => {
    const tasks: DeployTask[] = [
      makeTask({
        id: 'env-new-key',
        description: 'Set NEW_KEY in production',
        category: 'env',
        phase: 'pre-merge',
        automated: false,
      }),
    ];

    const section = formatDeployTasksSection(tasks);
    expect(section).toContain('- [ ] `env` Set NEW_KEY in production');
    // No verify command means no dash separator
    expect(section).not.toContain(' — `');
  });

  // 3. Multiple tasks across categories
  it('formats multiple tasks across different categories', () => {
    const tasks: DeployTask[] = [
      makeTask({
        id: 'env-api-key',
        description: 'Set API_KEY in production',
        category: 'env',
        phase: 'pre-merge',
        automated: false,
      }),
      makeTask({
        id: 'migration-0060',
        description: 'Verify migration 0060',
        category: 'migration',
        verifyCommand: 'SELECT 1',
      }),
      makeTask({
        id: 'ci-deploy',
        description: 'Verify deploy workflow',
        category: 'ci',
        verifyCommand: 'gh run list --workflow=deploy.yml',
      }),
      makeTask({
        id: 'manual-migration-backfill',
        description: 'Run manual backfill script',
        category: 'manual-migration',
        phase: 'manual',
        automated: false,
      }),
    ];

    const section = formatDeployTasksSection(tasks);
    expect(section).toContain('`env`');
    expect(section).toContain('`migration`');
    expect(section).toContain('`ci`');
    expect(section).toContain('`manual-migration`');
    // Should have 4 checkbox lines
    const checkboxLines = section.split('\n').filter((l) => l.startsWith('- [ ]'));
    expect(checkboxLines).toHaveLength(4);
  });

  // 4. Empty task list
  it('formats empty task list with "No deploy tasks required" message', () => {
    const section = formatDeployTasksSection([]);
    expect(section).toContain('## Deploy Checklist');
    expect(section).toContain('<!-- deploy-tasks:v1 -->');
    expect(section).toContain('No deploy tasks required.');
    expect(section).toContain('<!-- /deploy-tasks -->');
    // Should NOT contain any checkboxes
    expect(section).not.toContain('- [ ]');
    expect(section).not.toContain('- [x]');
  });

  // 4b. Sub-PR tasks are included in output
  it('includes sub-PR tasks alongside diff-detected tasks', () => {
    const tasks: DeployTask[] = [
      makeTask({ id: 'env-FOO', description: 'Set FOO in production', category: 'env' }),
    ];
    const subPrTasks = [
      '`env` Set BAR in production _(from PR #100)_',
      '`migration` Run fix-data.sql _(from PR #200)_',
    ];

    const section = formatDeployTasksSection(tasks, subPrTasks);
    expect(section).toContain('- [ ] `env` Set FOO in production');
    expect(section).toContain('- [ ] `env` Set BAR in production _(from PR #100)_');
    expect(section).toContain('- [ ] `migration` Run fix-data.sql _(from PR #200)_');
    expect(section).not.toContain('No deploy tasks required.');

    const checkboxLines = section.split('\n').filter((l) => l.startsWith('- [ ]'));
    expect(checkboxLines).toHaveLength(3);
  });

  // 4c. Sub-PR tasks alone (no diff-detected tasks)
  it('shows sub-PR tasks even when no diff-detected tasks exist', () => {
    const subPrTasks = ['`env` Set BAZ in production _(from PR #300)_'];

    const section = formatDeployTasksSection([], subPrTasks);
    expect(section).toContain('- [ ] `env` Set BAZ in production _(from PR #300)_');
    expect(section).not.toContain('No deploy tasks required.');
  });

  // 4d. Empty diff tasks + empty sub-PR tasks shows "No deploy tasks required"
  it('shows "No deploy tasks required" when both sources are empty', () => {
    const section = formatDeployTasksSection([], []);
    expect(section).toContain('No deploy tasks required.');
    expect(section).not.toContain('- [ ]');
  });

  // 5. Tasks with special characters in description
  it('formats tasks with special characters in description', () => {
    const tasks: DeployTask[] = [
      makeTask({
        id: 'test-special',
        description: 'Run `SELECT * FROM "users"` and check (result > 0) | verify',
        category: 'schema',
        verifyCommand: 'psql -c "SELECT count(*) FROM users WHERE name LIKE \'%test%\'"',
      }),
    ];

    const section = formatDeployTasksSection(tasks);
    expect(section).toContain('`schema`');
    expect(section).toContain('Run `SELECT * FROM "users"` and check (result > 0) | verify');
  });

  // 6. Verify the output is valid markdown (structural checks)
  it('produces valid markdown structure', () => {
    const tasks: DeployTask[] = [
      makeTask({ id: 'a', description: 'Task A', category: 'env' }),
      makeTask({ id: 'b', description: 'Task B', category: 'ci', verifyCommand: 'echo ok' }),
    ];

    const section = formatDeployTasksSection(tasks);
    const lines = section.split('\n');

    // First line must be the heading
    expect(lines[0]).toBe('## Deploy Checklist');
    // Second line must be the start marker
    expect(lines[1]).toBe('<!-- deploy-tasks:v1 -->');
    // Last line must be the end marker
    expect(lines[lines.length - 1]).toBe('<!-- /deploy-tasks -->');
    // All task lines must start with "- [ ]"
    const taskLines = lines.filter((l) => l.startsWith('- [ ]'));
    expect(taskLines).toHaveLength(2);
  });

  // 7. Roundtrip: format then parse should preserve task count and content
  it('roundtrips through parse preserving count and content', () => {
    const tasks: DeployTask[] = [
      makeTask({
        id: 'env-FOO',
        description: 'Set FOO in production',
        category: 'env',
        phase: 'pre-merge',
        automated: false,
      }),
      makeTask({
        id: 'migration-0099',
        description: 'Verify migration 0099 applied',
        category: 'migration',
        verifyCommand: 'psql -c "SELECT 1"',
      }),
      makeTask({
        id: 'ci-deploy',
        description: 'Verify deploy workflow runs',
        category: 'ci',
        verifyCommand: 'gh run list --limit=1',
      }),
    ];

    const section = formatDeployTasksSection(tasks);
    const parsed = parseDeployTasksFromBody(section);

    expect(parsed).not.toBeNull();
    expect(parsed!.total).toBe(3);
    expect(parsed!.checked).toBe(0); // format always produces unchecked
    expect(parsed!.unchecked).toBe(3);

    // Each parsed item text should contain the original description
    expect(parsed!.items[0].text).toContain('Set FOO in production');
    expect(parsed!.items[1].text).toContain('Verify migration 0099 applied');
    expect(parsed!.items[2].text).toContain('Verify deploy workflow runs');

    // Each parsed item text should contain the category
    expect(parsed!.items[0].text).toContain('`env`');
    expect(parsed!.items[1].text).toContain('`migration`');
    expect(parsed!.items[2].text).toContain('`ci`');
  });

  it('roundtrip of empty task list preserves structure', () => {
    const section = formatDeployTasksSection([]);
    const parsed = parseDeployTasksFromBody(section);
    expect(parsed).not.toBeNull();
    expect(parsed!.total).toBe(0);
    expect(parsed!.items).toHaveLength(0);
  });

  it('includes verify command wrapped in backticks with em-dash separator', () => {
    const tasks: DeployTask[] = [
      makeTask({
        id: 'test',
        description: 'Check something',
        category: 'config',
        verifyCommand: 'curl -sf https://example.com',
      }),
    ];

    const section = formatDeployTasksSection(tasks);
    // The format is: description — `verifyCommand`
    expect(section).toContain(
      'Check something — `curl -sf https://example.com`'
    );
  });

  it('does not include em-dash or trailing backticks when no verify command', () => {
    const tasks: DeployTask[] = [
      makeTask({
        id: 'test',
        description: 'Manual step',
        category: 'manual-migration',
        automated: false,
      }),
    ];

    const section = formatDeployTasksSection(tasks);
    const taskLine = section.split('\n').find((l) => l.includes('Manual step'));
    expect(taskLine).toBeDefined();
    expect(taskLine).toBe('- [ ] `manual-migration` Manual step');
  });

  it('formats all supported categories correctly', () => {
    const categories = [
      'migration',
      'manual-migration',
      'env',
      'ci',
      'schema',
      'config',
      'route',
      'build',
      'docker',
    ] as const;

    const tasks: DeployTask[] = categories.map((cat) =>
      makeTask({ id: `test-${cat}`, description: `Task for ${cat}`, category: cat })
    );

    const section = formatDeployTasksSection(tasks);
    for (const cat of categories) {
      expect(section).toContain(`\`${cat}\``);
    }
    const checkboxLines = section.split('\n').filter((l) => l.startsWith('- [ ]'));
    expect(checkboxLines).toHaveLength(categories.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Integration tests
// ────────────────────────────────────────────────────────────────────────────

describe('integration: format + parse roundtrip', () => {
  // 1. Format a set of tasks, then parse the output — verify counts match
  it('format then parse preserves task count for multi-category tasks', () => {
    const tasks: DeployTask[] = [
      makeTask({ id: 'env-A', description: 'Set A', category: 'env', phase: 'pre-merge', automated: false }),
      makeTask({ id: 'env-B', description: 'Set B', category: 'env', phase: 'pre-merge', automated: false }),
      makeTask({ id: 'migration-01', description: 'Run migration 01', category: 'migration', verifyCommand: 'psql -c "SELECT 1"' }),
      makeTask({ id: 'ci-test', description: 'Verify CI', category: 'ci', verifyCommand: 'gh run list' }),
      makeTask({ id: 'docker-change', description: 'Docker rebuild', category: 'docker', verifyCommand: 'curl health' }),
    ];

    const section = formatDeployTasksSection(tasks);
    const parsed = parseDeployTasksFromBody(section);

    expect(parsed).not.toBeNull();
    expect(parsed!.total).toBe(5);
    expect(parsed!.checked).toBe(0);
    expect(parsed!.unchecked).toBe(5);
  });

  // 2. Inject into a PR body that has no existing section
  it('appending section to a PR body without existing section', () => {
    const existingBody = `## Summary
Made some changes.

## Test plan
- [x] Tests pass`;

    const tasks: DeployTask[] = [
      makeTask({ id: 'env-X', description: 'Set X', category: 'env', automated: false }),
    ];
    const section = formatDeployTasksSection(tasks);
    const newBody = existingBody + '\n\n' + section;

    // Verify we can parse the section back from the combined body
    const parsed = parseDeployTasksFromBody(newBody);
    expect(parsed).not.toBeNull();
    expect(parsed!.total).toBe(1);
    expect(parsed!.items[0].text).toContain('Set X');

    // Verify the original body is still present
    expect(newBody).toContain('## Summary');
    expect(newBody).toContain('## Test plan');
  });

  // 3. Inject into a PR body that has an existing section (replacement)
  it('replacing existing section in a PR body', () => {
    const existingBody = `## Summary
Original description.

## Deploy Checklist
<!-- deploy-tasks:v1 -->
- [ ] \`env\` Old task A
- [x] \`migration\` Old task B
<!-- /deploy-tasks -->

## Test plan
- [x] Tests pass`;

    // Build new section
    const newTasks: DeployTask[] = [
      makeTask({ id: 'ci-new', description: 'New CI task', category: 'ci', verifyCommand: 'gh run list' }),
      makeTask({ id: 'schema-new', description: 'New schema task', category: 'schema' }),
    ];
    const newSection = formatDeployTasksSection(newTasks);

    // Simulate the replacement logic from the inject command
    const startMarker = '<!-- deploy-tasks:v1 -->';
    const endMarker = '<!-- /deploy-tasks -->';
    const startIdx = existingBody.indexOf(startMarker);
    const endIdx = existingBody.indexOf(endMarker);

    let sectionStart = startIdx;
    const beforeMarker = existingBody.slice(0, startIdx);
    const headerIdx = beforeMarker.lastIndexOf('## Deploy Checklist');
    if (headerIdx !== -1) {
      sectionStart = headerIdx;
    }
    const replacedBody =
      existingBody.slice(0, sectionStart) +
      newSection +
      existingBody.slice(endIdx + endMarker.length);

    // Verify old tasks are gone
    expect(replacedBody).not.toContain('Old task A');
    expect(replacedBody).not.toContain('Old task B');

    // Verify new tasks are present
    const parsed = parseDeployTasksFromBody(replacedBody);
    expect(parsed).not.toBeNull();
    expect(parsed!.total).toBe(2);
    expect(parsed!.items[0].text).toContain('New CI task');
    expect(parsed!.items[1].text).toContain('New schema task');

    // Verify surrounding content is preserved
    expect(replacedBody).toContain('## Summary');
    expect(replacedBody).toContain('Original description.');
    expect(replacedBody).toContain('## Test plan');
    expect(replacedBody).toContain('- [x] Tests pass');
  });

  // 4. The section markers are present and well-formed in all outputs
  it('markers are always present and well-formed regardless of task count', () => {
    const testCases = [
      [], // empty
      [makeTask({ id: 'a', description: 'one task', category: 'env' })], // single
      // many tasks
      Array.from({ length: 10 }, (_, i) =>
        makeTask({ id: `t${i}`, description: `Task ${i}`, category: 'migration' })
      ),
    ];

    for (const tasks of testCases) {
      const section = formatDeployTasksSection(tasks);
      expect(section).toContain('<!-- deploy-tasks:v1 -->');
      expect(section).toContain('<!-- /deploy-tasks -->');
      expect(section).toContain('## Deploy Checklist');

      // Verify start marker comes before end marker
      const startIdx = section.indexOf('<!-- deploy-tasks:v1 -->');
      const endIdx = section.indexOf('<!-- /deploy-tasks -->');
      expect(startIdx).toBeLessThan(endIdx);

      // Verify parseability
      const parsed = parseDeployTasksFromBody(section);
      expect(parsed).not.toBeNull();
      expect(parsed!.total).toBe(tasks.length);
    }
  });

  it('format produces all unchecked items (fresh checklist)', () => {
    const tasks: DeployTask[] = [
      makeTask({ id: 'a', description: 'A', category: 'env' }),
      makeTask({ id: 'b', description: 'B', category: 'ci' }),
      makeTask({ id: 'c', description: 'C', category: 'docker' }),
    ];

    const section = formatDeployTasksSection(tasks);
    // No checked boxes in fresh output
    expect(section).not.toContain('[x]');
    expect(section).not.toContain('[X]');

    const parsed = parseDeployTasksFromBody(section);
    expect(parsed!.checked).toBe(0);
    expect(parsed!.unchecked).toBe(tasks.length);
  });

  it('section with manually checked items parses correctly after format+manual edit', () => {
    const tasks: DeployTask[] = [
      makeTask({ id: 'a', description: 'Task A', category: 'env' }),
      makeTask({ id: 'b', description: 'Task B', category: 'ci' }),
      makeTask({ id: 'c', description: 'Task C', category: 'docker' }),
    ];

    // Format produces all-unchecked
    let section = formatDeployTasksSection(tasks);

    // Simulate a human checking off one task
    section = section.replace('- [ ] `env` Task A', '- [x] `env` Task A');

    const parsed = parseDeployTasksFromBody(section);
    expect(parsed).not.toBeNull();
    expect(parsed!.total).toBe(3);
    expect(parsed!.checked).toBe(1);
    expect(parsed!.unchecked).toBe(2);
    expect(parsed!.items[0]).toEqual({ text: '`env` Task A', checked: true });
    expect(parsed!.items[1]).toEqual({ text: '`ci` Task B', checked: false });
    expect(parsed!.items[2]).toEqual({ text: '`docker` Task C', checked: false });
  });

  it('replacement of section inside large PR body with separators', () => {
    const body = `## Summary
Big PR with lots of changes.

---

## Deploy Checklist
<!-- deploy-tasks:v1 -->
- [ ] Old task
<!-- /deploy-tasks -->

---

## Test plan
- [x] Done

---
Generated with Claude Code`;

    const newTasks: DeployTask[] = [
      makeTask({ id: 'new-1', description: 'New task 1', category: 'build' }),
      makeTask({ id: 'new-2', description: 'New task 2', category: 'route', verifyCommand: 'curl /health' }),
    ];
    const newSection = formatDeployTasksSection(newTasks);

    // Replace using the same logic as inject command
    const startMarker = '<!-- deploy-tasks:v1 -->';
    const endMarker = '<!-- /deploy-tasks -->';
    const startIdx = body.indexOf(startMarker);
    const endIdx = body.indexOf(endMarker);
    let sectionStart = startIdx;
    const beforeMarker = body.slice(0, startIdx);
    const headerIdx = beforeMarker.lastIndexOf('## Deploy Checklist');
    if (headerIdx !== -1) sectionStart = headerIdx;

    const newBody =
      body.slice(0, sectionStart) + newSection + body.slice(endIdx + endMarker.length);

    expect(newBody).toContain('Big PR with lots of changes.');
    expect(newBody).toContain('## Test plan');
    expect(newBody).toContain('Generated with Claude Code');
    expect(newBody).not.toContain('Old task');

    const parsed = parseDeployTasksFromBody(newBody);
    expect(parsed).not.toBeNull();
    expect(parsed!.total).toBe(2);
  });
});
