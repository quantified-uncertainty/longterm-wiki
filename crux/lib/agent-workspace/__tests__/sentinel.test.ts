import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveSessionKey,
  sentinelPath,
  serializeSentinel,
  parseSentinel,
  isLive,
  buildOurSentinel,
  writeSentinel,
  touchSentinel,
  checkConflict,
  TTL_SECONDS,
  type Sentinel,
  type SentinelEnv,
} from '../sentinel.ts';

/** Minimal in-memory env for sentinel tests. */
class FakeEnv implements SentinelEnv {
  files: Map<string, { content: string; mtime: number }> = new Map();
  panes: string[] | null = null;
  alivePids: Set<number> = new Set();
  env: NodeJS.ProcessEnv;
  private current: Date;

  constructor(opts: {
    nowSec?: number;
    env?: NodeJS.ProcessEnv;
    panes?: string[] | null;
    alivePids?: number[];
  } = {}) {
    this.current = new Date((opts.nowSec ?? 1_700_000_000) * 1000);
    this.env = opts.env ?? {};
    this.panes = opts.panes === undefined ? null : opts.panes;
    if (opts.alivePids) for (const p of opts.alivePids) this.alivePids.add(p);
  }

  now() { return this.current; }
  setNow(secs: number) { this.current = new Date(secs * 1000); }
  readFile(path: string) { return this.files.get(path)?.content ?? null; }
  writeFile(path: string, content: string) {
    this.files.set(path, { content, mtime: Math.floor(this.current.getTime() / 1000) });
  }
  touch(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`touch: missing ${path}`);
    f.mtime = Math.floor(this.current.getTime() / 1000);
  }
  statMtime(path: string) { return this.files.get(path)?.mtime ?? null; }
  unlink(path: string) { this.files.delete(path); }
  listMatching(dir: string, prefix: string) {
    const results: string[] = [];
    for (const k of this.files.keys()) {
      const idx = k.lastIndexOf('/');
      const parent = idx >= 0 ? k.slice(0, idx) : '';
      const name = k.slice(idx + 1);
      if (parent === dir && name.startsWith(prefix)) results.push(k);
    }
    return results.sort();
  }
  listTmuxPanes() { return this.panes; }
  pidAlive(pid: number) { return this.alivePids.has(pid); }
  hostname() { return 'test-host'; }
  uid() { return 501; }
  ppid() { return 9999; }
}

describe('deriveSessionKey', () => {
  it('strips leading % from TMUX_PANE', () => {
    expect(deriveSessionKey({ TMUX_PANE: '%69' }, 1234)).toBe('69');
  });
  it('passes through TMUX_PANE without % verbatim', () => {
    expect(deriveSessionKey({ TMUX_PANE: '69' }, 1234)).toBe('69');
  });
  it('falls back to pid-<ppid> when TMUX_PANE absent', () => {
    expect(deriveSessionKey({}, 1234)).toBe('pid-1234');
  });
  it('falls back to pid-<ppid> when TMUX_PANE empty', () => {
    expect(deriveSessionKey({ TMUX_PANE: '' }, 99)).toBe('pid-99');
  });
});

describe('sentinelPath', () => {
  it('builds /tmp/lw-coord-sentinel-<role>-<key>', () => {
    expect(sentinelPath('slots', '69')).toBe('/tmp/lw-coord-sentinel-slots-69');
    expect(sentinelPath('releases', 'pid-12')).toBe('/tmp/lw-coord-sentinel-releases-pid-12');
  });
});

describe('deriveSessionKey — hostile TMUX_PANE', () => {
  it('strips path-traversal characters', () => {
    expect(deriveSessionKey({ TMUX_PANE: '%../../etc/passwd' }, 9)).toBe('etcpasswd');
  });
  it('falls back to pid when the sanitized result is empty', () => {
    expect(deriveSessionKey({ TMUX_PANE: '%///' }, 42)).toBe('pid-42');
  });
  it('preserves underscore and dash', () => {
    expect(deriveSessionKey({ TMUX_PANE: 'abc_123-xyz' }, 0)).toBe('abc_123-xyz');
  });
});

