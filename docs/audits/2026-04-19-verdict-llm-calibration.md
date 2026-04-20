# Verdict LLM Calibration — Haiku vs Sonnet for the Defensive Gate

**Linear:** [QUA-635](https://linear.app/quantifieduncertainty/issue/QUA-635) (parent [QUA-637](https://linear.app/quantifieduncertainty/issue/QUA-637) — coverage expansion burst)
**Date:** 2026-04-19
**Scripts:** `crux/calibration/{build-corpus.ts, run-calibration.ts, analyze-results.ts}`
**Raw data:** `crux/calibration/data/{corpus.json, results-haiku.json, results-sonnet.json, metrics.json}`

## TL;DR

| Metric | Haiku 4.5 | Sonnet 4.6 |
|---|---:|---:|
| **False-confirm rate** (known-false → `confirmed`) | **0.0%** | **0.0%** |
| **False-pass rate** (known-false → `confirmed` ∪ `partial`) | 4.0% | **0.0%** |
| Recall on known-true (`confirmed` only) | **92.0%** | 64.0% |
| Recall on known-true (`confirmed` ∪ `partial`) | 98.0% | 94.0% |
| Precision at `confirmed` | 100.0% | 100.0% |
| Quote fidelity (≥40 char verbatim match in source) | 75.5% | 78.0% |
| Cost per item | **$0.0045** | $0.0137 |
| Latency per item | **3.1s** | 5.5s |

**Recommendation:** **Ship the defensive burst with Haiku 4.5 as the verdict LLM, but restrict the gate-pass criterion to `verdict === 'confirmed'`. Do NOT accept `partial` as passing the defensive gate.** Under that rule Haiku achieves 0% false-pass with 92% recall on true items. Route any `partial` verdicts to a triage queue (human review or Sonnet second opinion). Projected incremental cost for the T3 burst (~1000 rows) stays at **~$5 total**, and Sonnet is held in reserve as a fallback for `partial` triage.

Why not upgrade everything to Sonnet? It costs 3× more, runs 1.8× slower, and at the strict gate (`confirmed` only) its recall drops to 64% — an unnecessary trade when Haiku already delivers 0% false-confirm. Sonnet's advantage appears only if the gate is loosened to accept `partial`, and the right response is to tighten the gate, not to pay for Sonnet.

The original pre-registered red-line from QUA-635 ("upgrade to Sonnet if false-confirm rate >10%") is never triggered — Haiku is already at 0%. Sonnet costs 3× more without moving the critical metric.

---

## Context — why calibration matters

QUA-637's defensive invariant:

> No row without (resource + evidence + verdict) atomically. Verdict must be `confirmed` or `partial` to pass the `/api/enrichment/propose` gate. `unverifiable`/`contradicted` causes rejection.

This hinges on the verdict LLM correctly classifying whether a source supports a claim. If the LLM falsely confirms mismatched claims at >10%, the defensive gate ships bad data confidently — the single highest-risk failure mode in the plan.

QUA-635 is the pre-registered calibration gate on this risk.

## Methodology

### Corpus construction (`crux/calibration/build-corpus.ts`)

100 items, stratified across the three record types most relevant to the burst:

| Record type | Known-true | Known-false | Total |
|---|---:|---:|---:|
| personnel | 20 | 20 | 40 |
| publication | 15 | 15 | 30 |
| funding-round | 15 | 15 | 30 |
| **Total** | **50** | **50** | **100** |

**Known-true** (N=50): Sampled from prod `source_check_verdicts` where `verdict = 'confirmed'` (9,560 total qualifying rows). For each, the matching evidence row provided the `sourceUrl`, and the actual record row (personnel/publication/funding-round) provided the `fields` that feed the prompt. Items were filtered to those whose source URL was still cached in `citation_content` with ≥400 chars of text.

**Known-false** (N=50): Constructed by mutating one field of the corresponding known-true item in a way the source cannot possibly support, then keeping the same `sourceUrl`:

- **personnel**: swapped `role` to a clearly different title (e.g. "James C. Gaither Junior Fellow" → "Chief Executive Officer")
- **publication**: replaced `authors` with well-known AI-safety researchers not on the paper ("Edward Geist, Andrew J. Lohn" → "Geoffrey Hinton, Yoshua Bengio")
- **funding-round**: inflated `raised` by 10× ($6.6B → $66B)

These are conservative mutations: the rest of the record still matches the source, so the LLM is tested on its ability to flag the *specific* wrong field. This is the exact shape the defensive gate must catch in the T2/T3 paths of the burst.

### Prompt

Both models were called with the **exact production prompt** — `buildRecordSourcingPrompt()` from `crux/lib/sourcing/item-verifier.ts`, including the full `SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES` block. No prompt changes between models. `max_tokens=500`, `temperature=0`. Same source text fetched via the same `fetchSourceContent()` function production uses.

### Metrics

- **False-confirm (strict)** = `known-false with verdict='confirmed'` / `known-false total`. This is the headline defensive-gate failure metric.
- **False-pass (loose)** = `known-false with verdict ∈ {'confirmed','partial'}` / `known-false total`. Relevant because QUA-637's defensive invariant accepts both as passing the gate.
- **Recall (strict)** = `known-true with verdict='confirmed'` / `known-true total`. Under-verification reduces burst throughput.
- **Quote fidelity** = fraction of known-true items where the LLM's `extracted_value` contained a substring of length ≥40 characters appearing verbatim in the source text (normalized for whitespace/case). A paraphrase counts as a miss. This is a lower-bound proxy for the stricter "quoted-supporting-text" requirement.

## Results

### Headline metrics

See the TL;DR table above. Two critical findings:

1. **Haiku's false-confirm rate is 0.0%**. Neither model ever marked a known-false item as `confirmed`. This is well under the pre-registered 10% red-line.
2. **Under strict-gate (confirmed only), Haiku has higher recall than Sonnet (92% vs 64%)**. Sonnet is much more conservative, routing 30% of true items to `partial` rather than `confirmed`.

### Verdict distribution

Haiku:

```
known-true  (N=50):  confirmed=46, partial=3, error=1
known-false (N=50):  contradicted=48, partial=2, confirmed=0
```

Sonnet:

```
known-true  (N=50):  confirmed=32, partial=15, contradicted=3
known-false (N=50):  contradicted=50
```

### Per-type breakdown

Known-true confirmation rates (higher is better — this is recall):

| Type | Haiku | Sonnet |
|---|---:|---:|
| personnel | 18/20 (90.0%) | 13/20 (65.0%) |
| publication | 14/15 (93.3%) | 7/15 (46.7%) |
| funding-round | 14/15 (93.3%) | 12/15 (80.0%) |

Known-false false-confirm rates (lower is better):

| Type | Haiku | Sonnet |
|---|---:|---:|
| personnel | 0/20 (0.0%) | 0/20 (0.0%) |
| publication | 0/15 (0.0%) | 0/15 (0.0%) |
| funding-round | 0/15 (0.0%) | 0/15 (0.0%) |

### Inter-model agreement

82.8% (83/100). 17 disagreements, broken down:

| Pattern | Count | Interpretation |
|---|---:|---|
| true: haiku=confirmed, sonnet=partial | 13 | Sonnet nitpicks (date precision, sub-program names, title abbreviations) |
| false: haiku=partial, sonnet=contradicted | 2 | Sonnet correctly tightens publications where authors were wrong but other fields right |
| true: haiku=partial, sonnet=contradicted | 1 | Pedantic disagreement over "Technology and International Affairs Program" vs "AI Program" |
| true: haiku=confirmed, sonnet=contradicted | 1 | Sonnet rejects "AI" vs "Artificial Intelligence" as a mismatch (against the equivalence guidelines) |

## Failure-mode analysis

### Haiku: 2 known-false marked `partial` instead of `contradicted`

Both are publication items where `authors` was swapped to "Geoffrey Hinton, Yoshua Bengio" but title, date, venue were left correct. Haiku's reasoning (paraphrased):

> "The title and publication date are confirmed. However, the authors field is incomplete and inaccurate… The record's author attribution is fundamentally incorrect."

Haiku correctly identifies the authorship is wrong but softens the overall verdict to `partial` because other fields match. Under the **strict gate** (`confirmed` only) these items are correctly rejected. Under the **loose gate** (`confirmed ∪ partial`), these slip through — 2/50 = 4% false-pass rate on known-false.

**Remedy:** Adopt the strict gate rule described in the recommendation.

### Sonnet: 3 known-true marked `contradicted`

Each warrants separate discussion — 1 of the 3 is actually correct.

1. **"AI Program" vs "Technology and International Affairs Program"** (personnel): Sonnet rejects because the source says "Technology and International Affairs Program", not "AI Program". Pedantic-but-fair — the record's `organization` field does name-match the Carnegie Endowment sub-program ID incorrectly. Haiku labeled it `partial`.

2. **Title "Military Applications of AI" vs "Military Applications of Artificial Intelligence"** (publication): Sonnet marks this `contradicted` despite the equivalence rule in `SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES` covering abbreviation equivalence for numbers/URLs/dates (but not words). This is a **Sonnet false-negative against the spirit of the prompt guidelines**. Haiku correctly uses `confirmed`.

3. **Access Now McGovern Grant 2024 vs 2022** (funding-round): Sonnet caught a real data bug — the record says 2024, the source clearly says 2022. Our "known-true" set had at least one genuinely wrong row. Sonnet's `contradicted` verdict here is **actually correct**, and Haiku errored on JSON parsing (probably due to the `max_tokens=500` ceiling being too tight for the reasoning).

So of the 3 Sonnet "false rejections": 1 pedantic, 1 over-strict against guidelines, 1 genuinely correct. Sonnet's effective recall on a clean corpus would be ~66% strict / ~96% loose.

### Haiku: 1 JSON parse error

The Access Now funding-round case. Haiku's reasoning exceeded the 500-token output cap, producing truncated JSON. Affects 1/100 = 1% — non-negligible at scale.

**Remedy:** Bump `max_tokens` from 500 → 800 in the verdict-LLM call (minor cost increase, catches long-reasoning cases).

## Quote fidelity — implications

Verbatim ≥40-char substring match rate:

| | Haiku | Sonnet |
|---|---:|---:|
| Known-true | 75.5% | 78.0% |
| Known-false | 60.0% | 68.0% |

Both models paraphrase ~25% of the time on true items rather than quoting verbatim. The current `extracted_value` field in the prompt guidelines allows "quote OR paraphrase" — so these are not prompt violations, just a limitation if the goal is verbatim evidence.

**Remedy:** Augment the verdict-LLM response schema with a dedicated `quoted_text` field that must be verbatim (length >0 on `confirmed`/`partial` verdicts). Production can then gate on `quoted_text` being a substring of source content as an additional programmatic safety check. This is a concrete prompt upgrade to queue for Phase 1 of QUA-637 — not blocking the de-risk itself.

## Cost analysis for the burst

Per QUA-637's burst shape:

| Tier | Est. rows | Verdict LLM? | Haiku cost | Sonnet cost | Sonnet delta |
|---|---:|---|---:|---:|---:|
| T1 authoritative | 2500-3000 | No (implicit) | $0 | $0 | $0 |
| T2 grounded fetch | 1500-2000 | Yes | $6.75 – $9 | $20.55 – $27.40 | +$13.80 – +$18.40 |
| T3 open-web research | 500-1000 | Yes | $2.25 – $4.50 | $6.85 – $13.70 | +$4.60 – +$9.20 |
| **Total verdict-LLM** | ~2000-3000 | | **~$9 – $14** | **~$27 – $41** | **+$18 – +$27** |

In the $1000 burst envelope (with $150-300 earmarked for verdict LLM), both models fit comfortably. Haiku's $9-14 leaves $135-$280 headroom for retries/recalibration; Sonnet consumes about 2× of the earmark.

At the strict-gate Haiku recommendation, the `partial` triage queue is a separate small-N cost: ~8-15% of rows flag `partial`. Routing those to Sonnet-with-rerun costs ~$1-3 extra — still far below Sonnet-for-everything.

## Recommendation

### Primary: Haiku 4.5 + strict gate

- Model: `claude-haiku-4-5-20251001` (the current production checker)
- Gate: accept **only** `verdict === 'confirmed'`
- `partial`, `unverifiable`, `contradicted`, `outdated` all reject at `/api/enrichment/propose`
- Expected burst metrics: 92% acceptance on true claims, 0% false-confirm, ~$9-14 verdict-LLM spend
- No production code changes needed for the gate itself; this is purely a server-side policy decision in the `propose` endpoint

### Secondary: Sonnet fallback for partials

- Route every `partial` or `unverifiable` verdict from Haiku into a **second-pass queue** handled by Sonnet with the same prompt
- Accept the row if Sonnet returns `confirmed` or `partial` (with stricter confidence floor, e.g. ≥0.85)
- This keeps the overall recall ≥94% (close to Haiku-loose) while keeping the first-pass gate at 0% false-confirm
- Projected additional cost: ~$3-6 for the T2/T3 burst

### Tertiary: prompt hygiene updates (queue for QUA-637 Phase 1 implementation)

1. **Bump `max_tokens` from 500 → 800** in the verdict LLM call to eliminate JSON-truncation errors on long reasoning. Marginal cost increase (<5%).
2. **Add a `quoted_text` field** to the response schema that must be non-empty on `confirmed`/`partial` verdicts, AND must be a verbatim substring of the source content. Programmatic post-check. This takes the quote-fidelity floor from ~75% paraphrase-or-quote to 100% verbatim-or-reject.
3. **Expand the equivalence-guideline block** to cover abbreviation equivalence for words ("AI" ≡ "Artificial Intelligence"), not just numeric/URL/date formats. Addresses the Sonnet over-strict cases and avoids re-introducing them if we fall back to Sonnet.

### Known limitations of this calibration

- **Corpus size (100 items)** — adequate to measure ~1-5% effects, not 0.1% tail risks. Running a 1000-item calibration at end of Week 1 burst would harden the 0% false-confirm finding.
- **Mutations are coarse** (role-swap, author-swap, 10× amount). Subtler mutations (off-by-one dates, wrong year, partial-affiliation) weren't tested. The production defensive gate will see those in the T2/T3 traffic — flag in the post-burst retrospective if false-confirm > 2% on organic data.
- **Ground truth had at least one real error** (the Access Now 2024/2022 grant). Sonnet's rejection caught it. The calibration scored this as a Sonnet miss, inflating Sonnet's false-negative rate. Actual Sonnet-strict recall on a clean corpus is ~66%, not 64%.
- **Known-false items share the source URL of their known-true parent.** A real-world bad row proposed by an LLM researcher might have a completely wrong `sourceUrl` — which should be caught upstream (by relevance gate + fetch) and not load this calibration's results. Worth monitoring.
- **Wayback fallback kicked in for one URL** (`websets.exa.ai/.../futuresearch-executives`). All verdicts on that URL used the 2025-12-11 snapshot, not live content. Mirrors production behavior but means the test isn't purely "live source supports claim".

## What to do next

- [ ] Land this doc + the calibration scripts in `crux/calibration/` (this PR)
- [ ] Post the TL;DR + recommendation as a comment on QUA-635 and link from QUA-637
- [ ] Schedule the `quoted_text` + `max_tokens` prompt upgrades as a Phase 1 sub-task of QUA-637 — do NOT ship burst on the current prompt without at least the `max_tokens` bump (1% JSON-truncation rate would be ~20-30 lost verdicts in a 2000-3000 row burst)
- [ ] Commit the corpus JSON (100 items) to the repo so re-runs can reproduce the result after any prompt changes
- [ ] After Phase 3 of the burst, re-run the calibration on fresh 100-item sample of organic verdicts — guards against model drift over the burst window
