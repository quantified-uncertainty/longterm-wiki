#!/bin/bash
curl -s \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: exopriors_public_readonly_v1_2025' \
  'https://api.exopriors.com/v1/scry/query' \
  -d '{"sql": "SELECT title, uri FROM scry.search('"'"'anthropic'"'"', '"'"'mv_eaforum_posts'"'"') WHERE title IS NOT NULL AND kind = '"'"'post'"'"' LIMIT 3"}'