describe('serialize — host sanitization', () => {
  it('replaces whitespace in hostname so parse round-trips', () => {
    const s: Sentinel = {
      role: 'slots', tmuxPane: '%1', ppid: 1, created: 1,
      host: "Ozzie's MacBook", user: 0,
    };
    const text = serializeSentinel(s);
    // No embedded whitespace in the host field
    expect(text.match(/host=\S+/)?.[0]).toBe('host=Ozzie\'s_MacBook');
    // Round-trip succeeds despite the original having spaces
    const parsed = parseSentinel(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.host).toBe("Ozzie's_MacBook");
  });
  it('replaces `=` in hostname so field list stays delimited', () => {
    const s: Sentinel = {
      role: 'slots', tmuxPane: '%1', ppid: 1, created: 1,
      host: 'a=b=c', user: 0,
    };
    const parsed = parseSentinel(serializeSentinel(s));
    expect(parsed?.host).toBe('a_b_c');
  });
});

describe('serialize/parse round-trip', () => {
  it('round-trips a full sentinel', () => {
    const s: Sentinel = {
      role: 'slots',
      tmuxPane: '%69',
      ppid: 28086,
      created: 1_744_478_400,
      host: 'ozzie-mbp',
      user: 501,
    };
    const text = serializeSentinel(s);
    expect(text).toBe('role=slots tmux_pane=%69 ppid=28086 created=1744478400 host=ozzie-mbp user=501\n');
    expect(parseSentinel(text)).toEqual(s);
  });
  it('round-trips a non-tmux sentinel (empty pane)', () => {
    const s: Sentinel = {
      role: 'releases',
      tmuxPane: '',
      ppid: 1,
      created: 100,
      host: 'h',
      user: 0,
    };
    expect(parseSentinel(serializeSentinel(s))).toEqual(s);
  });
  it('rejects malformed lines', () => {
    expect(parseSentinel('')).toBeNull();
    expect(parseSentinel('garbage with no equals')).toBeNull();
    expect(parseSentinel('role=invalid tmux_pane=%1 ppid=1 created=1 host=h user=0')).toBeNull();
    expect(parseSentinel('role=slots tmux_pane=%1 ppid=NaN created=1 host=h user=0')).toBeNull();
  });
});

