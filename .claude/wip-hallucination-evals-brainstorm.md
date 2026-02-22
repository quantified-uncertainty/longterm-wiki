# Hallucination Evaluation & Adversarial Testing Brainstorm
*Date: 2026-02-22*
*Branch: claude/hallucination-eval-tests-1JLRf*

## Overview

This document proposes two complementary strategies to improve hallucination detection in Longterm Wiki:

1. **Synthetic Evals** — Deliberately inject hallucinations into test pages to verify our detection systems catch them
2. **Adversarial Agents** — Proactive agents that hunt through pages and citations looking for hallucinations

## Current State

The wiki already has:
- **Hallucination risk scorer** (20+ factors, 0-100 scale) in `/crux/lib/hallucination-risk.ts`
- **Citation archive & verification** (URL fetch + status tracking)
- **Citation auditor** (LLM-based claim verification)
- **48 validation rules** (6 blocking CI gates)
- **Adversarial review phase** in page improvement pipeline
- **Content integrity checks** (truncation, fabrication signals, duplicates)

## Part 1: Synthetic Evals (Fault Injection)

### 1.1 Synthetic Pages with Known Errors

**Location:** `/data/evals/synthetic-pages/` (new directory)

Each test case contains:
- Good version (template)
- Injected errors version (ground truth hallucinations)
- Expected detection results

#### Tier 1.1a: Biographical Hallucinations

Create 2-3 synthetic person pages per category with plausible-sounding fabrications:

**Example: Synthetic Einstein Variant**
```
id: synthetic-einstein-v2
Birth date: ✓ March 14, 1879
Nobel Prize date: ✗ 1908 (actually 1921)
Institute directorship: ✗ 40 years (actually ~16 years, 1917-1933)
Death year: ✓ 1955
```

**Expected detections:**
- `unsourced-biographical-claims` rule fires (zero citations for factual claims)
- `hallucination-risk` scorer penalizes heavily (specific facts + no citations)
- `citation-auditor` would flag inaccuracy (if fake citations added)

**Additional examples to create:**
- Person: startup founder with fabricated funding round, wrong PhD university, award date shifted 5 years
- Organization: founding date off by 5 years, CEO tenure wrong, headquarters city incorrect, fictional subsidiary
- Event/Incident: casualty count fabricated, date shifted, involved parties exaggerated

#### Tier 1.1b: Citation Forgeries

Create pages with fake footnotes pointing to real but irrelevant URLs:

```
Claim: "GPT-5 has passed the Bar exam with 99% accuracy"
Citation: https://www.wikipedia.org/wiki/Artificial_intelligence
Problem: Valid URL but unrelated to specific claim
```

**Expected detection:**
- `citation-auditor` with `fetchMissing=true` flags as "misattributed"
- Human reviewing citation snippet notices mismatch

**Variations:**
- Valid URL but content changed since citation (quote drift detection)
- URL predates the claim (citing 2015 paper for 2024 event)
- Footnote format malformed but parseable

#### Tier 1.1c: Orphaned & Fabricated Footnotes

Create pages with internal truncation signals:
- References `[^5]` but no corresponding footnote definition
- Pattern: missing ~60% of footnote definitions
- File ends abruptly after "Key achievements:"

**Expected detection:**
- `content-integrity.ts` flags "severe truncation" (>50% orphaned)
- Risk scorer penalizes for content quality issues

#### Tier 1.1d: Semantic Hallucinations & Contradictions

Create pages with internally inconsistent claims that don't require external sources:

```
Contradiction: "Founded with $2M seed" vs "Raised $500K in angel funding (not the $2M)"
Timeline violation: "2017: First customer signed" (before "2018: Company founded")
```

**Expected detection:**
- New `factual-consistency` rule catches internal contradictions
- Cross-page inconsistency detector flags later

### 1.2 Fact Assertion Evals

Add synthetic facts to `/data/facts/synthetic-facts.yaml`:

```yaml
facts:
  - id: synthetic-founding-year-wrong
    entity_id: openai
    fact_type: founded
    value: "2016"  # Actually 2015
    confidence: "high"
    source: "synthetic"
```

**Validation:** `factual-consistency` rule checks page claims against facts.yaml

### 1.3 Research Requests on Non-Existent Entities

