#!/usr/bin/env bash
#
# pr-patrol.sh — install / uninstall / status for the pr-patrol launchd agent.
#
# Usage:
#   ./pr-patrol.sh            # install (idempotent — re-running is safe)
#   ./pr-patrol.sh install    # same as no-arg
#   ./pr-patrol.sh uninstall  # unload + remove from ~/Library/LaunchAgents
#   ./pr-patrol.sh status     # show launchd state + actual patrol process
#   ./pr-patrol.sh tail       # tail the run log (Ctrl-C to exit)
#
# This wraps the patrol daemon with a launchd LaunchAgent so it survives
# logout, reboot, and process crashes — the previous tmux-window pattern only
# survives if the user happens to be at their machine when it dies.
#
# See QUA-987.

set -euo pipefail

# This script lives at <wiki-clone>/scripts/launchd/pr-patrol.sh, so the wiki
# clone is two directories up.
WIKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_SRC="$WIKI_ROOT/scripts/launchd/com.qu.pr-patrol.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.qu.pr-patrol.plist"
LABEL="com.qu.pr-patrol"
SUPERVISOR="$WIKI_ROOT/scripts/pr-patrol-supervisor.sh"
LOG="$HOME/.cache/pr-patrol/run.log"

cmd="${1:-install}"

# ── TCC self-test ─────────────────────────────────────────────────────────────
# Modern macOS (Sequoia, Sonoma, Ventura) blocks launchd-spawned processes from
# reading anything under ~/Documents/ unless the user grants Full Disk Access
# (or Files & Folders → Documents) in System Settings. Without it, launchd
# loads our agent but the supervisor exits 126 ("Operation not permitted")
# every cycle, and patrol never runs. Probe via a one-shot test plist, parse
# the result, return 0 if Documents is reachable from launchd, 1 if blocked.
tcc_self_test() {
  local probe_label="com.qu.pr-patrol-tccprobe"
  local probe_plist="$HOME/Library/LaunchAgents/$probe_label.plist"
  local probe_out="/tmp/$probe_label.out"
  local probe_err="/tmp/$probe_label.err"
  local probe_target="$WIKI_ROOT/.git/HEAD"

  /bin/rm -f "$probe_out" "$probe_err"
  cat > "$probe_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$probe_label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cat "$probe_target" > "$probe_out" 2> "$probe_err"</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

  launchctl unload "$probe_plist" 2>/dev/null || true
  launchctl load "$probe_plist"
  # Plist is one-shot — wait briefly for it to run.
  for _ in 1 2 3 4 5 6; do
    [ -s "$probe_out" ] && break
    [ -s "$probe_err" ] && break
    sleep 0.5
  done
  launchctl unload "$probe_plist" 2>/dev/null || true
  /bin/rm -f "$probe_plist"

  local result=1
  if [ -s "$probe_out" ]; then
    result=0
  fi
  /bin/rm -f "$probe_out" "$probe_err"
  return $result
}

print_tcc_help() {
  cat <<EOM

⚠ launchd cannot read files under ~/Documents/ — Full Disk Access is required.

  This is a macOS TCC restriction: agents loaded into launchd's Aqua context
  do not inherit the TCC profile of Terminal/iTerm, so they cannot reach the
  wiki clone if it lives anywhere under ~/Documents/.

  To grant access (one-time per machine):
    1. Open  System Settings → Privacy & Security → Full Disk Access
    2. Click  ＋  and add  /bin/bash  (Cmd-Shift-G to type the path)
       — or, more narrowly, add the supervisor script:
       $SUPERVISOR
    3. Toggle the new entry ON.
    4. Re-run:  ./pr-patrol.sh install

  The same grant fixes ~/Library/LaunchAgents/com.qu.lw-fix-tabs.plist if you
  also rely on it for tmux-window renaming.

  Until FDA is granted, fall back to the legacy tmux loop:
    tmux new-window -t 0: -n PATROL -d 'while true; do pnpm crux gh pr-patrol run; sleep 30; done 2>&1 | tee -a ~/.cache/pr-patrol/run.log'
EOM
}

