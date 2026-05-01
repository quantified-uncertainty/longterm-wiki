#!/usr/bin/env bash
#
# PreToolUse hook for Edit|Write: auto-approve modifications to agent
# configuration paths and session-state files under .claude/.
#
# Why this exists: Claude Code v2.1.56+ has a confirmed regression where
# dispatched subagents do not inherit the parent session's
# `permissions.allow` list from settings.json. Separately, "Always allow"
# writes to settings.local.json, which is per-slot — so the same basic
# file edits (wip-checklist.md, review-done markers, session logs) prompt
# fresh in every new slot.
#
# Tracking issues (all OPEN as of 2026-04-12):
#   - anthropics/claude-code#18950
#   - anthropics/claude-code#37730
#   - anthropics/claude-code#28584
#   - anthropics/claude-code#22665
#
# The fix: emit JSON `{"decision":"approve"}` to skip the permission prompt
# entirely. Hooks DO fire for subagents (they're not subject to the
# permission-inheritance bug), so this works uniformly across the parent
# session and every dispatched agent.
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
