/**
 * Tests for the @lw-coord-role marker integration in renameTmuxWindows.
 *
 * The function itself shells out to `tmux`; we mock at the child_process
 * boundary using vi.mock so the test exercises the real branching logic
 * without touching a real tmux session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execCalls: Array<{ cmd: string; opts?: unknown }> = [];

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn((cmd: string, opts?: unknown) => {
      execCalls.push({ cmd, opts });
      return execScript(cmd);
    }),
    // execFileSync calls are also recorded as a synthesized command string so
    // the existing assertions (which match on `cmd.includes('rename-window')`,
    // `-t "1"`, etc.) keep working after the QUA-755 shell-injection fixes
    // converted template-literal execSync calls to execFileSync arg arrays.
    execFileSync: vi.fn((file: string, args: readonly string[], opts?: unknown) => {
      // Synthesize a shell-style command string so the existing assertions
      // — which match on substrings like `rename-window`, `-t "1"`, `"LW"` —
      // keep working. Flag-like args (-t, --foo) stay unquoted; everything
      // else is quoted so the assertions see the same surface they did
      // before the QUA-755 execSync→execFileSync conversion.
      const quote = (a: string) => (a.startsWith('-') ? a : `"${a}"`);
      const cmd = [file, ...args.map(quote)].join(' ');
      execCalls.push({ cmd, opts });
      return execScript(cmd);
    }),
  };
});

vi.mock('../../lib/content-types.ts', () => ({ PROJECT_ROOT: '/lw/main' }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: () => true,
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => true }) as never,
  };
});

let scriptedExec: (cmd: string) => string = () => '';
function execScript(cmd: string): string {
  return scriptedExec(cmd);
}

beforeEach(() => {
  execCalls.length = 0;
  scriptedExec = () => '';
  process.env.TMUX = '/tmp/tmux-501/default,1,0';
});

describe('renameTmuxWindows + @lw-coord-role marker', () => {
  it('skips marked windows entirely (no rename-window call)', async () => {
    const mod = await import('../agent-workspace.ts');
    const fns = mod as unknown as { commands: Record<string, (a: string[], o: object) => Promise<{ exitCode: number; output?: string }>> };
    expect(fns.commands['fix-tabs']).toBeDefined();

    scriptedExec = (cmd) => {
      if (cmd.startsWith('tmux -V')) return 'tmux 3.3a\n';
      if (cmd.includes('@lw-coord-role')) {
        // Window @0 is marked "slots", @1 has no marker
        return '0|||slots\n1|||\n';
      }
      if (cmd.startsWith('tmux list-windows')) {
        // The "lw root" window @1 — should be renamed to LW
        return '1|||/lw|||old-name\n0|||/lw|||slots\n';
      }
      if (cmd.startsWith('git ')) return 'main';
      return '';
    };

    const result = await fns.commands['fix-tabs']([], {});
    expect(result.exitCode).toBe(0);
    // Only window 1 ("LW" candidate) should have been renamed
    const renames = execCalls.filter((c) => c.cmd.includes('rename-window'));
    expect(renames).toHaveLength(1);
    expect(renames[0].cmd).toContain('-t "1"');
    expect(renames[0].cmd).toContain('"LW"');
    // window 0 (marked "slots") MUST NOT appear in any rename-window call
    expect(renames.every((c) => !c.cmd.includes('-t "0"'))).toBe(true);
  });

  it('falls back to legacy behavior on tmux <3.0 (no marker query result)', async () => {
    const mod = await import('../agent-workspace.ts');
    const fns = mod as unknown as { commands: Record<string, (a: string[], o: object) => Promise<{ exitCode: number; output?: string }>> };

    scriptedExec = (cmd) => {
      if (cmd.startsWith('tmux -V')) return 'tmux 2.9a\n';
      if (cmd.includes('@lw-coord-role')) return '';
      if (cmd.startsWith('tmux list-windows')) return '0|||/lw|||old\n';
      if (cmd.startsWith('git ')) return 'main';
      return '';
    };

    await fns.commands['fix-tabs']([], {});
    const renames = execCalls.filter((c) => c.cmd.includes('rename-window'));
    expect(renames).toHaveLength(1);
    expect(renames[0].cmd).toContain('"LW"');
  });

  it('renames slot window when no marker is set', async () => {
    const mod = await import('../agent-workspace.ts');
    const fns = mod as unknown as { commands: Record<string, (a: string[], o: object) => Promise<{ exitCode: number; output?: string }>> };

    scriptedExec = (cmd) => {
      if (cmd.startsWith('tmux -V')) return 'tmux 3.3a\n';
      if (cmd.includes('@lw-coord-role')) return '5|||\n';
      if (cmd.startsWith('tmux list-windows')) return '5|||/lw/a3|||old\n';
      if (cmd.startsWith('git ')) return 'feature-x';
      return '';
    };

    await fns.commands['fix-tabs']([], {});
    const renames = execCalls.filter((c) => c.cmd.includes('rename-window'));
    expect(renames).toHaveLength(1);
    expect(renames[0].cmd).toContain('A3:feature-x');
  });
});
