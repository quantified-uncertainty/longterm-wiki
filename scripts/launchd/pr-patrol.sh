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

WIKI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_SRC="$WIKI_ROOT/scripts/launchd/com.qu.pr-patrol.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.qu.pr-patrol.plist"
LABEL="com.qu.pr-patrol"
SUPERVISOR="$WIKI_ROOT/scripts/pr-patrol-supervisor.sh"
CACHE_DIR="$HOME/.cache/pr-patrol"
LOG="$CACHE_DIR/run.log"
# Loose pattern matches the patrol process (`node ... pr-patrol run` /
# pnpm parent) AND the launchd supervisor in its 30s sleep window. Kept in
# sync with inject-patrol-status.sh so liveness checks agree across files.
PATROL_PROCESS_PATTERN='pr-patrol run|pr-patrol-supervisor\.sh'

cmd="${1:-install}"

# Escape sed replacement-string metachars (\, &, |) so paths with shell-special
# characters survive substitution. macOS allows `&`, `'`, `(`, `)`, etc. in
# usernames; HOME/SUPERVISOR could contain any of them. `|` is our chosen sed
# delimiter and must be escaped in the replacement, not just the pattern.
sed_replacement_escape() {
  printf '%s\n' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# Render the embedded XML template, substituting placeholders via sed (so the
# heredoc terminator stays quoted and shell expansion can't sneak in).
# Placeholders are processed longest-first so a future short name can never
# clobber bytes inside a longer one (e.g. `__HOME__` inside `__HOME_DIR__`).
render_template() {
  # Args: input_file output_file [placeholder=value]...
  local input="$1" output="$2"
  shift 2
  local pairs=("$@")
  # Sort pairs by placeholder length descending.
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
  local probe_template="/tmp/$probe_label.template"

  # Cleanup trap — if the probe is interrupted (Ctrl-C, kill, error), make
  # sure we don't leave the probe plist in ~/Library/LaunchAgents/ where
  # launchd would re-run it on next login.
  local prev_int_trap prev_term_trap prev_exit_trap
  cleanup_probe() {
    launchctl unload "$probe_plist" 2>/dev/null || true
    /bin/rm -f "$probe_plist" "$probe_out" "$probe_err" "$probe_template"
  }
  trap cleanup_probe EXIT INT TERM

  /bin/rm -f "$probe_out" "$probe_err" "$probe_template"

  # Quoted heredoc — no shell expansion. Placeholders are filled in via sed
  # below using the same escaping the install path uses for the main plist.
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
  # `set -e` is in effect; tolerate load failure (the cleanup trap still runs).
  # On failure we fall through and report TCC as blocked — the conservative
  # default.
  if ! launchctl load "$probe_plist" 2>/dev/null; then
    trap - EXIT INT TERM
    cleanup_probe
    return 1
  fi

  # One-shot plist — wait briefly for output.
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
  do not inherit the TCC profile of Terminal/iTerm, so they cannot reach the
  wiki clone if it lives anywhere under ~/Documents/.

  To grant access (one-time per machine):
    1. Open  System Settings → Privacy & Security → Full Disk Access
    2. Click  ＋ , press  Cmd-Shift-G , type  /bin , and select  bash .
       (Adding the supervisor script directly does NOT work: macOS attributes
       shell-script execution to the interpreter, and the FDA picker filters
       out .sh files anyway. See QUA-1004 for the full root-cause writeup.)
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
    mkdir -p "$HOME/Library/LaunchAgents" "$CACHE_DIR"

    # Render the plist with absolute paths. render_template escapes sed
    # replacement metachars (\, &, |) so paths with shell-special characters
    # in the username or path segments don't break the substitution.
    render_template "$PLIST_SRC" "$PLIST_DST" \
      "__SUPERVISOR__=$SUPERVISOR" \
      "__HOME__=$HOME"

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

    if pgrep -f "$PATROL_PROCESS_PATTERN" >/dev/null 2>&1; then
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
    # Capture launchctl state once and reuse — single subprocess, single source.
    launchd_row=$(launchctl list 2>/dev/null | awk -v L="$LABEL" '$3 == L { print; exit }' || true)
    last_exit=""
    if [ -n "$launchd_row" ]; then
      echo "✓ launchd: loaded"
      # Columns: pid  last_exit  label
      lpid=$(awk '{print $1}' <<<"$launchd_row")
      last_exit=$(awk '{print $2}' <<<"$launchd_row")
      echo "  pid=$lpid  last_exit=$last_exit  label=$LABEL"
      # Surface a non-zero last_exit prominently — without this, a launchd-broken
      # state (e.g. last_exit=126 from TCC blocking) reads as healthy when paired
      # with a tmux-managed patrol holding daemon.pid.
      if [ "$last_exit" != "0" ] && [ "$last_exit" != "-" ] && [ -n "$last_exit" ]; then
        echo "  ⚠ supervisor exited non-zero last cycle (code=$last_exit) — see ~/.cache/pr-patrol/launchd.err"
        if [ "$last_exit" = "126" ]; then
          echo "    code 126 = Operation not permitted; run \`$0 tcc-check\` to verify FDA."
        fi
      fi
    else
      echo "✗ launchd: not loaded   (run: $0 install)"
    fi
    # Loose pattern matches the patrol process AND the launchd supervisor's
    # 30s sleep window between cycles, aligned with inject-patrol-status.sh.
    pid=$(pgrep -f "$PATROL_PROCESS_PATTERN" 2>/dev/null | head -1)
    if [ -n "$pid" ]; then
      echo "✓ patrol process: pid=$pid"
    else
      echo "✗ patrol process: not running"
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
