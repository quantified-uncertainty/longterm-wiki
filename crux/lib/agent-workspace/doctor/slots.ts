/**
 * Slots-doctor checks (11 read-only diagnostics for the slots coordinator).
 *
 * All checks are pure over a DoctorEnv. None mutate state, none kill
 * processes, none touch ./releases/ or ./ops/ (those belong to the
 * releases doctor). Each check should complete in well under a second so
 * the full suite stays under the 15-second target.
 */

import type { DoctorCheck, DoctorEnv } from './types.ts';

// ---------------------------------------------------------------------------
// 1. tmux-rename-loop process
// ---------------------------------------------------------------------------

export const checkRenameLoop: DoctorCheck = {
  id: 'rename-loop',
  label: 'rename-loop',
  async run(env) {
    const r = env.exec('pgrep', ['-fa', 'tmux-rename-loop.sh']);
    if (r.notFound) {
      return { status: 'skipped', summary: 'pgrep not available' };
    }
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes('agent-workspace.ts'));
    if (lines.length === 0) {
      return {
        status: 'warn',
        summary: 'not running',
        action: 'Re-run /agent-slots-start to relaunch the rename loop.',
      };
    }
    if (lines.length > 1) {
      const pids = lines.map((l) => l.split(/\s+/)[0]).join(', ');
      return {
        status: 'warn',
        summary: `${lines.length} processes (PIDs ${pids})`,
        detail: lines.join('\n'),
        action: 'Multiple rename-loop processes — surface PIDs to user before killing.',
      };
    }
    const pid = lines[0].split(/\s+/)[0];
    return { status: 'ok', summary: `1 process (PID ${pid})` };
  },
};

// ---------------------------------------------------------------------------
// 2. PR patrol process — informational only
// ---------------------------------------------------------------------------

export const checkPrPatrol: DoctorCheck = {
  id: 'pr-patrol',
  label: 'pr-patrol',
  async run(env) {
    const r = env.exec('pgrep', ['-fa', 'pr-patrol']);
    if (r.notFound) return { status: 'skipped', summary: 'pgrep not available' };
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes('agent-workspace.ts'));
    if (lines.length === 0) return { status: 'info', summary: 'not running (informational)' };
    return { status: 'info', summary: `${lines.length} process(es) running` };
  },
};

// ---------------------------------------------------------------------------
// 3. rename-log freshness
// ---------------------------------------------------------------------------

export const checkRenameLogAge: DoctorCheck = {
  id: 'rename-log-age',
  label: 'rename-log-age',
  async run(env) {
    // Per red team #8: glob log files, pick newest
    const candidates = env.listDir('/tmp')
      .filter((n) => n.startsWith('lw-fix-tabs.log'))
      .map((n) => `/tmp/${n}`);
    if (candidates.length === 0) {
      return { status: 'info', summary: 'no log file (loop may not have run yet)' };
    }
    let newest: { path: string; mtime: number } | null = null;
    for (const p of candidates) {
      const st = env.stat(p);
      if (!st) continue;
      if (!newest || st.mtime > newest.mtime) newest = { path: p, mtime: st.mtime };
    }
    if (!newest) return { status: 'info', summary: 'no readable log file' };

    const ageSec = Math.floor(env.now().getTime() / 1000) - newest.mtime;
    const ageStr = ageSec < 120 ? `${ageSec}s` : `${Math.round(ageSec / 60)}min`;

    const content = env.readFile(newest.path) ?? '';
    const errLines = content
      .split('\n')
      .filter((l) => /\b(error|fail|failed|panic)\b/i.test(l))
      .slice(-3);

    if (ageSec > 15 * 60) {
      return {
        status: 'warn',
        summary: `last activity ${ageStr} ago (rename loop may be stalled)`,
        detail: errLines.length > 0 ? errLines.join('\n') : undefined,
        action: `tail ${newest.path}`,
      };
    }
    if (errLines.length > 0) {
      return {
        status: 'warn',
        summary: `last activity ${ageStr} ago, ${errLines.length} recent error line(s)`,
        detail: errLines.join('\n'),
        action: `tail ${newest.path}`,
      };
    }
    return { status: 'ok', summary: `last activity ${ageStr} ago, no errors` };
  },
};

