---
description: Enrich structured data (personnel, funding, benchmarks) via tier=T3 defensive propose, subscription mode.
effort: medium
---

# TableBase Enrich — Subscription / T3 Mode (QUA-643)

Enrich structured data (personnel, funding rounds, benchmark-results) using the Claude subscription instead of API billing. Every submitted record goes through `/api/enrichment/propose` with `tier=T3` so the defensive gate + strict verdict check still applies. Processes up to 5 tasks per invocation.

**Schedule:** `/loop 4h /review-tablebase-enrich` for periodic runs.

**Do NOT run `/agent-init`** — this skill manages its own workflow.

## Why T3, not direct sync

QUA-632 Phase 1 introduced `/api/enrichment/propose` — a gate that atomically writes `(row + evidence + verdict)` inside one transaction and rejects rows that don't pass the strict `confirmed`-only check. T1 importers (QUA-640/QUA-665/QUA-666) already go through it; T2 website extraction (QUA-642) is being wired.

T3 = "agent-researched, quote-verified". We route subscription-mode rows through the same gate so the burst never writes unverified rows to the tablebase. The defensive gate is cheap insurance.

## Kill-switch — check this first

Before picking a task, check whether the watchdog has killed this burst:

```bash
# Watchdog writes ~/.cache/enrichment/kill-<runId> when spend exceeds cap.
ls -la ~/.cache/enrichment/kill-${ENRICHMENT_RUN_ID:-unset} 2>/dev/null && {
  echo "Run killed by watchdog — stopping.";
  exit 0;
}
```

If the kill marker exists, stop immediately — no new proposals this session.

## Kickoff — set a run id

Each burst session should share a `run_id` so `enrichment_runs` counters aggregate cleanly and the watchdog has one row to watch:

```bash
export ENRICHMENT_RUN_ID="t3-$(date -u +%Y%m%d-%H)-${SLOT:-local}"
```

Pass this as `--run-id=$ENRICHMENT_RUN_ID` on every propose call.

## Target-aware queue

`crux tb prepare` ranks by `completenessPercent × taskTypeWeight × importance`. That's fine for general enrichment but ignores the QUA-637 acceptance targets. Before starting, check which (org, record_type) pairs are farthest from target:

```bash
pnpm crux enrichment acceptance-report --threshold=0.30
```

Prioritize any org + record_type pair showing ≥30% gap. If `tb prepare` picks a task on an org that already meets target, skip it — use `tb mark-done <taskId>` to exclude it and re-run `tb prepare`.

## The loop

Repeat this cycle up to 5 times:

### Step 1: Get next task

```bash
pnpm crux tb prepare
```

If output is `NO_TASKS`, stop. Otherwise read the task details, search queries, record template.

### Step 2: Research

Follow the **research strategy** from the prepare output:

1. **Try the team page first** (if URLs are provided). Use WebFetch with: "List ALL team members with their full names and roles/titles." Team pages often yield 10-50+ people in one call.
2. **If WebFetch returns empty/404**, fall back to Playwright: `pnpm crux tb fetch-page "https://example.com/team"`.
3. **Fall back to WebSearch** if team pages don't work. Also try `"<org name>" site:linkedin.com/company`.
4. **If divisions are listed**, look specifically for team leads of each division — high-priority personnel targets.
5. **For notable researchers**, search for specific people by name for roles, start dates, publications.

### Step 3: Resolve or create entities

Collect person names into a JSON array and run:

```bash
echo '["Jaime Sevilla","Ben Cottier"]' | pnpm crux tb ensure-entities --type=person --ci
```

This resolves existing entities and creates new ones in one batch call. Use each returned `stableId` in your records.

### Step 4: Build proposals — one per row

For every record, you **must** produce a proposal payload the propose endpoint accepts. T3 requires the verdict-LLM fields so the gate can verify the claim is backed by a verbatim quote:

