import { describe, it, expect } from 'vitest';
import { buildPrompt, buildMainBranchPrompt } from './prompts.ts';
import type { DetectedPr } from './types.ts';

function makeDetectedPr(overrides: Partial<DetectedPr> = {}): DetectedPr {
  return {
    number: 42,
    title: 'Test PR',
    branch: 'claude/test',
    createdAt: '2026-01-01T00:00:00Z',
    issues: [],
    botComments: [],
    labels: [],
    ...overrides,
  };
}

const REPO = 'quantified-uncertainty/longterm-wiki';

describe('buildPrompt', () => {
  it('includes PR number and title in prompt', () => {
    const pr = makeDetectedPr({ issues: ['conflict'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('"Test PR"');
    expect(prompt).toContain('branch: claude/test');
  });

  it('includes conflict section when conflict detected', () => {
    const pr = makeDetectedPr({ issues: ['conflict'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### Merge Conflict');
    expect(prompt).toContain('git rebase origin/main');
  });

  it('includes CI failure section when ci-failure detected', () => {
    const pr = makeDetectedPr({ issues: ['ci-failure'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### CI Failure');
    expect(prompt).toContain('pre-existing failure on main');
  });

  it('includes failing check names in CI failure section when provided', () => {
    const pr = makeDetectedPr({
      issues: ['ci-failure'],
      failingChecks: ['validate', 'test'],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('The following CI checks are failing: validate, test');
    expect(prompt).toContain('saves you from needing to run');
  });

  it('does not include failing check info when failingChecks is empty', () => {
    const pr = makeDetectedPr({
      issues: ['ci-failure'],
      failingChecks: [],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### CI Failure');
    expect(prompt).not.toContain('The following CI checks are failing');
  });

  it('does not include failing check info when failingChecks is undefined', () => {
    const pr = makeDetectedPr({
      issues: ['ci-failure'],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### CI Failure');
    expect(prompt).not.toContain('The following CI checks are failing');
  });

  it('includes missing-testplan section', () => {
    const pr = makeDetectedPr({ issues: ['missing-testplan'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### Missing Test Plan');
    expect(prompt).toContain('gh pr edit');
  });

  it('includes missing-issue-ref section', () => {
    const pr = makeDetectedPr({ issues: ['missing-issue-ref'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### Missing Issue Reference');
    expect(prompt).toContain('Closes #N');
  });

  it('includes stale section', () => {
    const pr = makeDetectedPr({ issues: ['stale'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### Stale PR');
    expect(prompt).toContain('git rebase origin/main');
  });

  it('shell-escapes branch names to prevent injection', () => {
    const pr = makeDetectedPr({
      branch: "test; rm -rf /",
      issues: ['conflict'],
    });
    const prompt = buildPrompt(pr, REPO);
    // Branch name should be shell-quoted, not raw
    expect(prompt).toContain("'test; rm -rf /'");
    expect(prompt).not.toContain('git fetch origin test; rm -rf /');
  });

  it('shell-escapes branch names with single quotes', () => {
    const pr = makeDetectedPr({
      branch: "it's-a-branch",
      issues: ['conflict'],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain("'it'\\''s-a-branch'");
  });

  it('includes bot-review-major section with actionable label', () => {
    const pr = makeDetectedPr({
      issues: ['bot-review-major'],
      botComments: [{
        threadId: 'thread-1',
        path: 'src/foo.ts',
        line: 10,
        startLine: null,
        body: '🟠 Major: Fix this important issue',
        author: 'coderabbitai',
      }],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### Bot Review Comments (Actionable)');
    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('coderabbitai');
  });

  it('includes bot-review-nitpick section without actionable label', () => {
    const pr = makeDetectedPr({
      issues: ['bot-review-nitpick'],
      botComments: [{
        threadId: 'thread-2',
        path: 'src/bar.ts',
        line: 5,
        startLine: null,
        body: '🧹 Nitpick: Minor style issue',
        author: 'coderabbitai',
      }],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### Bot Review Comments (Nitpick only)');
  });

  it('does NOT include sections for issues not present', () => {
    const pr = makeDetectedPr({ issues: ['missing-issue-ref'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).not.toContain('### Merge Conflict');
    expect(prompt).not.toContain('### CI Failure');
    expect(prompt).not.toContain('### Missing Test Plan');
    expect(prompt).not.toContain('### Stale PR');
    expect(prompt).not.toContain('### Bot Review Comments');
  });

  it('includes multiple issue sections when multiple issues detected', () => {
    const pr = makeDetectedPr({ issues: ['conflict', 'ci-failure', 'stale'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('### Merge Conflict');
    expect(prompt).toContain('### CI Failure');
    expect(prompt).toContain('### Stale PR');
  });

  it('always includes guardrails section', () => {
    const pr = makeDetectedPr({ issues: ['conflict'] });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('## Guardrails');
    expect(prompt).toContain('## When to stop (escalate to human)');
  });

  it('truncates long bot comment bodies', () => {
    const longBody = 'x'.repeat(3000);
    const pr = makeDetectedPr({
      issues: ['bot-review-major'],
      botComments: [{
        threadId: 'thread-3',
        path: 'src/foo.ts',
        line: 10,
        startLine: null,
        body: longBody,
        author: 'coderabbitai',
      }],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('...(truncated)');
    // Body is truncated to 2000 chars — prompt should not contain the full 3000-char body
    expect(prompt).not.toContain(longBody);
  });

  it('shows line range for multi-line bot comments', () => {
    const pr = makeDetectedPr({
      issues: ['bot-review-major'],
      botComments: [{
        threadId: 'thread-4',
        path: 'src/foo.ts',
        line: 20,
        startLine: 15,
        body: '🟠 Major: Fix this',
        author: 'coderabbitai',
      }],
    });
    const prompt = buildPrompt(pr, REPO);
    expect(prompt).toContain('lines 15-20');
  });
});

describe('buildMainBranchPrompt', () => {
  it('includes run ID', () => {
    const prompt = buildMainBranchPrompt(12345, REPO);
    expect(prompt).toContain('12345');
    expect(prompt).toContain('CI repair agent');
  });

  it('includes rerun command', () => {
    const prompt = buildMainBranchPrompt(12345, REPO);
    expect(prompt).toContain('gh run rerun 12345');
  });
});
