#!/bin/bash
# SCRY smoke test — matches the URL + Bearer auth used by production code
# (crux/lib/search/research-agent.ts, crux/authoring/creator/research.ts).
set -euo pipefail
KEY="${SCRY_API_KEY:?set SCRY_API_KEY in your environment}"
curl -sS --fail \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${KEY}" \
  'https://api.scry.io/v1/scry/query' \
  -d '{"sql": "SELECT title, uri FROM scry.search('"'"'anthropic'"'"', '"'"'mv_eaforum_posts'"'"') WHERE title IS NOT NULL AND kind = '"'"'post'"'"' LIMIT 3"}'
