# launchd LaunchAgents (macOS)

Background daemons for the longterm-wiki coordinator workflow, packaged as
[launchd LaunchAgents](https://www.launchd.info/) so they survive logout,
reboot, and process crashes — replacing the older "remember to start a tmux
window after login" pattern.

## Agents

| Label | Plist | Purpose | Linear |
|---|---|---|---|
| `com.qu.pr-patrol` | `com.qu.pr-patrol.plist` | Keeps `crux gh pr-patrol run` alive — auto-restarts on crash, on logout/login cycle, and after reboot | QUA-987 |

The supervisor scripts the agents launch are siblings of this directory:

- `../pr-patrol-supervisor.sh` — runs `pnpm crux gh pr-patrol run` in a 30-second restart loop, with shutdown on `SIGTERM`/`SIGINT` so `launchctl unload` is a graceful stop.

## Install / status / uninstall

```bash
# From a wiki clone (e.g. lw/main/):
./scripts/launchd/pr-patrol.sh install     # render plist, copy to ~/Library/LaunchAgents/, load
./scripts/launchd/pr-patrol.sh status      # launchctl state + actual patrol process + run.log freshness
./scripts/launchd/pr-patrol.sh tail        # tail the run log
./scripts/launchd/pr-patrol.sh tcc-check   # probe macOS Full Disk Access (see below)
./scripts/launchd/pr-patrol.sh uninstall   # unload + remove
```

The install script is **idempotent** — re-running is safe. It also reports if
an existing tmux-based patrol is currently holding `~/.cache/pr-patrol/daemon.pid`
(patrol's built-in singleton), in which case the launchd supervisor will retry
every 30s until the existing patrol exits.

**Where things land:**

```
~/Library/LaunchAgents/com.qu.pr-patrol.plist          # rendered with absolute paths
~/.cache/pr-patrol/run.log                             # supervisor's log (tail this)
~/.cache/pr-patrol/launchd.{out,err}                   # launchd's own captured output
~/.cache/pr-patrol/daemon.pid                          # patrol's singleton lock
```

## One-time macOS Full Disk Access grant

**Required if the wiki clone lives under `~/Documents/`** (the default Apple
location for a checkout). Modern macOS blocks launchd-spawned processes from
reading anything under `~/Documents/` unless the user explicitly grants Full
Disk Access in System Settings — agents loaded into launchd's Aqua context do
not inherit the TCC profile of Terminal/iTerm.

**Symptom without FDA:** `launchctl list com.qu.pr-patrol` shows
`last_exit=126` ("Operation not permitted") and patrol never runs. The install
script's TCC self-test catches this and prints clear next steps.

**To grant:**

1. **System Settings → Privacy & Security → Full Disk Access**
2. Click **＋**, press **⌘-Shift-G**, type `/bin`, and select `bash`. The plist invokes `/bin/bash` explicitly (see [QUA-1004](https://linear.app/quantifieduncertainty/issue/QUA-1004)) so this single grant is what the supervisor needs.
3. Toggle the new entry **ON**.
4. Re-run `./pr-patrol.sh install` (or `./pr-patrol.sh tcc-check` to verify).

> **Why not grant FDA to the supervisor script directly?** macOS's FDA picker filters out shell scripts (only Mach-O binaries are selectable). Drag-and-drop sometimes adds them to the list, but TCC attributes shell-script execution to the interpreter, not the script path — so the grant has no effect on the launchd-spawned supervisor.

The same grant retroactively fixes any other `~/Library/LaunchAgents/com.qu.*.plist`
that touches `~/Documents/` (e.g., `com.qu.lw-fix-tabs.plist`).

## Why launchd instead of cron / tmux

| Mechanism | Survives logout? | Survives reboot? | Survives crash? | Live log? |
|---|---|---|---|---|
| Manual `tmux new-window …` | ✓ (tmux server) | ✗ (manual restart) | ✗ (no auto-restart) | ✓ |
| `cron` / `launchd StartInterval` | ✓ | ✓ | ✓ (next tick) | partial |
| **launchd `KeepAlive=true`** | ✓ | ✓ | ✓ (immediate via throttle) | via `tail -f run.log` |

`KeepAlive=true` plus the supervisor's inner `while true; do … sleep 30; done`
gives two layers of recovery: the inner loop handles clean exits without
churning launchd, and `KeepAlive` handles unexpected supervisor death.

## Coexistence with the legacy tmux pattern

Patrol's built-in `daemon.pid` singleton (see
`crux/pr-patrol/index.ts::acquirePidFile`) ensures only one patrol process
runs at a time. If both the launchd supervisor and a stray
`tmux new-window … pr-patrol run` are active, only the first to acquire
`daemon.pid` does the work; the other exits with code 1 and retries 30s later.
This makes the migration safe — the launchd agent can be installed before
shutting down an existing tmux patrol.

The supervisor also pre-checks `daemon.pid` before invoking patrol, so the
"another daemon is running" diagnostic doesn't spam `run.log` during the
transition window.
