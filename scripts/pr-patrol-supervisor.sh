#!/usr/bin/env bash
#
# pr-patrol-supervisor.sh
#
# Daemon loop launched by the com.qu.pr-patrol launchd agent.
# Runs `pnpm crux gh pr-patrol run` continuously, restarting it 30s
# after each exit so a crash, network blip, or `crux pr-patrol stop`
# is followed by automatic recovery.
#
# Why an inner loop *and* launchd KeepAlive: launchd respawns the
# supervisor itself if it crashes, but a clean exit of `pr-patrol run`
# (e.g. EEXIST on daemon.pid because an old tmux-based patrol still
# owns the lock) shouldn't cycle launchd — the inner sleep keeps
# diagnostic output contiguous in run.log instead of fragmenting it
# into launchd.err.
#
# Watch the live log:
#   tail -f ~/.cache/pr-patrol/run.log
#
# Install/uninstall: ./launchd/pr-patrol.sh {install|uninstall|status}

set -uo pipefail

# ── PATH setup ────────────────────────────────────────────────────────────────
# launchd starts agents with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
# Source nvm so `pnpm`, `node`, and `tsx` resolve, then prepend the standard
# homebrew + system paths so `gh`, `git`, `tmux`, etc. are findable too.

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use 2>/dev/null || true
  nvm use --silent default >/dev/null 2>&1 || true
fi

# Fallback: if nvm.sh didn't add a node bindir to PATH, pick the highest
# installed version directly. Keeps the supervisor working even if the user
# nukes nvm.sh but leaves the version dirs.
if ! command -v pnpm >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
  fallback_bin=$(/bin/ls -d "$NVM_DIR/versions/node/"v*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$fallback_bin" ] && export PATH="$fallback_bin:${PATH:-}"
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# ── Working directory + log ───────────────────────────────────────────────────
# This script lives at <wiki-clone>/scripts/pr-patrol-supervisor.sh, so the
# wiki clone is one directory up. Patrol creates worktrees under
# .claude/worktrees/, so it must run from a wiki clone (typically lw/main/),
# not from coord/ or a slot.
WIKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.cache/pr-patrol"
LOG="$LOG_DIR/run.log"
mkdir -p "$LOG_DIR"

cd "$WIKI_ROOT" || {
  printf '%s ERROR: cannot cd to %s — exiting (launchd will throttle and retry)\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$WIKI_ROOT" >> "$LOG"
  exit 1
}

# ── Shutdown handling ─────────────────────────────────────────────────────────
# When launchd sends SIGTERM (e.g. on `launchctl unload` or system shutdown),
# kill the patrol child and exit cleanly. Without this, the SIGTERM is delivered
# to bash but the patrol child keeps running until the OS kills it.

patrol_pid=""
shutdown() {
  if [ -n "$patrol_pid" ] && kill -0 "$patrol_pid" 2>/dev/null; then
    printf '%s ── supervisor received signal — terminating patrol pid=%d ──\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" "$patrol_pid" >> "$LOG"
    kill -TERM "$patrol_pid" 2>/dev/null || true
    wait "$patrol_pid" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

# ── Main loop ─────────────────────────────────────────────────────────────────
printf '%s ── supervisor starting (pid=%d, wiki=%s) ──\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$WIKI_ROOT" >> "$LOG"

PIDFILE="$HOME/.cache/pr-patrol/daemon.pid"

while true; do
  # Pre-check: if another live patrol owns daemon.pid (e.g. a stray tmux-based
  # patrol from before the launchd migration), skip the launch and try again
  # in 30s. This avoids spamming "Another PR patrol daemon is already running"
  # into run.log every cycle while the user finishes the migration. Patrol's
  # own EEXIST handling stays as the second line of defense.
  if [ -f "$PIDFILE" ]; then
    other=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$other" ] && [ "$other" != "$$" ] && kill -0 "$other" 2>/dev/null; then
      printf '%s ── another patrol pid=%s holds daemon.pid, sleeping 30s ──\n' \
        "$(date '+%Y-%m-%d %H:%M:%S')" "$other" >> "$LOG"
      sleep 30
      continue
    fi
  fi

  printf '%s ── pr-patrol starting ──\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
  pnpm crux gh pr-patrol run >> "$LOG" 2>&1 &
  patrol_pid=$!
  wait "$patrol_pid"
  ec=$?
  patrol_pid=""
  printf '%s ── pr-patrol exited code=%d, sleeping 30s ──\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$ec" >> "$LOG"
  sleep 30
done