// ---------------------------------------------------------------------------
// 4. .env drift across slots
// ---------------------------------------------------------------------------

export const checkEnvDrift: DoctorCheck = {
  id: 'env-drift',
  label: 'env-drift',
  async run(env) {
    const basePath = env.resolve('.env.base');
    const baseStat = env.stat(basePath);
    if (!baseStat) {
      return {
        status: 'skipped',
        summary: '.env.base missing — cannot compare slot envs',
      };
    }
    const slots = listSlotDirs(env);
    if (slots.length === 0) return { status: 'info', summary: 'no slots configured' };

    const issues: string[] = [];
    for (const slot of slots) {
      const envPath = `${slot.path}/.env`;
      const st = env.stat(envPath);
      if (!st) {
        issues.push(`${slot.name}/.env missing`);
        continue;
      }
      if (st.isSymlink) {
        issues.push(`${slot.name}/.env is a symlink (slots use regular files)`);
        continue;
      }
      if (st.mtime < baseStat.mtime) {
        const ageDays = Math.floor((baseStat.mtime - st.mtime) / 86400);
        issues.push(`${slot.name}/.env stale (mtime ${ageDays}d < .env.base)`);
      }
    }

    if (issues.length === 0) return { status: 'ok', summary: `${slots.length}/${slots.length} slots in sync` };
    return {
      status: 'warn',
      summary: `${issues.length} drift issue(s)`,
      detail: issues.join('\n'),
      action: 'Run ./ws sync-env to refresh slot .env files; surface symlinked slots to user.',
    };
  },
};

// ---------------------------------------------------------------------------
// 5. .agent-slot marker matches slot number
// ---------------------------------------------------------------------------

export const checkAgentSlotMarker: DoctorCheck = {
  id: 'agent-slot-marker',
  label: 'agent-slot-marker',
  async run(env) {
    const slots = listSlotDirs(env);
    if (slots.length === 0) return { status: 'info', summary: 'no slots configured' };

    const mismatches: string[] = [];
    for (const slot of slots) {
      const markerPath = `${slot.path}/.agent-slot`;
      const content = env.readFile(markerPath);
      if (content == null) {
        mismatches.push(`${slot.name}: .agent-slot missing`);
        continue;
      }
      const trimmed = content.trim();
      if (trimmed !== String(slot.number)) {
        mismatches.push(`${slot.name}: .agent-slot=${trimmed} (expected ${slot.number})`);
      }
    }
    if (mismatches.length === 0) {
      return { status: 'ok', summary: `${slots.length}/${slots.length} slots correct` };
    }
    return {
      status: 'warn',
      summary: `${mismatches.length} mismatch(es)`,
      detail: mismatches.join('\n'),
      action: 'Slot identity drift — surface to user; ./ws reset <N> may help.',
    };
  },
};

// ---------------------------------------------------------------------------
// 6. merged-PR slots with uncommitted changes
// ---------------------------------------------------------------------------

