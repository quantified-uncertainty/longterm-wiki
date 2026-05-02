#!/usr/bin/env bash
#
# health-monitor.sh — install / uninstall / status for the
# com.qu.health-monitor launchd agent.
#
# Usage:
#   ./health-monitor.sh             # install (idempotent — re-running is safe)
#   ./health-monitor.sh install     # same as no-arg
#   ./health-monitor.sh uninstall   # unload + remove from ~/Library/LaunchAgents
#   ./health-monitor.sh status      # show launchd state + actual monitor process
#   ./health-monitor.sh tail        # tail the run log (Ctrl-C to exit)
#   ./health-monitor.sh tcc-check   # probe macOS Full Disk Access
#
# Mirrors pr-patrol.sh's structure (QUA-987). The TCC self-test logic is
# duplicated for now — when a third launchd agent appears we should extract
# it into scripts/lib/launchd-tcc.sh. Tracked in code review notes for QUA-1048.
#
# See QUA-1048.

set -euo pipefail

WIKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_SRC="$WIKI_ROOT/scripts/launchd/com.qu.health-monitor.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.qu.health-monitor.plist"
LABEL="com.qu.health-monitor"
SUPERVISOR="$WIKI_ROOT/scripts/health-monitor-supervisor.sh"
CACHE_DIR="$HOME/.cache/health-monitor"
LOG="$CACHE_DIR/run.log"
# Loose pattern: matches the daemon process (`node ... sys health-monitor run`)
# and the supervisor in its 30s sleep window. Kept in sync with
# inject-health-status.sh so liveness checks agree across files.
MONITOR_PROCESS_PATTERN='sys health-monitor run|health-monitor-supervisor\.sh'

cmd="${1:-install}"