```json
{
  "tier": "T3",
  "recordType": "personnel",
  "row": {
    "id": "<sha256[:10] of sourceUrl + canonical claim>",
    "personId": "<stableId from ensure-entities>",
    "organizationId": "<org stableId>",
    "role": "Head of Alignment",
    "roleType": "key-person",
    "startDate": "2024-03",
    "source": "https://example.com/team"
  },
  "sourceUrl": "https://example.com/team",
  "sourceContentHash": "<sha256 hex of fetched page>",
  "verdict": "confirmed",
  "confidence": 0.9,
  "quotedText": "Jane Doe joined as Head of Alignment in March 2024.",
  "reasoning": "Page explicitly states role and start date.",
  "checkerModel": "claude-opus-4-7",
  "costUsd": 0.03,
  "runId": "<env ENRICHMENT_RUN_ID>"
}
```

Requirements (strict — the gate rejects anything short):
- `verdict` MUST be `"confirmed"`. If the source only *partially* supports the claim, don't submit — route to a triage ticket.
- `quotedText` MUST be a verbatim substring of the page, ≥40 chars. Paraphrasing is rejected.
- `sourceContentHash` is the SHA-256 hex of the fetched page content. Use it consistently so `row.id` derivation is stable (the wiki-server computes `row.id` from `sourceContentHash[:10]` when absent — but we send our own id so retries land on the same row).
- `costUsd` — your honest guess at the verdict-LLM cost for this proposal (tokens × $/token). In subscription mode this is 0, but pass something if you want the watchdog to see non-zero spend.
- `runId` — the `$ENRICHMENT_RUN_ID` you set at kickoff.

### Step 5: Submit proposals

One record per request (the propose endpoint is single-row):

```bash
# proposal.json is the object above, rendered to disk.
curl -fsS -X POST \
  -H "content-type: application/json" \
  -H "x-api-key: $LONGTERMWIKI_SERVER_API_KEY" \
  -d @proposal.json \
  $LONGTERMWIKI_SERVER_URL/api/enrichment/propose
```

Read the response:
- `status: "accepted"` — row is in the tablebase with a `confirmed` verdict. Done.
- `status: "rejected", rejectionReason: "..."` — gate rejected. Read the reason:
  - "quotedText too short" → your quote is <40 chars; grab a longer span.
  - "quotedText is not a verbatim substring" → you paraphrased. Copy-paste the exact text.
  - "T3: sourceUrl is a homepage" → pick a sub-page (e.g. `/team` not `/`).
  - other → log and move on; don't retry with the same proposal.

### Step 6: Watchdog heartbeat

After each batch, spot-check the watchdog isn't about to kill:

```bash
pnpm crux enrichment watchdog --run-id=$ENRICHMENT_RUN_ID --oneshot --max-spend-per-hour=20
```

- Exit 0 with a rate line → healthy, continue.
- Exit 2 → kill marker written, stop this session.

### Step 7: Mark done and continue

```bash
pnpm crux tb mark-done <taskId>
```

Go back to Step 1.

## Rules

- Only submit data confirmed by web search. No fabrication.
- Every proposal needs a source URL AND a ≥40-char verbatim quote.
- Cross-reference key facts across 2+ sources when possible.
- If you can only find a year, use `YYYY` — don't guess month/day.
- `roleType` must be: `key-person`, `board`, or `career`.
- **Do not call `crux tb submit` from this skill.** Direct sync bypasses the propose gate. Use `/api/enrichment/propose` as above.

## At the end

Print a one-line summary: `T3 burst: run=$ENRICHMENT_RUN_ID, accepted=N, rejected=M, tasks=K`.

Optionally refresh the gap report:

```bash
pnpm crux enrichment acceptance-report --threshold=0.30 | head -20
```

## Cost comparison

| Mode | Cost per task | Best for |
|------|-------------|----------|
| **Subscription (this skill)** | $0 (Max sub time) | Interactive research, burst runs |
| **API loop (haiku)** | ~$0.05-0.15 | High-volume simple tasks |
| **API loop (sonnet)** | ~$0.20-0.35 | Complex tasks |

## See also

- `crux/commands/tb-importers/propose-client.ts` — reference implementation of the propose request shape.
- `apps/wiki-server/src/routes/enrichment/enrichment.ts` — gate rules (verdict + quote-length + homepage-rejection).
- `crux/lib/enrichment/watchdog.ts` — spend monitor.
- QUA-637 — umbrella.
