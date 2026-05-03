#!/usr/bin/env bash
#
# UserPromptSubmit hook — surfaces health-monitor alerts and a dead daemon
# to the coordinator on every turn. Silent no-op when the daemon is alive
# and no alerts are active. Mirrors inject-patrol-status.sh.
#
# Wire into a coord session's `.claude/settings.local.json`:
#
#   "hooks": {
#     "UserPromptSubmit": [
#       { "command": "/abs/path/to/scripts/inject-health-status.sh" }
#     ]
#   }
#
# The "alert" files (~/.cache/health-monitor/state/alert-*) are written by
# `crux sys health-monitor` when a signal threshold is breached and removed
# automatically when the signal recovers. See QUA-1048.

set -uo pipefail

CACHE_DIR="$HOME/.cache/health-monitor"
STATE_DIR="$CACHE_DIR/state"

# ─── Daemon liveness ──────────────────────────────────────────────────────────
# Match either the daemon process itself (`crux sys health-monitor run` /
# pnpm parent) or the launchd supervisor in its 30s sleep window. Without
# the supervisor case we'd false-alarm every 30s during the launchd-managed
# restart cadence. Single pgrep with alternation = one process-table walk
# per user prompt. Pattern kept in sync with health-monitor.sh.
monitor_pid=$(pgrep -f 'sys health-monitor run|health-monitor-supervisor\.sh' 2>/dev/null | head -1)

# ─── Active alert collection ─────────────────────────────────────────────────
# Glob with nullglob — fewer forks than `ls | grep | sed | tr` and no
# ls-output parsing. Each filename is `alert-<signal-id>`.
active_alerts=""
shopt -s nullglob
for f in "$STATE_DIR"/alert-*; do
  name="${f##*/alert-}"
  active_alerts="$active_alerts $name"
done
shopt -u nullglob
active_alerts="${active_alerts# }"

# Fast exit: nothing to report
if [ -z "$active_alerts" ] && [ -n "$monitor_pid" ]; then
  exit 0
fi

# ─── Resolve the installer path from this script's location ──────────────────
# When deployed from a wiki clone, this script is at
# <wiki>/scripts/inject-health-status.sh and the installer is at
# <wiki>/scripts/launchd/health-monitor.sh — siblings under scripts/.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$HOOK_DIR/launchd/health-monitor.sh"

echo "<system-reminder>"

if [ -z "$monitor_pid" ]; then
  echo "⚠ Coordinator health-monitor is NOT running."
  if launchctl list 2>/dev/null | grep -q com.qu.health-monitor; then
    echo "  launchd lists com.qu.health-monitor but no daemon/supervisor process found —"
    echo "  check ~/.cache/health-monitor/launchd.err and ~/.cache/health-monitor/run.log."
    echo "  Status: $INSTALLER status"
  else
    echo "  No launchd agent installed. Install:"
    echo "    $INSTALLER install"
  fi
  echo ""
fi

if [ -n "$active_alerts" ]; then
  for sig in $active_alerts; do
    case "$sig" in
      ci-stale)
        echo "⚠ ci-stale: main-branch CI hasn't been green for over the configured threshold."
        echo "  Likely cause: stuck main, broken deploy gate, or a regression nobody noticed."
        ;;
      jobs-stuck)
        echo "⚠ jobs-stuck: wiki-server pendingJobs queue is not draining."
        echo "  Likely cause: stuck DB, dead worker loop, or a slow job blocking the queue."
        ;;
      *)
        echo "⚠ $sig: health-monitor reports an active alert."
        ;;
    esac
    body=""
    [ -f "$STATE_DIR/alert-$sig" ] && body=$(cat "$STATE_DIR/alert-$sig" 2>/dev/null || echo "")
    if [ -n "$body" ]; then
      # Indent for readability
      printf '%s\n' "$body" | sed 's/^/    /'
    fi
    echo ""
  done
  echo "Surfaced by health-monitor (QUA-1048). To clear an alert manually:"
  echo "  rm $STATE_DIR/alert-<signal>"
fi

echo "</system-reminder>"
