import { describe, it, expect } from 'vitest';
import {
  parseTmuxVersion,
  probeTmuxVersion,
  listWindowsWithMarkers,
  claimWindow,
  ROLE_MARKER,
  type TmuxExec,
  type TmuxExecResult,
} from '../tmux.ts';

/** Minimal TmuxExec stub; records every call for assertions. */
class FakeTmux implements TmuxExec {
  calls: string[][] = [];
  constructor(
    private inSession: boolean,
    private replies: ((args: string[]) => TmuxExecResult)[],
  ) {}
  inTmux() { return this.inSession ? '/tmp/tmux-501/default,123,0' : null; }
  run(args: string[]): TmuxExecResult {
    this.calls.push(args);
    const handler = this.replies.shift();
    if (!handler) throw new Error(`unexpected tmux call: ${args.join(' ')}`);
    return handler(args);
  }
}

const ok = (stdout: string): TmuxExecResult => ({ stdout, stderr: '', code: 0 });
const err = (stderr: string, code = 1): TmuxExecResult => ({ stdout: '', stderr, code });

describe('parseTmuxVersion', () => {
  it('parses 3.3a', () => {
    const v = parseTmuxVersion('tmux 3.3a');
    expect(v.major).toBe(3);
    expect(v.minor).toBe(3);
    expect(v.supportsUserOptionFormat).toBe(true);
  });
  it('parses 3.0', () => {
    const v = parseTmuxVersion('tmux 3.0');
    expect(v.supportsUserOptionFormat).toBe(true);
  });
  it('parses 2.9 as unsupported', () => {
    const v = parseTmuxVersion('tmux 2.9a');
    expect(v.major).toBe(2);
    expect(v.supportsUserOptionFormat).toBe(false);
  });
  it('handles next-3.5 dev builds', () => {
    const v = parseTmuxVersion('tmux next-3.5');
    expect(v.major).toBe(3);
    expect(v.minor).toBe(5);
    expect(v.supportsUserOptionFormat).toBe(true);
  });
  it('returns 0.0 for unparseable (master, etc)', () => {
    const v = parseTmuxVersion('tmux master');
    expect(v.major).toBe(0);
    expect(v.supportsUserOptionFormat).toBe(false);
  });
});

describe('probeTmuxVersion', () => {
  it('returns null when not in tmux', () => {
    const t = new FakeTmux(false, []);
    expect(probeTmuxVersion(t)).toBeNull();
  });
  it('returns parsed version when tmux -V succeeds', () => {
    const t = new FakeTmux(true, [() => ok('tmux 3.3a\n')]);
    const v = probeTmuxVersion(t)!;
    expect(v.major).toBe(3);
    expect(v.minor).toBe(3);
  });
  it('returns null when tmux -V fails', () => {
    const t = new FakeTmux(true, [() => err('command not found')]);
    expect(probeTmuxVersion(t)).toBeNull();
  });
});

describe('listWindowsWithMarkers', () => {
  it('uses marker format on tmux ≥ 3.0 and parses role tags', () => {
    const t = new FakeTmux(true, [
      (args) => {
        expect(args).toContain('list-windows');
        expect(args.join(' ')).toContain(ROLE_MARKER);
        return ok('@1\t0\tslots\tslots\n@2\t1\tnotes\t\n@3\t2\treleases\treleases\n');
      },
    ]);
    const v = parseTmuxVersion('tmux 3.3a');
    const wins = listWindowsWithMarkers(t, v);
    expect(wins).toEqual([
      { windowId: '@1', index: '0', name: 'slots', role: 'slots' },
      { windowId: '@2', index: '1', name: 'notes', role: null },
      { windowId: '@3', index: '2', name: 'releases', role: 'releases' },
    ]);
  });

  it('omits marker format on tmux < 3.0 and returns role=null for all', () => {
    const t = new FakeTmux(true, [
      (args) => {
        expect(args.join(' ')).not.toContain(ROLE_MARKER);
        return ok('@1\t0\tslots\n@2\t1\tnotes\n');
      },
    ]);
    const v = parseTmuxVersion('tmux 2.9a');
    const wins = listWindowsWithMarkers(t, v);
    expect(wins.map((w) => w.role)).toEqual([null, null]);
    expect(wins).toHaveLength(2);
  });

  it('returns unmarked windows when version is null (tmux unavailable)', () => {
    const t = new FakeTmux(true, [
      () => ok('@1\t0\tslots\n@2\t1\tnotes\n'),
    ]);
    const wins = listWindowsWithMarkers(t, null);
    expect(wins).toHaveLength(2);
    expect(wins.every((w) => w.role === null)).toBe(true);
  });

  it('returns [] when list-windows fails', () => {
    const t = new FakeTmux(true, [() => err('no server')]);
    expect(listWindowsWithMarkers(t, parseTmuxVersion('tmux 3.3'))).toEqual([]);
  });

  it('ignores unknown role values', () => {
    const t = new FakeTmux(true, [() => ok('@1\t0\tweird\tbogus\n')]);
    const v = parseTmuxVersion('tmux 3.3');
    expect(listWindowsWithMarkers(t, v)[0].role).toBeNull();
  });
});