# Escape sed replacement-string metachars (\, &, |) so paths with shell-special
# characters survive substitution. macOS allows `&`, `'`, `(`, `)`, etc. in
# usernames; HOME/SUPERVISOR could contain any of them.
sed_replacement_escape() {
  printf '%s\n' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# Render the embedded XML template, substituting placeholders via sed.
# Placeholders are sorted longest-first so a future short name can never
# clobber bytes inside a longer one (e.g. `__HOME__` inside `__HOME_DIR__`).
render_template() {
  local input="$1" output="$2"
  shift 2
  local pairs=("$@")
  local sorted
  sorted=$(printf '%s\n' "${pairs[@]}" | awk '{ print length($0)"\t"$0 }' | sort -rn | cut -f2-)
  local sed_args=()
  local pair name val esc
  while IFS= read -r pair; do
    name="${pair%%=*}"
    val="${pair#*=}"
    esc=$(sed_replacement_escape "$val")
    sed_args+=(-e "s|$name|$esc|g")
  done <<<"$sorted"
  sed "${sed_args[@]}" "$input" > "$output"
}

# ── TCC self-test ─────────────────────────────────────────────────────────────
# Modern macOS blocks launchd-spawned processes from reading anything under
# ~/Documents/ unless the user grants Full Disk Access. Probe via a one-shot
# test plist that tries to cat $WIKI_ROOT/.git/HEAD: success means launchd
# can reach our wiki clone, failure means FDA is needed.
tcc_self_test() {
  local probe_label="com.qu.health-monitor-tccprobe"
  local probe_plist="$HOME/Library/LaunchAgents/$probe_label.plist"
  local probe_out="/tmp/$probe_label.out"
  local probe_err="/tmp/$probe_label.err"
  local probe_target="$WIKI_ROOT/.git/HEAD"
  local probe_template="/tmp/$probe_label.template"

  cleanup_probe() {
    launchctl unload "$probe_plist" 2>/dev/null || true
    /bin/rm -f "$probe_plist" "$probe_out" "$probe_err" "$probe_template"
  }
  trap cleanup_probe EXIT INT TERM

  /bin/rm -f "$probe_out" "$probe_err" "$probe_template"

  cat > "$probe_template" <<'PROBE_PLIST_TEMPLATE'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>__PROBE_LABEL__</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cat "__PROBE_TARGET__" > "__PROBE_OUT__" 2> "__PROBE_ERR__"</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
PROBE_PLIST_TEMPLATE

  render_template "$probe_template" "$probe_plist" \
    "__PROBE_LABEL__=$probe_label" \
    "__PROBE_TARGET__=$probe_target" \
    "__PROBE_OUT__=$probe_out" \
    "__PROBE_ERR__=$probe_err"

  launchctl unload "$probe_plist" 2>/dev/null || true
  if ! launchctl load "$probe_plist" 2>/dev/null; then
    trap - EXIT INT TERM
    cleanup_probe
    return 1
  fi

  for _ in 1 2 3 4 5 6; do
    [ -s "$probe_out" ] && break
    [ -s "$probe_err" ] && break
    sleep 0.5
  done

  local result=1
  [ -s "$probe_out" ] && result=0

  trap - EXIT INT TERM
  cleanup_probe
  return $result
}

print_tcc_help() {
  cat <<EOM

⚠ launchd cannot read files under ~/Documents/ — Full Disk Access is required.

  This is a macOS TCC restriction: agents loaded into launchd's Aqua context
  do not inherit the TCC profile of Terminal/iTerm.

  To grant access (one-time per machine):
    1. Open  System Settings → Privacy & Security → Full Disk Access
    2. Click  ＋ , press  Cmd-Shift-G , type  /bin , and select  bash .
       (Adding the supervisor script directly does NOT work: macOS attributes
       shell-script execution to the interpreter, not the script — see
       QUA-1004.)
    3. Toggle the new entry ON.
    4. Re-run:  ./health-monitor.sh install

  The same grant covers the pr-patrol launchd agent if you have it installed.
EOM
}

case "$cmd" in
  install)
    [ -f "$PLIST_SRC" ] || { echo "✗ Missing template: $PLIST_SRC" >&2; exit 1; }
    [ -f "$SUPERVISOR" ] || { echo "✗ Missing supervisor: $SUPERVISOR" >&2; exit 1; }

    chmod +x "$SUPERVISOR"
    mkdir -p "$HOME/Library/LaunchAgents" "$CACHE_DIR"

    render_template "$PLIST_SRC" "$PLIST_DST" \
      "__SUPERVISOR__=$SUPERVISOR" \
      "__HOME__=$HOME"

    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"

    echo "✓ Installed $PLIST_DST"
    echo "  Supervisor: $SUPERVISOR"
    echo "  Watch:      tail -f $LOG"
    echo "  Status:     $0 status"

    echo ""
    echo "Checking macOS Full Disk Access for launchd…"
    if tcc_self_test; then
      echo "✓ launchd can reach ~/Documents — agent should be running."
    else
      echo "✗ launchd is blocked from reading ~/Documents."
      print_tcc_help
    fi

    if pgrep -f "$MONITOR_PROCESS_PATTERN" >/dev/null 2>&1; then
      echo ""
      echo "ℹ Existing health-monitor process detected — it owns daemon.pid until it exits."
      echo "  The launchd supervisor will retry every 30s and take over once free."
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
    launchd_row=$(launchctl list 2>/dev/null | awk -v L="$LABEL" '$3 == L { print; exit }' || true)
    last_exit=""
    if [ -n "$launchd_row" ]; then
      echo "✓ launchd: loaded"
      lpid=$(awk '{print $1}' <<<"$launchd_row")
      last_exit=$(awk '{print $2}' <<<"$launchd_row")
      echo "  pid=$lpid  last_exit=$last_exit  label=$LABEL"
      if [ "$last_exit" != "0" ] && [ "$last_exit" != "-" ] && [ -n "$last_exit" ]; then
        echo "  ⚠ supervisor exited non-zero last cycle (code=$last_exit) — see ~/.cache/health-monitor/launchd.err"
        if [ "$last_exit" = "126" ]; then
          echo "    code 126 = Operation not permitted; run \`$0 tcc-check\` to verify FDA."
        fi
      fi
    else
      echo "✗ launchd: not loaded   (run: $0 install)"
    fi
    # `|| true` on the pgrep so set -e doesn't bail when no monitor is running
    # (pgrep exits 1 on no-match, which would otherwise propagate through the
    # `pid=$(…)` assignment and abort the status case).
    pid=$( (pgrep -f "$MONITOR_PROCESS_PATTERN" 2>/dev/null || true) | head -1)
    if [ -n "$pid" ]; then
      echo "✓ monitor process: pid=$pid"
    else
      echo "✗ monitor process: not running"
    fi
    pidfile="$CACHE_DIR/daemon.pid"
    if [ -f "$pidfile" ]; then
      pidcontents=$(cat "$pidfile" 2>/dev/null || echo "<unreadable>")
      echo "  daemon.pid: $pidcontents ($pidfile)"
    fi
    if [ -f "$LOG" ]; then
      mtime=$(stat -f %Sm -t '%Y-%m-%d %H:%M:%S' "$LOG" 2>/dev/null || echo unknown)
      echo "  run.log:    last write $mtime"
    fi
    # Surface active alerts
    state_dir="$CACHE_DIR/state"
    if [ -d "$state_dir" ]; then
      shopt -s nullglob
      alerts=("$state_dir"/alert-*)
      shopt -u nullglob
      if [ "${#alerts[@]}" -gt 0 ]; then
        echo "  active alerts: ${#alerts[@]}"
        for a in "${alerts[@]}"; do
          echo "    ⚠ ${a##*/alert-}"
        done
      else
        echo "  active alerts: none"
      fi
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
