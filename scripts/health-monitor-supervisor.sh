#!/usr/bin/env bash
#
# health-monitor-supervisor.sh
#
# Daemon loop launched by the com.qu.health-monitor launchd agent.
# Runs `pnpm crux sys health-monitor run` continuously, restarting it
# 30s after each exit so a crash, network blip, or `crux ... once`
# is followed by automatic recovery.
#
# Why an inner loop *and* launchd KeepAlive: launchd respawns the
# supervisor itself on crash, but a clean exit of `health-monitor run`
# (e.g. EEXIST on daemon.pid because another monitor still holds the
# lock) shouldn't cycle launchd — the inner sleep keeps diagnostic
# output contiguous in run.log instead of fragmenting into launchd.err.
#
# Watch the live log:
#   tail -f ~/.cache/health-monitor/run.log
#
# Install/uninstall: ./launchd/health-monitor.sh {install|uninstall|status}
#
# Mirrors the structure of pr-patrol-supervisor.sh — see QUA-987 for
# the original launchd-supervisor design and QUA-1048 for this monitor.

set -uo pipefail

# ── User identity ────────────────────────────────────────────────────────────
# launchd LaunchAgents do NOT inherit USER/LOGNAME. Without these the macOS
# keychain lookup that `claude` uses for OAuth returns "Not logged in".
# Health-monitor doesn't currently spawn `claude`, but match pr-patrol's
# pattern so the supervisor template stays consistent.
export USER="${USER:-$(id -un)}"
export LOGNAME="${LOGNAME:-$USER}"

# ── PATH setup ────────────────────────────────────────────────────────────────
# launchd starts agents with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
# Source nvm so `pnpm`, `node`, and `tsx` resolve, then prepend homebrew/system
# so `gh`, `git`, etc. are findable too.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" --no-use 2>/dev/null || true
  nvm use --silent default >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
  fallback_bin=$(/bin/ls -d "$NVM_DIR/versions/node/"v*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$fallback_bin" ] && export PATH="$fallback_bin:${PATH:-}"
fi
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

WIKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$HOME/.cache/health-monitor"
LOG="$CACHE_DIR/run.log"
LOG_MAX_BYTES=$((20 * 1024 * 1024))   # 20 MB before rotation
mkdir -p "$CACHE_DIR"

# Bash builtin %(...)T avoids forking a date subshell per log line.
ts() { printf '%(%Y-%m-%d %H:%M:%S)T' -1; }

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

# ── Wiki-server target ───────────────────────────────────────────────────────
# The monitor's job is to watch *production* — main/ is not inside an a<N>
# slot, so the auto-detect in client.ts won't pick PROD. Force prod here so
# /health requests don't go to a non-existent local server.
export WIKI_SERVER_ENV="${WIKI_SERVER_ENV:-prod}"

# ── Signal handling ──────────────────────────────────────────────────────────
# When launchd sends SIGTERM (`launchctl unload` or shutdown), kill the
# child process group and exit cleanly. `set -m` puts each `&`-spawned
# child in its own pgid; signalling -PGID reaches the node grandchild too.
set -m

monitor_pid=""
shutdown() {
  if [ -n "$monitor_pid" ] && kill -0 "$monitor_pid" 2>/dev/null; then
    printf '%s ── supervisor received signal — terminating child pgid=%d ──\n' \
      "$(ts)" "$monitor_pid" >> "$LOG"
    kill -TERM -- "-$monitor_pid" 2>/dev/null || kill -TERM "$monitor_pid" 2>/dev/null || true
    wait "$monitor_pid" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

printf '%s ── supervisor starting (pid=%d, wiki=%s) ──\n' \
  "$(ts)" "$$" "$WIKI_ROOT" >> "$LOG"

# Backgrounded sleep + wait so SIGTERM fires promptly during the inter-cycle
# pause (bare `sleep N` defers traps until the external sleep returns).
sleep_interruptible() {
  sleep "$1" &
  monitor_pid=$!
  wait "$monitor_pid" 2>/dev/null || true
  monitor_pid=""
}

while true; do
  maybe_rotate_log

  printf '%s ── health-monitor starting ──\n' "$(ts)" >> "$LOG"
  pnpm crux sys health-monitor run >> "$LOG" 2>&1 &
  monitor_pid=$!
  wait "$monitor_pid"
  ec=$?
  monitor_pid=""
  printf '%s ── health-monitor exited code=%d, sleeping 30s ──\n' "$(ts)" "$ec" >> "$LOG"
  sleep_interruptible 30
done