describe('claimWindow', () => {
  it('skips when not in tmux', () => {
    const t = new FakeTmux(false, []);
    const r = claimWindow('slots', t);
    expect(r.status).toBe('skipped-no-tmux');
    expect(t.calls).toHaveLength(0);
  });

  it('on tmux ≥ 3.0: probes version, finds current, sets marker BEFORE renaming', () => {
    const t = new FakeTmux(true, [
      () => ok('tmux 3.3a\n'),                  // -V
      () => ok('@7\n'),                         // display-message current
      () => ok('main\nnotes\n'),                // list-windows existing
      () => ok(''),                             // set-option marker
      () => ok(''),                             // rename-window
    ]);
    const r = claimWindow('slots', t);
    expect(r.status).toBe('claimed');
    expect(r.finalName).toBe('slots');
    expect(r.marker).toBe('slots');
    expect(r.markerUnsupported).toBe(false);

    // CRITICAL: set-option must come before rename-window
    const setIdx = t.calls.findIndex((c) => c.includes('set-option'));
    const renameIdx = t.calls.findIndex((c) => c.includes('rename-window'));
    expect(setIdx).toBeGreaterThan(-1);
    expect(renameIdx).toBeGreaterThan(setIdx);

    // set-option targets the current window id
    expect(t.calls[setIdx]).toEqual([
      'set-option', '-w', '-t', '@7', ROLE_MARKER, 'slots',
    ]);
    expect(t.calls[renameIdx]).toEqual(['rename-window', '-t', '@7', 'slots']);
  });

  it('picks role-2 when a window already named "slots" exists', () => {
    const t = new FakeTmux(true, [
      () => ok('tmux 3.3\n'),
      () => ok('@5\n'),
      () => ok('slots\nmain\n'),                // collision
      () => ok(''),
      () => ok(''),
    ]);
    const r = claimWindow('slots', t);
    expect(r.status).toBe('claimed');
    expect(r.finalName).toBe('slots-2');
  });

  it('picks role-3 when both slots and slots-2 exist', () => {
    const t = new FakeTmux(true, [
      () => ok('tmux 3.3\n'),
      () => ok('@5\n'),
      () => ok('slots\nslots-2\nmain\n'),
      () => ok(''),
      () => ok(''),
    ]);
    expect(claimWindow('slots', t).finalName).toBe('slots-3');
  });

  it('on tmux < 3.0: skips marker, still renames, sets markerUnsupported', () => {
    const t = new FakeTmux(true, [
      () => ok('tmux 2.9a\n'),
      () => ok('@9\n'),
      () => ok('main\n'),
      () => ok(''),                             // rename only — no set-option call
    ]);
    const r = claimWindow('releases', t);
    expect(r.status).toBe('claimed');
    expect(r.markerUnsupported).toBe(true);
    expect(r.marker).toBeUndefined();
    // Verify set-option was NOT called
    expect(t.calls.some((c) => c.includes('set-option'))).toBe(false);
  });

  it('returns error when set-option fails', () => {
    const t = new FakeTmux(true, [
      () => ok('tmux 3.3\n'),
      () => ok('@1\n'),
      () => ok('main\n'),
      () => err('permission denied'),
    ]);
    const r = claimWindow('slots', t);
    expect(r.status).toBe('error');
    expect(r.detail).toContain('permission denied');
  });

  it('returns error when rename fails', () => {
    const t = new FakeTmux(true, [
      () => ok('tmux 3.3\n'),
      () => ok('@1\n'),
      () => ok('main\n'),
      () => ok(''),
      () => err('cannot rename'),
    ]);
    const r = claimWindow('slots', t);
    expect(r.status).toBe('error');
    expect(r.detail).toContain('cannot rename');
  });

  it('returns skipped-no-current when display-message returns empty', () => {
    const t = new FakeTmux(true, [
      () => ok('tmux 3.3\n'),
      () => err('no current window'),
    ]);
    expect(claimWindow('slots', t).status).toBe('skipped-no-current');
  });
});
