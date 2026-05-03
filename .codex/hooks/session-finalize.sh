#!/usr/bin/env bash
#
# SessionEnd hook — auto-finalize agent session metadata from JSONL transcript.
#
# Runs when an agent session ends. Parses the JSONL transcript to extract
# title, summary, cost, model, and duration, then PATCHes the agent_sessions record.
#
# This is a fail-safe hook: all errors are caught and logged to stderr.
# A failure here MUST NOT block session exit.
#

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Only finalize on feature branches (not main, detached, or empty)
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if [ -z "$BRANCH" ] || [ "$BRANCH" = "main" ] || [ "$BRANCH" = "detached" ]; then
  exit 0
fi

# Run session-finalize via crux, using prod wiki-server
# Timeout: 20 seconds (the hook's overall timeout is 30s)
WIKI_SERVER_ENV=prod timeout 20 node --import tsx/esm --no-warnings \
  "$REPO_ROOT/crux/crux.mjs" sys session-finalize 2>&1 || {
  echo "session-finalize: failed (exit $?) — non-fatal" >&2
  exit 0
}

exit 0
