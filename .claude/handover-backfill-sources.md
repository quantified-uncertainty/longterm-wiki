# Handover — Backfill-Sources Investigation (2026-05-04)

## Where we are

- **Branch:** `claude/backfill-sources-cron` (rebased onto latest main)
- **Draft PR:** https://github.com/quantified-uncertainty/longterm-wiki/pull/4852
- **Project goal:** improve `crux tb backfill-sources` quality + understand why prod runs only persist a fraction of "matched" records.

## What's already shipped on this branch (committed + pushed)

1. Dual-judge wrapper around quote-extraction (Haiku) and entailment (Sonnet). Local vLLM at `http://localhost:8000/v1` (model `/root/model-gptq`) runs in parallel; only Haiku/Sonnet drives accept/reject. Toggle: `BACKFILL_DUAL_JUDGE=0` disables.
2. Per-candidate detail in the JSON report (`candidates[]`): url, provider, decision, rejection_reason, full Haiku/Sonnet/vLLM raw text + parsed quotes + durations.
3. Content cache: page text passed to judges is sha256-keyed and persisted under `dev/backfill-content-cache/<sha>.txt` so any candidate can be replayed byte-for-byte. Hash + char count stored per candidate.
4. Groundskeeper cron task: `apps/groundskeeper/src/tasks/backfill-sources-enqueue.ts` + handler.
5. Analysis scripts in `dev/`:
   - `audit-matched-sample.mjs` — judge sampled matched records vs the page they cite
   - `compare-judges.mjs` — Haiku/Sonnet vs vLLM agreement tallies
   - `bucket-unmatched.mjs` — classify unmatched records by failure mode
   - `replay-judges-on-text.mjs` — replay both judges against a cached page
   - `uber-judge-entailment.mjs` — claude-opus tiebreaker for Sonnet vs vLLM disagreements (just refactored — see "in flight")

## The big finding (from the prod run on 2026-05-01)

Run stats:
- 610 records processed, 178 "matched" (29.2%), 431 unmatched (70.7%), 1 skipped
- Only ~25 of 178 matched URLs actually persisted on prod — the rest got wiped.

