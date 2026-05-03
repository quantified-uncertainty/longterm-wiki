# Claude Code OpenTelemetry — local Grafana stack

Local cost-observability stack for Claude Code agent slots. Brings up
an OTel Collector, Prometheus (with QUA-1068 alert rules), and Grafana
(with a pre-provisioned dashboard) via docker-compose.

See `content/docs/internal/agent-cost-monitoring.mdx` (rendered at
`/internal/agent-cost-monitoring`) for the full setup walkthrough,
metric schema, and acceptance-criteria mapping.

## Quick start

```bash
# 1. Add the env vars to whichever .env Claude Code reads
cat tools/claude-code-otel/env.example >> ../.env.base   # or wherever

# 2. Bring up the stack
cd tools/claude-code-otel
docker compose up -d

# 3. Restart any running Claude Code sessions so they pick up the
#    new env vars and start emitting metrics.

# 4. Visit Grafana
open http://localhost:3000
```

## Layout

| Path | What it is |
|------|-----------|
| `docker-compose.yml`                              | Three-service stack (collector + Prometheus + Grafana). |
| `otel-collector/config.yaml`                      | OTLP intake on :4317 (gRPC) + :4318 (HTTP); Prometheus exporter on :8889. |
| `prometheus/prometheus.yml`                       | Scrapes the collector's exporter every 30s. |
| `prometheus/alerts.yml`                           | The three QUA-1068 alert rules (session>$50, cache<90%, branch>$200). |
| `grafana/provisioning/`                           | Provisions Prometheus datasource + dashboard folder. |
| `grafana/dashboards/claude-code-cost.json`        | Per-slot cost, cache hit rate, p95 cost, tool-call distribution. |
| `env.example`                                     | OTel env vars to copy into `.env.base`. |

## Verifying it works

After starting the stack and restarting Claude Code:

```bash
# Run any agent task — even a `/agent-init` call — to generate metrics.

# Confirm the collector received metrics:
curl -s http://localhost:8889/metrics | grep claude_code | head

# Confirm Prometheus is scraping:
curl -s 'http://localhost:9090/api/v1/query?query=claude_code_session_count' | jq

# Open Grafana → Dashboards → Claude Code → Claude Code Cost & Usage
```

## Alert routing

Out of the box, alerts fire to Prometheus's internal alert state but
have no destination. To route to Slack/email/Linear, point Prometheus at
an Alertmanager — see Prometheus docs and add an `alerting:` block to
`prometheus/prometheus.yml`. Routing config is intentionally
unspecified here because it depends on the operator's existing
notification stack.

## Comparison with upstream `claude-code-otel`

[ColeMurray/claude-code-otel](https://github.com/ColeMurray/claude-code-otel)
is a richer reference stack with more dashboards. This vendored stack
is intentionally minimal: just enough to satisfy QUA-1068 acceptance
criteria with all config in-repo (so dashboard changes ship via PR).
For exploration, run upstream alongside this one — they listen on
different ports.