Create eval to test "graceful empty results":

```bash
pnpm crux content create "FakeCompany Industries (Fictional)" \
  --tier=budget --test-mode
```

**Expected behavior:**
- Returns "no reliable sources found"
- Does NOT fabricate funding rounds, team members, etc.
- Creates stub with explicit "sources unavailable" notice
- Risk score automatically high (no citations, stub size)

### 1.4 Synthetic Eval Harness

Create `/crux/evals/` framework:

```bash
pnpm crux evals run-synthetic           # Run all evals
pnpm crux evals run-synthetic --category=biographical
pnpm crux evals run-synthetic --verbose # Per-hallucination results
```

**Metrics computed:**
- Precision: TP / (TP + FP)
- Recall: TP / (TP + FN)
- F1 score
- Per-adversary breakdown: which agents catch which hallucinations?

---

## Part 2: Adversarial Agents (Hallucination Hunters)

### 2.1 Fact Grounding Adversary

**Purpose:** Extract specific factual claims and probe them for citation support

**Approach:**
1. Extract all specific factual claims (dates, names, numbers, awards, positions)
2. Filter out general statements
3. For each claim, find nearest citation
4. Fetch citation URL (from archive cache)
5. LLM check: "Is this claim supported by this source?"
6. Output ranked by hallucination confidence

**Output format:**
```
🔴 High hallucination risk:
├─ "Nobel Prize in 1908" → cited Wikipedia, says 1921
│  ├─ Verdict: MISATTRIBUTED
│  └─ Confidence: 0.95
```

**Integration:**
```bash
pnpm crux adversarial fact-grounding <page-id>
pnpm crux adversarial fact-grounding --all --limit=20
```

### 2.2 Reference Material Jailbreak Tester

**Purpose:** Probe whether citations themselves contain hallucinations or unreliable content