export const checkMergedDirty: DoctorCheck = {
  id: 'merged-dirty',
  label: 'merged-dirty',
  async run(env) {
    const slots = listSlotDirs(env);
    if (slots.length === 0) return { status: 'info', summary: 'no slots configured' };

    const dirty: string[] = [];
    for (const slot of slots) {
      const branchR = env.exec('git', ['-C', slot.path, 'branch', '--show-current'], { timeoutMs: 3000 });
      if (branchR.code !== 0) continue;
      const branch = branchR.stdout.trim();
      // We can't tell "merged PR" without a network call; proxy is "branch != main and dirty".
      if (branch === 'main' || branch === '') continue;
      const statusR = env.exec('git', ['-C', slot.path, 'status', '--porcelain'], { timeoutMs: 3000 });
      if (statusR.code !== 0) continue;
      const isDirty = statusR.stdout.trim().length > 0;
      // Check whether this branch has been merged into origin/main
      const mergedR = env.exec('git', ['-C', slot.path, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { timeoutMs: 3000 });
      const merged = mergedR.code === 0;
      if (merged && isDirty) dirty.push(`${slot.name} (${branch})`);
    }
    if (dirty.length === 0) return { status: 'ok', summary: 'no merged-but-dirty slots' };
    return {
      status: 'warn',
      summary: `${dirty.length} slot(s) with uncommitted work on merged branches`,
      detail: dirty.join('\n'),
      action: 'Open each slot — uncommitted work would be lost on ./ws refresh. Ask user.',
    };
  },
};

// ---------------------------------------------------------------------------
// 7. mid-rebase detection
// ---------------------------------------------------------------------------

export const checkMidRebase: DoctorCheck = {
  id: 'mid-rebase',
  label: 'mid-rebase',
  async run(env) {
    const slots = listSlotDirs(env);
    if (slots.length === 0) return { status: 'info', summary: 'no slots configured' };

    const rebasing: string[] = [];
    for (const slot of slots) {
      const a = env.stat(`${slot.path}/.git/rebase-merge`);
      const b = env.stat(`${slot.path}/.git/rebase-apply`);
      const c = env.stat(`${slot.path}/.git/CHERRY_PICK_HEAD`);
      const d = env.stat(`${slot.path}/.git/MERGE_HEAD`);
      if (a || b || c || d) rebasing.push(slot.name);
    }
    if (rebasing.length === 0) return { status: 'ok', summary: 'no in-progress rebases' };
    return {
      status: 'fail',
      summary: `${rebasing.length} slot(s) with in-progress rebase/merge/cherry-pick`,
      detail: rebasing.join('\n'),
      action: 'Do NOT run ./ws refresh. Abort or finish the rebase first.',
    };
  },
};

// ---------------------------------------------------------------------------
// 8. dev-server inventory (NEVER auto-act)
// ---------------------------------------------------------------------------

export const checkDevServerInventory: DoctorCheck = {
  id: 'dev-server-inventory',
  label: 'dev-server-inventory',
  async run(env) {
    const r = env.exec('lsof', ['-iTCP:3010-3030', '-sTCP:LISTEN', '-P', '-n'], { timeoutMs: 5000 });
    if (r.notFound) return { status: 'skipped', summary: 'lsof not available' };
    if (r.code !== 0) return { status: 'info', summary: 'no listeners on 3010-3030' };
    // Parse lsof output: lines look like "next 12345 user  21u  IPv4 ..."
    const lines = r.stdout.split('\n').filter((l, i) => i > 0 && l.trim().length > 0);
    if (lines.length === 0) return { status: 'info', summary: 'no listeners on 3010-3030' };
    const summary: string[] = [];
    for (const l of lines) {
      const cols = l.split(/\s+/);
      const name = cols[0];
      const pid = cols[1];
      const portMatch = l.match(/:(\d+)\s/);
      if (!portMatch) continue;
      summary.push(`port ${portMatch[1]}: ${name} (PID ${pid})`);
    }
    return {
      status: 'info',
      summary: `${summary.length} dev server(s) listening (NEVER auto-kill — could hit user's main on 3001)`,
      detail: summary.join('\n'),
    };
  },
};

// ---------------------------------------------------------------------------
// 9. tmux windows match real slots
// ---------------------------------------------------------------------------

export const checkTmuxNamedWindows: DoctorCheck = {
  id: 'tmux-named-windows',
  label: 'tmux-named-windows',
  async run(env) {
    if (!env.env.TMUX) return { status: 'skipped', summary: 'not in tmux' };
    const r = env.exec('tmux', ['list-windows', '-a', '-F', '#{window_name}'], { timeoutMs: 3000 });
    if (r.code !== 0) return { status: 'skipped', summary: 'tmux list-windows failed' };
    const slotPattern = /^[Aa](\d+)/;
    const slotWindows = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => slotPattern.test(l));
    const realSlots = new Set(listSlotDirs(env).map((s) => s.number));

    const orphans: string[] = [];
    for (const w of slotWindows) {
      const m = w.match(slotPattern);
      if (!m) continue;
      if (!realSlots.has(Number(m[1]))) orphans.push(w);
    }
    if (orphans.length === 0) {
      return { status: 'ok', summary: `${slotWindows.length} slot-named windows, all match` };
    }
    return {
      status: 'warn',
      summary: `${orphans.length} orphan window(s)`,
      detail: orphans.join('\n'),
      action: './ws fix-tabs to resync window names.',
    };
  },
};

