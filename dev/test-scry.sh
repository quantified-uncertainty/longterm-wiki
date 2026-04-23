#!/bin/bash
# SCRY smoke test — matches the URL + Bearer auth used by production code
# (crux/lib/search/research-agent.ts, crux/authoring/creator/research.ts).
# Override the key with SCRY_API_KEY if you have a private one.
KEY="${SCRY_API_KEY:-exopriors_public_readonly_v1_2025}"
curl -s \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${KEY}" \
  'https://api.scry.io/v1/scry/query' \
  -d '{"sql": "SELECT title, uri FROM scry.search('"'"'anthropic'"'"', '"'"'mv_eaforum_posts'"'"') WHERE title IS NOT NULL AND kind = '"'"'post'"'"' LIMIT 3"}'
