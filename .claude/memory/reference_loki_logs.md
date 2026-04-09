---
name: Loki log querying
description: How to query production logs via Loki for the longtermwiki k8s namespace
type: reference
originSessionId: cbbfe096-cb28-4cb2-8863-c1aa75644976
---
Port-forward the Loki gateway: `kubectl port-forward -n loki svc/loki-gateway 13100:80`

Then query with curl:
```bash
curl -s 'http://localhost:13100/loki/api/v1/query_range' \
  --data-urlencode 'query={namespace="longtermwiki",container="worker"} |= "error text"' \
  --data-urlencode 'start='$(date -d '48 hours ago' +%s)000000000 \
  --data-urlencode 'end='$(date +%s)000000000 \
  --data-urlencode 'limit=20'
```

Key details:
- Use relative timestamps (`$(date -d 'X hours ago' +%s)000000000`) — hardcoded epoch values are error-prone
- Container labels: `server` for wiki-server, `worker` for worker pods, `groundskeeper` for groundskeeper
- Pipe through `python3 -m json.tool` or parse with python to extract `data.result[].values[]`
- `stern` is also available for live tailing: `stern -n longtermwiki longterm-wiki-worker --tail 50`
