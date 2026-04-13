/**
 * Unit tests for session-context.ts — the shared helper that builds the
 * "starting work" comment body for `crux linear start` and `crux gh issues start`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildStartCommentBody,
  getSessionContext,
  type SessionContext,
  type SessionContextDeps,
} from './session-context.ts';

// ---------------------------------------------------------------------------
// getSessionContext — pure, dependency-injected so no fs/git mocking required
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<SessionContextDeps>): SessionContextDeps {
  const files = new Map<string, string>();
  return {
    cwd: '/Users/dev/Documents/GitHub.nosync/lw/a10',
    gitBranch: () => 'claude/qua-336-test',
    hostnameFn: () => 'dev-mbp',
    fileExists: (p: string) => files.has(p),
    readFile: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`no such file: ${p}`);
      return v;
    },
    ...overrides,
  };
}

describe('getSessionContext', () => {
  it('resolves slot from directory basename matching /^a\\d+$/', () => {
    const ctx = getSessionContext(makeDeps({}));
    expect(ctx.slot).toBe(10);
    expect(ctx.branch).toBe('claude/qua-336-test');
    expect(ctx.host).toBe('dev-mbp');
    expect(ctx.agentId).toBeNull();
  });

  it('falls back to .agent-slot when directory name does not match', () => {
    const files = new Map<string, string>([
      ['/Users/dev/workspace/.agent-slot', '7\n'],
    ]);
    const ctx = getSessionContext({
      cwd: '/Users/dev/workspace',
      gitBranch: () => 'main',
      hostnameFn: () => 'dev-mbp',
      fileExists: (p) => files.has(p),
      readFile: (p) => files.get(p) ?? (() => { throw new Error(); })(),
    });
    expect(ctx.slot).toBe(7);
  });

  it('returns null slot when neither directory nor slot file works', () => {
    const ctx = getSessionContext({
      cwd: '/tmp/someplace',
      gitBranch: () => 'main',
      hostnameFn: () => 'dev-mbp',
      fileExists: () => false,
      readFile: () => { throw new Error('unreachable'); },
    });
    expect(ctx.slot).toBeNull();
  });

  it('ignores non-numeric .agent-slot contents', () => {
    const files = new Map<string, string>([
      ['/tmp/wat/.agent-slot', 'oops\n'],
    ]);
    const ctx = getSessionContext({
      cwd: '/tmp/wat',
      gitBranch: () => 'main',
      hostnameFn: () => 'dev-mbp',
      fileExists: (p) => files.has(p),
      readFile: (p) => files.get(p)!,
    });
    expect(ctx.slot).toBeNull();
  });

  it('reads agent ID from .claude/agent-id when present', () => {
    const files = new Map<string, string>([
      ['/Users/dev/Documents/GitHub.nosync/lw/a10/.claude/agent-id', '1234\n'],
    ]);
    const ctx = getSessionContext({
      cwd: '/Users/dev/Documents/GitHub.nosync/lw/a10',
      gitBranch: () => 'claude/qua-336-test',
      hostnameFn: () => 'dev-mbp',
      fileExists: (p) => files.has(p),
      readFile: (p) => files.get(p)!,
    });
    expect(ctx.agentId).toBe(1234);
  });

  it('ignores malformed agent-id file', () => {
    const files = new Map<string, string>([
      ['/Users/dev/Documents/GitHub.nosync/lw/a10/.claude/agent-id', 'garbage'],
    ]);
    const ctx = getSessionContext({
      cwd: '/Users/dev/Documents/GitHub.nosync/lw/a10',
      gitBranch: () => 'claude/qua-336-test',
      hostnameFn: () => 'dev-mbp',
      fileExists: (p) => files.has(p),
      readFile: (p) => files.get(p)!,
    });
    expect(ctx.agentId).toBeNull();
  });

  it('returns unknown-branch when git fails', () => {
    const ctx = getSessionContext({
      cwd: '/tmp/wat',
      gitBranch: () => { throw new Error('not a git repo'); },
      hostnameFn: () => 'dev-mbp',
      fileExists: () => false,
      readFile: () => { throw new Error(); },
    });
    expect(ctx.branch).toBe('unknown-branch');
  });

  it('normalizes empty branch to "unknown-branch"', () => {
    const ctx = getSessionContext({
      cwd: '/Users/dev/Documents/GitHub.nosync/lw/a10',
      gitBranch: () => '',
      hostnameFn: () => 'dev-mbp',
      fileExists: () => false,
      readFile: () => { throw new Error(); },
    });
    expect(ctx.branch).toBe('unknown-branch');
  });

  it('normalizes empty hostname to null', () => {
    const ctx = getSessionContext({
      cwd: '/Users/dev/Documents/GitHub.nosync/lw/a10',
      gitBranch: () => 'claude/qua-336-test',
      hostnameFn: () => '',
      fileExists: () => false,
      readFile: () => { throw new Error(); },
    });
    expect(ctx.host).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildStartCommentBody
// ---------------------------------------------------------------------------

function ctx(partial: Partial<SessionContext> = {}): SessionContext {
  return {
    slot: 10,
    branch: 'claude/qua-336-test',
    host: 'dev-mbp',
    agentId: null,
    ...partial,
  };
}

describe('buildStartCommentBody', () => {
  it('includes slot, branch, and host when all present', () => {
    const body = buildStartCommentBody(ctx());
    expect(body).toContain('**Slot:** a10');
    expect(body).toContain('**Branch:** `claude/qua-336-test`');
    expect(body).toContain('**Host:** dev-mbp');
    expect(body).not.toContain('⚠');
  });

  it('includes agent ID when present', () => {
    const body = buildStartCommentBody(ctx({ agentId: 1234 }));
    expect(body).toContain('**Active agent ID:** #1234');
    expect(body).toContain('E925 dashboard');
  });

  it('omits fields cleanly when null', () => {
    const body = buildStartCommentBody(ctx({ slot: null, host: null, agentId: null }));
    expect(body).not.toContain('**Slot:**');
    expect(body).not.toContain('**Host:**');
    expect(body).not.toContain('**Active agent ID:**');
    expect(body).toContain('**Branch:**');
  });

  it('flags main branch with a visible warning marker', () => {
    const body = buildStartCommentBody(ctx({ branch: 'main' }));
    expect(body).toContain('**Branch:** `main` ⚠');
    expect(body).toContain("init'd before feature branch");
  });

  it('flags master branch the same way', () => {
    const body = buildStartCommentBody(ctx({ branch: 'master' }));
    expect(body).toContain('**Branch:** `master` ⚠');
  });

  it('does not flag claude/qua-* branches', () => {
    const body = buildStartCommentBody(ctx({ branch: 'claude/qua-336-foo' }));
    expect(body).not.toContain('⚠');
  });

  it('uses the default trailing sentence when not overridden', () => {
    const body = buildStartCommentBody(ctx());
    expect(body).toContain('Will post an update when a PR is ready for review.');
  });

  it('honors a custom trailing sentence (for GitHub-issues variant)', () => {
    const body = buildStartCommentBody(ctx(), {
      trailing: 'Will post an update here when a PR is ready for review.',
    });
    expect(body).toContain('Will post an update here when a PR is ready for review.');
  });

  it('starts with the emoji header', () => {
    const body = buildStartCommentBody(ctx());
    expect(body.startsWith('🤖 Claude Code starting work on this issue.')).toBe(true);
  });

  it('produces deterministic output for a given context (stable formatting)', () => {
    const body1 = buildStartCommentBody(ctx({ agentId: 42 }));
    const body2 = buildStartCommentBody(ctx({ agentId: 42 }));
    expect(body1).toBe(body2);
  });
});
