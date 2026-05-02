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

# ── User identity ────────────────────────────────────────────────────────────
# launchd LaunchAgents do NOT inherit USER/LOGNAME from the user's shell, and
# without these the macOS keychain lookup that claude uses for its OAuth
# subscription returns "Not logged in" — patrol would silently fall back to
# whatever ANTHROPIC_API_KEY is in the env (API billing) or fail outright.
# Derive both from `id -un` so they match the launchd asid (gui/501) the
# agent runs under.
export USER="${USER:-$(id -un)}"
export LOGNAME="${LOGNAME:-$USER}"

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

# ~/.local/bin: Claude Code's CLI installer puts `claude` here. Without this
# entry, patrol's `spawn claude ENOENT` errors on the very first fix attempt
# even though the supervisor itself runs cleanly. Other tools that npm-install
# globally land in homebrew/usr-local, which is already covered.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# Patrol creates worktrees under .claude/worktrees/, so the supervisor must
# run from a wiki clone (typically lw/main/), not from coord/ or a slot.
WIKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$HOME/.cache/pr-patrol"
LOG="$CACHE_DIR/run.log"
PIDFILE="$CACHE_DIR/daemon.pid"
LOG_MAX_BYTES=$((50 * 1024 * 1024))  # 50 MB before rotating to .log.1
mkdir -p "$CACHE_DIR"

# Bash builtin %(...)T format avoids forking a `date` subshell per log line.
# At ~30s cadence the supervisor logs hundreds of lines per hour; replacing
# the subshell saves ~240 forks/hour at idle.
ts() { printf '%(%Y-%m-%d %H:%M:%S)T' -1; }

# Rotate run.log when it exceeds LOG_MAX_BYTES so an unattended supervisor
# doesn't grow the log unbounded over weeks/months.
maybe_rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(/usr/bin/stat -f %z "$LOG" 2>/dev/null) || return 0
  if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
    /bin/mv "$LOG" "$LOG.1" 2>/dev/null || true
  fi
}

cd "$WIKI_ROOT" || {
  printf '%s ERROR: cannot cd to %s — exiting (launchd will throttle and retry)\n' \
    "$(ts)" "$WIKI_ROOT" >> "$LOG"
  exit 1
}

# When launchd sends SIGTERM (`launchctl unload` or shutdown), kill the patrol
# process group and exit cleanly. `set -m` puts each `&`-spawned child in its
# own process group; signalling -PGID reaches pnpm's node grandchild too,
# whose signal forwarding from pnpm is not guaranteed.
set -m

patrol_pid=""
shutdown() {
  if [ -n "$patrol_pid" ] && kill -0 "$patrol_pid" 2>/dev/null; then
    printf '%s ── supervisor received signal — terminating child pgid=%d ──\n' \
      "$(ts)" "$patrol_pid" >> "$LOG"
    kill -TERM -- "-$patrol_pid" 2>/dev/null || kill -TERM "$patrol_pid" 2>/dev/null || true
    wait "$patrol_pid" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

printf '%s ── supervisor starting (pid=%d, wiki=%s) ──\n' \
  "$(ts)" "$$" "$WIKI_ROOT" >> "$LOG"

# `wait` is interruptible by signals; bare `sleep N` is not (bash defers the
# trap until the external sleep returns), so backgrounding sleep + wait lets
# SIGTERM fire promptly during the inter-cycle pause. We share `patrol_pid`
# with the foreground patrol invocation deliberately — `set -m` gives each
# backgrounded child its own pgid, so `kill -- -patrol_pid` works for the
# sleep child too (a no-op if sleep already finished).
sleep_interruptible() {
  sleep "$1" &
  patrol_pid=$!
  wait "$patrol_pid" 2>/dev/null || true
  patrol_pid=""
}

while true; do
  maybe_rotate_log

  # Skip the launch if another live patrol holds daemon.pid (e.g. a stray
  # tmux-based patrol from before the launchd migration) — patrol's own
  # EEXIST handling is the backstop, but pre-checking keeps the launch
  # error out of run.log during the migration window.
  if [ -f "$PIDFILE" ]; then
    other=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$other" ] && [ "$other" != "$$" ] && kill -0 "$other" 2>/dev/null; then
      printf '%s ── another patrol pid=%s holds daemon.pid, sleeping 30s ──\n' \
        "$(ts)" "$other" >> "$LOG"
      sleep_interruptible 30
      continue
    fi
  fi

  printf '%s ── pr-patrol starting ──\n' "$(ts)" >> "$LOG"
  pnpm crux gh pr-patrol run >> "$LOG" 2>&1 &
  patrol_pid=$!
  wait "$patrol_pid"
  ec=$?
  patrol_pid=""
  printf '%s ── pr-patrol exited code=%d, sleeping 30s ──\n' "$(ts)" "$ec" >> "$LOG"
  sleep_interruptible 30
done
