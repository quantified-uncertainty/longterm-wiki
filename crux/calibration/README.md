# Verdict LLM Calibration (QUA-635)

De-risking tool for the defensive enrichment burst (QUA-637). Measures the precision/recall/false-confirm rate of the verdict LLM against a corpus of known-true and known-false (claim, source) pairs.

## Files

| File | Purpose |
|---|---|
| `build-corpus.ts` | Sample confirmed verdicts from prod + construct mismatched mutations. Emits `data/corpus.json` (100 items: 50 true + 50 false). |
| `run-calibration.ts` | Replay the corpus through the production `buildRecordSourcingPrompt` using a specified model. Emits `data/results-{haiku,sonnet}.json`. |
| `analyze-results.ts` | Compute precision/recall/false-confirm/quote-fidelity/cost/latency metrics for both runs. Emits `data/metrics.json`. |
| `data/` | All artifacts (committed so re-runs are reproducible). |

## Usage

```bash
# From an agent slot (WIKI_SERVER_ENV=prod auto-detected):
node --import tsx/esm crux/calibration/build-corpus.ts         # ~2 min, reads prod
node --import tsx/esm crux/calibration/run-calibration.ts --model=haiku   # ~6 min, ~$0.45
node --import tsx/esm crux/calibration/run-calibration.ts --model=sonnet  # ~9 min, ~$1.37
node --import tsx/esm crux/calibration/analyze-results.ts      # instant
```

`--limit=N` on the runner restricts to the first N items (smoke test).

## When to re-run

- After any change to `crux/lib/sourcing/item-verifier.ts` or `crux/lib/sourcing/prompt-guidelines.ts` (prompt hygiene).
- After a model version change (the current checker model is `claude-haiku-4-5-20251001`).
- Mid-burst (end of Week 1, Week 2) as a drift guard on organic data.

## Results + recommendation

See `docs/audits/2026-04-19-verdict-llm-calibration.md`.
