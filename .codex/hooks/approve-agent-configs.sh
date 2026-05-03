#!/usr/bin/env bash
#
# PreToolUse hook for Edit|Write: auto-approve modifications to legacy agent
# configuration paths and session-state files under .claude/.
#
# Why this exists: the repo still stores checklist, memory, and session
# state in `.claude/` while the Codex migration is in progress. Those files
# are agent-managed state and should not require repeated prompts.
#
# The fix: emit JSON `{"decision":"approve"}` for known-safe legacy
# state/config paths.
#
# Auto-approved paths (under .claude/):
#   Agent configs (checked in):
#     commands/, agents/, skills/
#   Session state (gitignored or agent-managed):
#     sessions/, memory/, snapshots/, plans/, reviews/
#     wip-checklist.md, wip-context.md
#     review-done, review-phases-done, simplify-done
#     active-branch, session.pid, session-log.md
#     maintain-last-run.txt, issue-creates.json
#
# NOT auto-approved (intentionally require human review):
#   settings.json, settings.local.json, hooks/, rules/, audits.yaml,
#   scripts/, design/, setup.sh, common-issues.md

set -uo pipefail

# Read the file_path from the tool_input JSON on stdin. If jq isn't
# available or parse fails, fall through (safe default).
FILE_PATH=$(cat 2>/dev/null | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Directories that are safe to auto-approve wholesale.
if [[ "$FILE_PATH" =~ \.claude/(commands|agents|skills|sessions|memory|snapshots|plans|reviews)/ ]]; then
  echo '{"decision":"approve","reason":"auto-approved: .claude config/session path"}'
  exit 0
fi

# Top-level session-state files inside .claude/ (no subdirectory).
if [[ "$FILE_PATH" =~ \.claude/(wip-checklist\.md|wip-context\.md|review-done|review-phases-done|simplify-done|active-branch|session\.pid|session-log\.md|maintain-last-run\.txt|issue-creates\.json)$ ]]; then
  echo '{"decision":"approve","reason":"auto-approved: .claude session state"}'
  exit 0
fi

exit 0