**Checks:**
- Domain authority assessment (blog vs. peer-reviewed)
- Editorial vs. factual content detection
- Marketing material flagging
- Paywalling (claims behind paywall can't be verified)
- Timeliness (20-year-old source for AI field outdated)
- Quote drift (is cited quote still in source after refetch?)

**Output:**
```
🔴 High-risk citations:
├─ https://myblog.wordpress.com/ — EDITORIAL OPINION
├─ https://openai.com/research/ — MARKETING MATERIAL (biased)
```

**Integration:**
```bash
pnpm crux adversarial reference-jailbreak <page-id>
pnpm crux adversarial reference-jailbreak --all --limit=50
```

### 2.3 Cross-Page Inconsistency Hunter

**Purpose:** Find contradictions between related pages (person & org, shared entities)

**Approach:**
1. Cluster pages by entity (all pages mentioning "Anthropic")
2. Extract facts from frontmatter + body
3. Compare claims across pages
4. Semantic drift detection (±1 year acceptable, ±5 is suspicious)
5. Rank by confidence of hallucination

**Example:**
```
Anthropic founding year:
  /org/anthropic: "2021" (cited)
  /people/dario-amodei: "2020" (no citation)
→ Trust /org (better sourced)
```

**Integration:**
```bash
pnpm crux adversarial cross-page-check
pnpm crux adversarial cross-page-check --entity=anthropic
pnpm crux adversarial cross-page-check --conflicts-only
```

### 2.4 Claim Extraction & Frequency Analysis

**Purpose:** Extract all factual claims across wiki, rank by confidence

**Approach:**
1. Extract ~5-10 claims per page (LLM)
2. Normalize variants ("founded 2020" = "est. 2020" = "launched 2020")
3. Count occurrences across pages
4. Find outliers: "Company has 5K employees" (1 page) vs. "10K" (3 pages)
5. Detect source duplication (did page B copy from page A?)

**Confidence levels:**
```
🟢 High: "OpenAI founded 2015" (8 pages agree)
🟡 Medium: "MIRI budget ~$5M" (2 pages, both cited)
🔴 Low: "Company raised $500M Series D" (1 page, no citation)
```

**Integration:**
```bash
pnpm crux adversarial claim-frequency-analysis
pnpm crux adversarial claim-frequency-analysis --threshold=low
pnpm crux adversarial claim-frequency-analysis --contradictions-only
```

### 2.5 Temporal Consistency Auditor

**Purpose:** Find temporal logic errors, timeline violations, impossible sequences

**Checks:**
- Causality violations (event B at 2015 depends on event A at 2020)
- Duration impossibilities ("CEO for 60 years")
- Age math errors ("born 1950, age in 1945")
- Recency inconsistencies ("shut down 2019" vs. "operating 2020")
- Anachronisms ("East Germany office 1995-2010")

**Example detection:**
```
Violation: "Won Nobel Prize 1908" but Nobel actually 1921
→ Hallucination: Nobel date is wrong
```

**Integration:**
```bash
pnpm crux adversarial temporal-consistency <page-id>
pnpm crux adversarial temporal-consistency --all
```

### 2.6 Confidence Calibration Checker

**Purpose:** Find overconfident claims on uncertain topics

**Approach:**
1. Extract claims + confidence markers ("will", "likely", "might", "could")
2. Category-based uncertainty assessment (AI capabilities > historical facts)
3. LLM assessment: "How confident should we be?"
4. Flag overconfidence/underconfidence

**Example:**
```
Claim: "GPT-5 will surpass human intelligence by 2027"
Expressed: CERTAIN ("will")
Actual: HIGH uncertainty (0.2)
Recommendation: Change to "might", "could"
```

**Integration:**
```bash
pnpm crux adversarial confidence-calibration <page-id>
```

---

## Part 3: Integration & Workflow

### CLI Command Family

```bash
# Single adversary on a page
pnpm crux adversarial fact-grounding <page-id>
pnpm crux adversarial reference-jailbreak <page-id>
pnpm crux adversarial temporal-consistency <page-id>

# All adversaries on a page
pnpm crux adversarial full-audit <page-id>

# Batch on high-risk pages
pnpm crux adversarial hunt --risk=high --limit=20
pnpm crux adversarial hunt --all-pages
pnpm crux adversarial hunt --entity=anthropic

# Dashboard
pnpm crux adversarial dashboard --output=/app/internal/adversarial-hunt
pnpm crux adversarial dashboard --export=csv
```

### Dashboard: `/internal/adversarial-hunt`

Real-time display of all adversarial findings:
- Summary stats (total findings, high-confidence hallucinations)
- Top high-confidence findings (ranked by severity)
- Expandable details for each finding
- Quick actions: [FIX], [IGNORE], [INVESTIGATE], [MORE INFO]

---

## Part 4: Quick Wins (Start Here)

Minimal-infrastructure items to implement first:

1. **Fact Grounding Adversary** (2-3 hrs)
   - Reuse existing `citation-auditor.ts`
   - Add claim extraction
   - Output grounded/ungrounded verdicts

2. **Cross-Page Inconsistency Hunter** (2-3 hrs)
   - Query wiki-server for related pages
   - Extract facts from frontmatter
   - Simple comparison

3. **Synthetic Biographical Pages** (1-2 hrs)
   - Write 5-10 MDX pages with known errors
   - Store in `/data/evals/synthetic-pages/`
   - Manually verify they're caught

4. **Temporal Consistency Rule** (1-2 hrs)
   - Regex-based date extraction
   - Causality validation
   - Add to validation suite

5. **Synthetic Eval Harness** (2-3 hrs)
   - Load evals from `/data/evals/`
   - Run full validation pipeline
   - Compute precision/recall/F1 metrics

---

## Part 5: Acceptance Criteria

After implementation, verify:

- [ ] All 6 synthetic eval categories have ≥3 test cases
- [ ] Synthetic evals achieve ≥80% detection rate (precision & recall)
- [ ] Fact grounding adversary runs in <30s on a typical page
- [ ] Cross-page inconsistency detector catches contradictions on ≥5 real page pairs
- [ ] Temporal auditor catches ≥3 real timeline errors in current wiki
- [ ] Dashboard loads all findings in <5s
- [ ] CI integration: `pnpm crux evals run-synthetic` passes in <2 minutes

---

## Notes & Decisions

- **Priority order:** Synthetic evals first (safer), then adversarial agents (higher risk of false positives)
- **False positives:** Prioritize precision over recall initially (better to miss some issues than flag false positives)
- **Iteration:** Start with simple string matching, graduate to LLM-based checks
- **No rewriting:** Adversarial agents report findings but don't auto-fix (human review required)
