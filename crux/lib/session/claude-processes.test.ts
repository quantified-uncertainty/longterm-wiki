/**
 * Unit tests for the Claude Code process scanner (QUA-413).
 */

import { describe, it, expect } from 'vitest';
import {
  slotFromPath,
  findClaudePids,
  parseLsofFpn,
  findClaudeProcesses,
} from './claude-processes.ts';

describe('slotFromPath', () => {
  it('extracts slot number from a typical slot path', () => {
    expect(slotFromPath('/Users/dev/lw/a9')).toBe(9);
    expect(slotFromPath('/Users/dev/lw/a15/apps/web')).toBe(15);
  });

  it('returns null when no a<N> ancestor exists', () => {
    expect(slotFromPath('/tmp/foo')).toBeNull();
    expect(slotFromPath('/')).toBeNull();
    expect(slotFromPath('')).toBeNull();
  });

  it('rejects non-slot a-prefixed directories', () => {
    // "apps" or "alpha" shouldn't match — only bare a<digits>
    expect(slotFromPath('/Users/dev/apps/web')).toBeNull();
    expect(slotFromPath('/Users/dev/alpha/src')).toBeNull();
  });

  it('returns the innermost slot when nested (walks leaf→root)', () => {
    // Matches session-context.ts::findSlotFromAncestors: if a process is
    // running deep inside a slot directory, the slot closest to the cwd
    // wins. Rare in practice (no one nests slots).
    expect(slotFromPath('/Users/dev/a5/nested/a9/src')).toBe(9);
    expect(slotFromPath('/Users/dev/lw/a9')).toBe(9);
    expect(slotFromPath('/Users/dev/lw/a9/apps/web')).toBe(9);
  });
});

describe('findClaudePids', () => {
  it('matches Claude Code installed binary path', () => {
    const ps = `
   95223 /Users/dev/.local/share/claude/versions/2.1.112
   12345 node /path/to/something
    `.trim();
    expect(findClaudePids(ps)).toEqual([95223]);
  });

  it('matches bare `claude` wrapper invocation', () => {
    const ps = `
   54321 claude
   55555 claude --help
    `.trim();
    expect(findClaudePids(ps)).toEqual([54321, 55555]);
  });

  it('excludes the scanner pipeline itself (ps, grep, lsof)', () => {
    const ps = `
   1000 ps -eo pid=,args=
   1001 grep claude
   1002 lsof -a -p 1000 -d cwd
   1003 claude
    `.trim();
    expect(findClaudePids(ps)).toEqual([1003]);
  });

  it('ignores unrelated processes mentioning "claude" in paths', () => {
    const ps = `
   2000 /usr/bin/node /Users/dev/some/file-about-claude.js
   2001 /bin/cat /tmp/claude-notes.txt
    `.trim();
    // These don't match CLAUDE_PROCESS_RE because the word "claude" isn't
    // preceded by whitespace-start followed by nothing-or-whitespace. They'd
    // only match if args were literally "claude" or contained `/share/claude/versions/`.
    expect(findClaudePids(ps)).toEqual([]);
  });

  it('ignores blank lines and malformed rows', () => {
    const ps = '\n\n   \n12345\nno-pid-here\n';
    expect(findClaudePids(ps)).toEqual([]);
  });
});

describe('parseLsofFpn', () => {
  it('parses multi-process output with p/n tags', () => {
    const raw = 'p95223\nfcwd\nn/Users/dev/lw/a9\np38772\nfcwd\nn/Users/dev/lw/a4\n';
    expect(parseLsofFpn(raw)).toEqual([
      { pid: 95223, cwd: '/Users/dev/lw/a9' },
      { pid: 38772, cwd: '/Users/dev/lw/a4' },
    ]);
  });

  it('ignores the fcwd fd-tag line between pid and name', () => {
    // The fcwd line (f<type>) is present in real output; we skip it silently
    // because the parser only acts on p/n tags.
    const raw = 'p1\nf cwd\nn/a\n';
    expect(parseLsofFpn(raw)).toEqual([{ pid: 1, cwd: '/a' }]);
  });

  it('returns [] on empty or malformed input', () => {
    expect(parseLsofFpn('')).toEqual([]);
    expect(parseLsofFpn('garbage\nno tags here\n')).toEqual([]);
    expect(parseLsofFpn('nMissingPid\n')).toEqual([]);
  });

  it('skips invalid pids', () => {
    const raw = 'pNotANumber\nn/foo\np0\nn/bar\np123\nn/baz\n';
    expect(parseLsofFpn(raw)).toEqual([{ pid: 123, cwd: '/baz' }]);
  });
});

describe('findClaudeProcesses — integration (mocked shell)', () => {
  it('combines ps + lsof to produce ClaudeProcess[]', () => {
    const ps = '  95223 /Users/dev/.local/share/claude/versions/2.1.112\n';
    const lsof = 'p95223\nfcwd\nn/Users/dev/lw/a9\n';
    const execCmd = (cmd: string) => {
      if (cmd.startsWith('ps ')) return ps;
      if (cmd.startsWith('lsof ')) return lsof;
      throw new Error(`unexpected: ${cmd}`);
    };
    const result = findClaudeProcesses({ execCmd });
    expect(result.scanFailed).toBe(false);
    expect(result.processes).toEqual([
      { pid: 95223, cwd: '/Users/dev/lw/a9', slot: 9 },
    ]);
  });

  it('returns empty scan-succeeded result when no Claude processes found (skips lsof entirely)', () => {
    const calls: string[] = [];
    const execCmd = (cmd: string) => {
      calls.push(cmd);
      if (cmd.startsWith('ps ')) return '  1 /sbin/launchd\n';
      throw new Error('lsof should not be called');
    };
    const result = findClaudeProcesses({ execCmd });
    expect(result).toEqual({ processes: [], scanFailed: false, scanError: '' });
    expect(calls).toHaveLength(1); // only ps, never lsof
  });

  it('marks scanFailed=true when ps fails', () => {
    const execCmd = (cmd: string) => {
      if (cmd.startsWith('ps ')) throw new Error('ps: command not found');
      throw new Error('unreachable');
    };
    const result = findClaudeProcesses({ execCmd });
    expect(result.scanFailed).toBe(true);
    expect(result.scanError).toContain('ps failed');
    expect(result.processes).toEqual([]);
  });

  it('marks scanFailed=true when lsof fails after ps succeeds (no partial results)', () => {
    const execCmd = (cmd: string) => {
      if (cmd.startsWith('ps ')) return '  1 claude\n';
      throw new Error('lsof: permission denied');
    };
    const result = findClaudeProcesses({ execCmd });
    expect(result.scanFailed).toBe(true);
    expect(result.scanError).toContain('lsof failed');
    expect(result.processes).toEqual([]);
  });

  it('marks cwd outside slot dirs with slot=null', () => {
    const ps = '  1 claude\n';
    const lsof = 'p1\nfcwd\nn/tmp\n';
    const execCmd = (cmd: string) => (cmd.startsWith('ps ') ? ps : lsof);
    const result = findClaudeProcesses({ execCmd });
    expect(result.processes).toEqual([{ pid: 1, cwd: '/tmp', slot: null }]);
  });
});