case "$cmd" in
  install)
    [ -f "$PLIST_SRC" ] || { echo "✗ Missing template: $PLIST_SRC" >&2; exit 1; }
    [ -f "$SUPERVISOR" ] || { echo "✗ Missing supervisor: $SUPERVISOR" >&2; exit 1; }

    chmod +x "$SUPERVISOR"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.cache/pr-patrol"

    # Render the plist with absolute paths resolved.
    # sed delimiter is | so that paths containing / are safe.
    sed \
      -e "s|__SUPERVISOR__|$SUPERVISOR|g" \
      -e "s|__HOME__|$HOME|g" \
      "$PLIST_SRC" > "$PLIST_DST"

    # Reload — works whether or not previously loaded. `launchctl load` is the
    # legacy form; it still works for ~/Library/LaunchAgents on Sequoia and
    # matches the existing com.qu.lw-fix-tabs.plist pattern.
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"

    echo "✓ Installed $PLIST_DST"
    echo "  Supervisor: $SUPERVISOR"
    echo "  Watch:      tail -f $LOG"
    echo "  Status:     $0 status"

    # TCC probe — agent is loaded but won't actually run if Documents is blocked.
    echo ""
    echo "Checking macOS Full Disk Access for launchd…"
    if tcc_self_test; then
      echo "✓ launchd can reach ~/Documents — agent should be running."
    else
      echo "✗ launchd is blocked from reading ~/Documents."
      print_tcc_help
    fi

    if pgrep -fl "node.*pr-patrol run" >/dev/null 2>&1; then
      echo ""
      echo "ℹ Existing patrol process detected — it owns daemon.pid until it exits."
      echo "  The launchd supervisor will retry every 30s and take over once free."
      echo "  To migrate immediately: \`pnpm crux gh pr-patrol stop\` (run from lw/main)."
    fi
    ;;

  tcc-check)
    echo "Probing launchd → ~/Documents access…"
    if tcc_self_test; then
      echo "✓ launchd can reach ~/Documents — Full Disk Access is granted."
    else
      echo "✗ launchd is blocked from reading ~/Documents."
      print_tcc_help
      exit 1
    fi
    ;;

  uninstall)
    if [ -f "$PLIST_DST" ]; then
      launchctl unload "$PLIST_DST" 2>/dev/null || true
      rm -f "$PLIST_DST"
      echo "✓ Uninstalled $PLIST_DST"
    else
      echo "Already absent: $PLIST_DST"
    fi
    if launchctl list 2>/dev/null | grep -q "$LABEL"; then
      echo "⚠ launchd still lists $LABEL — try \`launchctl remove $LABEL\` if it persists."
    fi
    ;;

  status)
    if launchctl list 2>/dev/null | awk -v L="$LABEL" '$3 == L { found=1 } END { exit !found }'; then
      echo "✓ launchd: loaded"
      launchctl list 2>/dev/null \
        | awk -v L="$LABEL" '$3 == L { print "  pid=" $1 "  last_exit=" $2 "  label=" $3 }'
    else
      echo "✗ launchd: not loaded   (run: $0 install)"
    fi
    if pid=$(pgrep -fl "node.*pr-patrol run" 2>/dev/null | awk 'NR==1{print $1}'); then
      [ -n "$pid" ] && echo "✓ patrol process: pid=$pid"
    else
      echo "✗ patrol process: not running"
    fi
    pidfile="$HOME/.cache/pr-patrol/daemon.pid"
    if [ -f "$pidfile" ]; then
      echo "  daemon.pid: $(cat "$pidfile") ($pidfile)"
    fi
    if [ -f "$LOG" ]; then
      mtime=$(stat -f %Sm -t '%Y-%m-%d %H:%M:%S' "$LOG" 2>/dev/null || stat -c '%y' "$LOG" 2>/dev/null || echo unknown)
      echo "  run.log:    last write $mtime"
    fi
    ;;

  tail)
    [ -f "$LOG" ] || { echo "Log not found: $LOG" >&2; exit 1; }
    exec tail -F "$LOG"
    ;;

  *)
    echo "Usage: $0 {install|uninstall|status|tail|tcc-check}" >&2
    exit 2
    ;;
esac