// ---------------------------------------------------------------------------
// 10. disk space
// ---------------------------------------------------------------------------

export const checkDiskSpace: DoctorCheck = {
  id: 'disk-space',
  label: 'disk-space',
  async run(env) {
    const r = env.exec('df', ['-k', env.lwDir], { timeoutMs: 3000 });
    if (r.code !== 0 || r.notFound) return { status: 'skipped', summary: 'df not available' };
    const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < 2) return { status: 'skipped', summary: 'df output unparseable' };
    const cols = lines[1].split(/\s+/);
    // POSIX df -k: Filesystem 1K-blocks Used Avail Capacity Mounted
    const total = Number(cols[1]);
    const avail = Number(cols[3]);
    const device = cols[0];
    if (!Number.isFinite(total) || !Number.isFinite(avail)) {
      return { status: 'skipped', summary: 'df output unparseable' };
    }
    const availGB = avail / 1024 / 1024;
    const pct = (avail / total) * 100;
    const summary = `${availGB.toFixed(0)}G free (${pct.toFixed(0)}% of ${(total / 1024 / 1024).toFixed(0)}G, ${device})`;
    if (availGB < 5 || pct < 10) {
      return {
        status: 'warn',
        summary,
        action: 'Free space before next ./ws refresh.',
      };
    }
    return { status: 'ok', summary };
  },
};

// ---------------------------------------------------------------------------
// 11. hung wiki-server processes inside slot dirs
// ---------------------------------------------------------------------------

export const checkHungWikiServer: DoctorCheck = {
  id: 'hung-wiki-server',
  label: 'hung-wiki-server',
  async run(env) {
    const r = env.exec('pgrep', ['-fa', 'wiki-server'], { timeoutMs: 3000 });
    if (r.notFound) return { status: 'skipped', summary: 'pgrep not available' };
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Match on a trailing `/` so `/lw/a1` doesn't accidentally match
    // `/lw/a10` via prefix substring. Must look for `<path>/` inside the
    // command line or `<path>` at end-of-string (less common but safe).
    const slotPaths = listSlotDirs(env).map((s) => s.path);
    const hung = lines.filter((l) =>
      slotPaths.some((p) => l.includes(`${p}/`) || l.endsWith(p)),
    );
    if (hung.length === 0) return { status: 'ok', summary: 'none in slot dirs' };
    return {
      status: 'warn',
      summary: `${hung.length} wiki-server process(es) in slot dirs`,
      detail: hung.join('\n'),
      action: 'Slots should use prod wiki-server, not local. Ask user before killing.',
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SlotDir {
  name: string;
  number: number;
  path: string;
}

/** List `aN` directories under lwDir. */
function listSlotDirs(env: DoctorEnv): SlotDir[] {
  const entries = env.listDir(env.lwDir);
  const slots: SlotDir[] = [];
  for (const name of entries) {
    const m = name.match(/^a(\d+)$/);
    if (!m) continue;
    const path = env.resolve(name);
    const st = env.stat(path);
    if (!st || !st.isDir) continue;
    slots.push({ name, number: Number(m[1]), path });
  }
  return slots.sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SLOTS_CHECKS: DoctorCheck[] = [
  checkRenameLoop,
  checkPrPatrol,
  checkRenameLogAge,
  checkEnvDrift,
  checkAgentSlotMarker,
  checkMergedDirty,
  checkMidRebase,
  checkDevServerInventory,
  checkTmuxNamedWindows,
  checkDiskSpace,
  checkHungWikiServer,
];
