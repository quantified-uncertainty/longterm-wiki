#!/usr/bin/env bash
#
# PreToolUse hook for Edit|Write: auto-approve modifications to
# .claude/{commands,agents,skills}/*.md — the standard "agent configuration"
# paths that Claude Code itself routinely writes to when creating slash
# commands, subagents, and skills.
#
# Why this exists: Claude Code v2.1.56+ has a confirmed regression where
# dispatched subagents do not inherit the parent session's
# `permissions.allow` list from settings.json. Every Edit/Write on these
# paths triggers an interactive approval prompt that subagents can't
# respond to, so the tool call gets denied. The result: subagents silently
# skip documentation updates that the parent was authorized to make.
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
# Scope: intentionally narrow. Only matches file_path containing
# .claude/commands/, .claude/agents/, or .claude/skills/. Anything else
# falls through to the normal permission flow.

set -uo pipefail

# Read the file_path from the tool_input JSON on stdin. If jq isn't
# available or parse fails, fall through (safe default).
FILE_PATH=$(cat 2>/dev/null | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

if [[ "$FILE_PATH" =~ \.claude/(commands|agents|skills)/ ]]; then
  # Skip the permission prompt. Deny rules at higher scopes still apply.
  echo '{"decision":"approve","reason":"auto-approved: .claude config path"}'
fi

exit 0