Root cause: writes to `facts.source` and `policy_stakeholders.source` are clobbered by the YAML→PG sync workflow (`.github/workflows/sync-entities-facts.yml`), which runs on every push to `data/entities/**` or `packages/factbase/data/fb-entities/**` and rebuilds those PG tables from YAML (which doesn't carry our new `source:` URLs).

Per-table survival:
| table | matched | persisted | wiped | YAML mirror? |
|--|--|--|--|--|
| facts | 126 | 0 | 126 | yes (`packages/factbase/data/fb-entities/`) |
| policy_stakeholders | 27 | 0 | 27 | yes (`data/entities/*.yaml` `stakeholders:`) |
| page_citations | 24 | 24 | 0 | no (PG-primary) |
| equity_positions | 1 | 1 | 0 | no |

Other tables in `crux tb backfill-sources` write paths (`personnel`, `investments`, `divisions`, `funding_rounds`, `funding_programs`, `publications`) are PG-primary — no wipe risk.

## Architecture position (from Linear/GitHub research)

- **YAML stays as source of truth.** PG-First Migration (#2428) explicitly defers YAML retirement.
- **PG-primary migration was rejected on 2026-05-02** (QUA-1043 / QUA-1044 closeout). v1–v5 plans all canceled. Direction: improve YAML editing UX + Class C silent-drop coverage, not migrate.
- **`crux fb backfill-sources` exists** (PR #4749, QUA-933, merged 2026-05-01) — writes URLs back to YAML via `updateFactMetaById` in `crux/lib/factbase-writer.ts`. But it has only been run in prod ONCE as a single-fact smoke test; it's untested at scale and lacks the verification work in `tb backfill-sources`.

## Agreed plan for the wipe issue (option 2 — dual-write to YAML + PG)

1. Branch the backfill's write step by table:
   - PG-primary tables (page_citations, equity_positions, etc.) → keep PG-only write (today's behavior).
   - YAML-mirrored tables (facts, policy_stakeholders) → dual-write: PG (immediate visibility) + local YAML.
2. For facts: reuse existing `updateFactMetaById` in `crux/lib/factbase-writer.ts`.
3. For policy_stakeholders: build a new helper that finds the right `data/entities/*.yaml` file by `policyEntityId` and the stakeholder entry within `stakeholders:` array (likely composite-key match: `stakeholderDisplayName + position`), writes `source: <url>`.
4. Track touched YAML files in a Set on the run object.
5. At end of run (skipped on `--dry-run`): create branch `claude/backfill-sources-yaml-<ts>`, stage touched YAML files explicitly, commit, push, open PR via `gh pr create`.
6. Refuse to run if on `main`.
7. Extend report with per-record `yaml_write: succeeded | failed | not-applicable`.
8. Tests for the new stakeholder writer + dual-write orchestration.

After PR merges, the existing sync workflow propagates YAML sources to PG, making them durable.

## In flight (NOT done)

- **Task #4: uber-judge entailment audit (claude-opus tiebreaker for the 106 Sonnet/vLLM disagreements).** Just refactored `dev/uber-judge-entailment.mjs` to write streaming JSONL with header + per-case rows + footer, including per-call token usage + USD cost + total. Has NOT been run yet — ready to run with: `set -a; source .env; set +a; node --import tsx/esm dev/uber-judge-entailment.mjs`. Output: `dev/audits/uber-judge-entailment-<ts>.jsonl`. Cost ~$0.10–0.20.
- **Task #10: scope/implement option 2 (YAML write-back).** Scope decided (above). Not started coding.

## Pending tasks (full list)

- #2 Diagnose page_citations 9% match rate (236 unmatched, biggest bucket)
- #3 Diagnose policy_stakeholders 21% match rate (60% are no-entity-mention — search-side problem)
- #4 [in_progress] Audit 106 entailment disagreements via opus tiebreaker
- #5 Audit 216 quote-extraction disagreements (135 only-Haiku, 81 only-vLLM)
- #6 Diagnose facts 60% match rate (83 unmatched)
- #7 Diagnose personnel + investments 0% match (10 records total)
- #8 Implement fixes from diagnoses
- #9 Re-run backfill on residual + measure lift
- #10 [in_progress] Scope option 2: YAML write-back for facts + policy_stakeholders

## Key files

**Backfill core:**
- `crux/commands/backfill-sources.ts`
- `crux/lib/backfill-sources/process-record.ts`
- `crux/lib/backfill-sources/verify-source.ts`
- `crux/lib/backfill-sources/llm-calls.ts`
- `crux/lib/backfill-sources/vllm-client.ts` (new)
- `crux/lib/backfill-sources/content-cache.ts` (new)
- `crux/lib/backfill-sources/types.ts` (CandidateRecord defines per-candidate data)
- `crux/lib/backfill-sources/report.ts`

**Wiki-server endpoints:**
- `apps/wiki-server/src/routes/sourcing/missing-sources/queries.ts` (list missing-source records)
- `apps/wiki-server/src/routes/sourcing/missing-sources/updates.ts` (per-table source write)
- `apps/wiki-server/src/routes/factbase/facts.ts` (`POST /sync` upsert that wipes `source` on YAML→PG sync)
- `apps/wiki-server/src/routes/tablebase/policy-stakeholders.ts` (`POST /sync` for stakeholders)

**YAML writers:**
- `crux/lib/factbase-writer.ts` → `updateFactMetaById`
- `crux/wiki-server/sync-facts.ts` (the sync that wipes — sends `source: null` for YAML facts without source)

**Reports + caches:**
- `dev/reports/backfill-unmatched-2026-05-01T10-55-01-482Z.json` (the live run report)
- `dev/backfill-content-cache/<sha>.txt` (page text cache)
- `dev/cache/opus-entailment/<sha>.txt` (opus uber-judge cache, currently empty)
- `dev/audits/` (analysis output dir)

## Dev env

- `./dev/dev-env.sh status|start|psql|psql-prod|import-prod`
- Local prod-imported PG via docker compose (port 5432). Last imported 2026-05-01.
- Production wiki-server: `https://wiki-server.k8s.quantifieduncertainty.org` (auth via `PROD_LONGTERMWIKI_SERVER_API_KEY` in `.env`)
- vLLM running at `http://localhost:8000/v1`, model `/root/model-gptq` (max_model_len 131072)

## Memory / preferences (from auto-memory)

- Keep replies tiny; user reads only a few sentences at a time
- For typecheck/build: `tmux send-keys -t longerm-claude:0.1 "cmd" Enter` (right pane), no head/tail/grep piping
- Don't `sleep N` to wait for tmux output — use Monitor or capture immediately
- Never `git add -A` / `git add .` — always stage files explicitly by name

## Common diagnostic recipes

- "Why didn't records X persist?" → query prod via `./dev/dev-env.sh psql-prod -c "..."`
- "Show me judge disagreements" → `node dev/compare-judges.mjs <report>`
- "Bucket the unmatched" → `node dev/bucket-unmatched.mjs <report>`
- "Replay both judges on cached page" → `node --import tsx/esm dev/replay-judges-on-text.mjs <text-file> "<claim>" "<entity>"`