describe('isLive', () => {
  let env: FakeEnv;
  beforeEach(() => {
    env = new FakeEnv({ nowSec: 1_000_000, panes: ['%1', '%2', '%69'], alivePids: [10, 20] });
  });

  it('returns expired when sentinel mtime > 24h ago', () => {
    env.writeFile('/tmp/x', 'role=slots tmux_pane=%69 ppid=10 created=1 host=h user=0');
    env.setNow(1_000_000 + TTL_SECONDS + 5);
    const result = isLive('/tmp/x', parseSentinel(env.readFile('/tmp/x')!)!, env);
    expect(result.live).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('returns expired when file is missing', () => {
    expect(isLive('/tmp/missing', null, env)).toMatchObject({ live: false, reason: 'expired' });
  });

  it('returns live when pane is in tmux pane list', () => {
    env.writeFile('/tmp/x', 'role=slots tmux_pane=%69 ppid=10 created=1 host=h user=0');
    const result = isLive('/tmp/x', parseSentinel(env.readFile('/tmp/x')!)!, env);
    expect(result.live).toBe(true);
    expect(result.reason).toBe('fresh');
  });

  it('returns pane-gone when pane is not in tmux list', () => {
    env.writeFile('/tmp/x', 'role=slots tmux_pane=%999 ppid=10 created=1 host=h user=0');
    const result = isLive('/tmp/x', parseSentinel(env.readFile('/tmp/x')!)!, env);
    expect(result.live).toBe(false);
    expect(result.reason).toBe('pane-gone');
  });

  it('falls back to ppid liveness when no pane', () => {
    env.writeFile('/tmp/x', 'role=slots tmux_pane= ppid=10 created=1 host=h user=0');
    const r = isLive('/tmp/x', parseSentinel(env.readFile('/tmp/x')!)!, env);
    expect(r.live).toBe(true);
  });

  it('returns pid-gone when ppid no longer alive', () => {
    env.writeFile('/tmp/x', 'role=slots tmux_pane= ppid=99999 created=1 host=h user=0');
    const r = isLive('/tmp/x', parseSentinel(env.readFile('/tmp/x')!)!, env);
    expect(r.live).toBe(false);
    expect(r.reason).toBe('pid-gone');
  });

  it('treats unparseable as live (do not destroy unknown formats)', () => {
    env.writeFile('/tmp/x', 'totally not a sentinel');
    const r = isLive('/tmp/x', null, env);
    expect(r.live).toBe(true);
    expect(r.reason).toBe('unparseable');
  });

  it('treats tmux unavailable as live (cannot disprove)', () => {
    env.panes = null; // not in tmux
    env.writeFile('/tmp/x', 'role=slots tmux_pane=%99 ppid=10 created=1 host=h user=0');
    const r = isLive('/tmp/x', parseSentinel(env.readFile('/tmp/x')!)!, env);
    expect(r.live).toBe(true);
  });
});

describe('writeSentinel + buildOurSentinel', () => {
  it('writes to the correct path with our session key', () => {
    const env = new FakeEnv({
      nowSec: 100,
      env: { TMUX_PANE: '%42', PPID: '777' },
      panes: ['%42'],
    });
    const { path, sentinel } = writeSentinel('slots', env);
    expect(path).toBe('/tmp/lw-coord-sentinel-slots-42');
    expect(sentinel.role).toBe('slots');
    expect(sentinel.created).toBe(100);
    expect(sentinel.host).toBe('test-host');
    expect(env.readFile(path)).toContain('role=slots');
    expect(env.readFile(path)).toContain('tmux_pane=%42');
  });

  it('uses pid-<PPID> path when not in tmux', () => {
    const env = new FakeEnv({ nowSec: 100, env: { PPID: '555' } });
    const { path } = writeSentinel('releases', env);
    expect(path).toBe('/tmp/lw-coord-sentinel-releases-pid-555');
  });
});

describe('touchSentinel', () => {
  it('touches existing file', () => {
    const env = new FakeEnv({ nowSec: 100, env: { TMUX_PANE: '%1' } });
    writeSentinel('slots', env);
    env.setNow(500);
    const r = touchSentinel('slots', env);
    expect(r.touched).toBe(true);
    expect(env.statMtime('/tmp/lw-coord-sentinel-slots-1')).toBe(500);
  });
  it('returns touched=false if absent', () => {
    const env = new FakeEnv({ nowSec: 100, env: { TMUX_PANE: '%1' } });
    expect(touchSentinel('slots', env).touched).toBe(false);
  });
});

describe('checkConflict', () => {
  it('returns no conflict when no other-role sentinels exist', () => {
    const env = new FakeEnv({ env: { TMUX_PANE: '%1' }, panes: ['%1'] });
    const r = checkConflict('slots', env);
    expect(r.conflict).toBeNull();
    expect(r.cleaned).toBe(0);
  });

  it('detects same-session conflict (role conflation)', () => {
    const env = new FakeEnv({ nowSec: 100, env: { TMUX_PANE: '%69' }, panes: ['%69'] });
    // Other-role sentinel from the SAME pane → role conflation
    env.writeFile(
      '/tmp/lw-coord-sentinel-releases-69',
      'role=releases tmux_pane=%69 ppid=10 created=100 host=h user=0',
    );
    const r = checkConflict('slots', env);
    expect(r.conflict).not.toBeNull();
    expect(r.conflict?.kind).toBe('same-session');
    expect(r.conflict?.path).toBe('/tmp/lw-coord-sentinel-releases-69');
  });

  it('detects cross-session conflict (other role in DIFFERENT pane = expected)', () => {
    const env = new FakeEnv({ env: { TMUX_PANE: '%1' }, panes: ['%1', '%2'] });
    env.writeFile(
      '/tmp/lw-coord-sentinel-releases-2',
      'role=releases tmux_pane=%2 ppid=10 created=1700000000 host=h user=0',
    );
    const r = checkConflict('slots', env);
    expect(r.conflict?.kind).toBe('other-session');
  });

  it('removes stale sentinels and reports them as cleaned', () => {
    const env = new FakeEnv({
      nowSec: 1_000_000 + TTL_SECONDS + 100,
      env: { TMUX_PANE: '%1' },
      panes: ['%1'],
    });
    // Manually inject an OLD sentinel (mtime in the distant past)
    env.files.set('/tmp/lw-coord-sentinel-releases-99', {
      content: 'role=releases tmux_pane=%99 ppid=10 created=1 host=h user=0',
      mtime: 1_000_000 - 1, // long ago
    });
    const r = checkConflict('slots', env);
    expect(r.cleaned).toBe(1);
    expect(r.conflict).toBeNull();
    expect(env.readFile('/tmp/lw-coord-sentinel-releases-99')).toBeNull();
  });

  it('only checks the OTHER role, not our own role', () => {
    const env = new FakeEnv({ env: { TMUX_PANE: '%1' }, panes: ['%1'] });
    // A live sentinel for OUR role from a different pane: not a conflict
    env.writeFile(
      '/tmp/lw-coord-sentinel-slots-99',
      'role=slots tmux_pane=%99 ppid=10 created=1700000000 host=h user=0',
    );
    const r = checkConflict('slots', env);
    expect(r.conflict).toBeNull();
  });
});
