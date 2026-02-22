# Hallucination Detection Evals

Design document for systematic hallucination detection evals and adversarial hunting agents.

## Status: DESIGN PHASE — For Review

---

## Problem Statement

The wiki has ~625 AI-generated pages. We have strong infrastructure for *scoring* risk
(hallucination-risk.ts), *verifying* citations (citation-auditor.ts), and *reviewing* content
(adversarial-review.ts). But we lack systematic **evals** that measure whether our detectors
actually catch known errors, and we lack **adversarial agents** that proactively hunt for
hallucinations across the existing corpus.

Two complementary needs:

1. **Evals** — Controlled experiments with known ground truth. "We planted 20 errors; did our
   system find them?"
2. **Adversarial agents** — Autonomous hunters that crawl the real wiki looking for problems,
   including checking references, cross-referencing claims, and flagging suspicious patterns.

---

## Part 1: Eval Framework

### 1A. Synthetic Error Injection Evals

**Idea:** Take real, high-quality pages. Programmatically inject known errors. Run our
detection systems. Measure recall (did we catch them?) and precision (did we flag non-errors?).

**Error types to inject:**

| Error Type | Injection Method | Detector Under Test |
|---|---|---|
| **Wrong numbers** | Change founding year, funding amount, staff count by ±10-50% | adversarial-review (fact density), citation-auditor |
| **Wrong attribution** | Swap who said/did something between two people | citation-auditor (misattributed), adversarial-review (speculation) |
| **Fabricated citations** | Replace real URLs with plausible-looking fake ones | citation-auditor (url-dead), content-integrity (sequential arxiv) |
| **Fabricated claims** | Add a realistic-sounding but false sentence with a real citation that doesn't support it | citation-auditor (unsupported/misattributed) |
| **Temporal errors** | Move events to wrong year, swap chronological order | adversarial-review (fact density) |
| **Exaggerated claims** | "50 employees" → "500 employees", "contributed to" → "led" | citation-auditor, grading (rigor) |
| **Missing nuance** | Remove hedging: "may contribute to" → "causes" | adversarial-review (speculation) |
| **Entity confusion** | Swap details between two similar orgs/people | cross-reference checker (new) |

**Implementation plan:**

```
crux/evals/
  fixtures/                     # Golden pages (real pages, frozen as ground truth)
  injectors/                    # Error injection functions
    inject-wrong-numbers.ts
    inject-wrong-attribution.ts
    inject-fabricated-citations.ts
    inject-fabricated-claims.ts
    inject-temporal-errors.ts
    inject-exaggeration.ts
    inject-missing-nuance.ts
    inject-entity-confusion.ts
  harness.ts                    # Eval runner: inject → detect → score
  score.ts                      # Precision/recall/F1 computation
  run-evals.ts                  # CLI entry point
  results/                      # Eval run outputs (gitignored)
```

**Eval flow:**
1. Select N golden pages (well-cited, human-reviewed, high-quality)
2. For each page × each error type:
   a. Inject 1-3 errors (record exact locations + error descriptions)
   b. Run detection pipeline (citation-auditor, adversarial-review, hallucination-risk, content-integrity)
   c. Check if injected errors were caught (location matching within ±2 paragraphs)
   d. Record hits, misses, and false positives
3. Aggregate: recall per error type, per detector, overall

**Key design decisions:**
- Injections must be *realistic* — an LLM generates the corrupted text, not simple string replacement
- Each injection records a `ErrorManifest` with exact location, error type, original text, corrupted text
- Scoring uses fuzzy matching (detector doesn't need to quote exact text, just flag the right area)
- Golden pages should span entity types: person, org, risk, concept, event, model

### 1B. Fake Entity Evals

**Idea:** Ask the content creation pipeline to research a completely fictional entity. A good
system should come back empty or flag uncertainty. A hallucinating system will confabulate
a detailed page.

**Test cases:**

| Fake Entity | Type | Why It's a Good Test |
|---|---|---|
| "Prometheus AI Safety Institute" | organization | Plausible name, doesn't exist |
| "Dr. Sarah Chen-Nakamura" | person | Plausible AI safety researcher name |
| "The Alignment Tax Paradox" | concept | Sounds like a real alignment concept |
| "GPT-7 Incident (2025)" | event | Plausible but fictional |
| "Recursive Reward Modeling Collapse" | risk | Sounds technically plausible |

**What to measure:**
- Does the research phase return empty/low-confidence results?
- Does the pipeline refuse to generate a page or flag high uncertainty?
- If it does generate content, how much is fabricated vs. hedged?
- Does the citation-auditor catch that citations don't support claims?

**Implementation:**
```typescript
// crux/evals/fake-entity-eval.ts
interface FakeEntityTestCase {
  name: string;
  entityType: string;
  description: string;  // brief description to feed the pipeline
  expectedOutcome: 'refuse' | 'empty-research' | 'high-uncertainty';
}

// Run: pnpm crux evals fake-entity --case="prometheus-ai-safety-institute"
// Measures: research hit rate, confidence signals, fabrication density
```

### 1C. Cross-Reference Consistency Evals

**Idea:** Many pages reference the same facts (e.g., Anthropic's founding date, MIRI's
funding). Extract these shared claims and check for internal consistency.

**Implementation:**
- Query wiki-server for entities referenced by 3+ pages
- For each shared entity, extract factual claims from each mentioning page
- Compare claims across pages — flag contradictions
- This doubles as both an eval (known contradictions we planted) and a real detector

### 1D. Citation Round-Trip Evals

**Idea:** For pages with citations, fetch the cited source, extract what it *actually* says,
then compare against what the wiki claims it says. This is essentially what citation-auditor
does, but as a systematic eval:

- Take 50 pages with the most citations
- Run full citation audit
- Manually review a sample of verdicts (is "verified" really verified? is "unsupported" really unsupported?)
- Compute auditor accuracy: what % of its verdicts are correct?

This measures **the auditor itself** — a meta-eval.

---

## Part 2: Adversarial Hunting Agents

### 2A. Reference Sniffing Agent

**Purpose:** Crawl every page's references/citations, fetch the actual sources, and check
whether the wiki's claims are actually supported.

**How it differs from citation-auditor:** The auditor checks "does this source mention this
claim?" The sniffing agent goes deeper:

- **Quote accuracy**: Does the exact quote appear in the source? (Not just topic match)
- **Context checking**: Is the claim taken out of context? (Source says X in a specific context, wiki generalizes)
- **Recency**: Is the source outdated? (Citing a 2020 paper for a 2025 claim)
- **Source quality**: Is this a primary source, secondary, blog post, or social media?
- **Circular citations**: Does source A cite source B which cites our wiki?

```
crux/evals/agents/
  reference-sniffer.ts          # Deep citation verification agent
  claim-extractor.ts            # Extract discrete claims from prose
  cross-reference-checker.ts    # Check claims across pages
  description-auditor.ts        # Audit entity descriptions & metadata
  temporal-consistency.ts       # Check date/timeline claims
  agent-runner.ts               # Orchestrator
```

**Output:** Per-page report with confidence-scored findings:
```typescript
interface SnifferFinding {
  pageId: string;
  paragraph: number;
  claim: string;
  severity: 'critical' | 'warning' | 'info';
  category: 'unsupported' | 'misattributed' | 'out-of-context' | 'outdated' | 'circular';
  evidence: string;       // what the source actually says
  suggestion: string;     // proposed fix
}
```

### 2B. Description & Metadata Auditor

**Purpose:** Audit the YAML entity descriptions, frontmatter summaries, and sidebar
descriptions that users see first. These are high-visibility, low-citation areas where
hallucinations hide.

**What to check:**
- `data/entities/*.yaml` — `description` fields for each entity
- MDX frontmatter `description` fields
- "Overview" sections (first 2-3 paragraphs of each page)
- Table/chart data (numbers in tables vs. numbers in prose)

**Method:**
1. Extract all entity descriptions from YAML
2. For each, search the web for the real entity
3. Compare our description against 2-3 authoritative sources
4. Flag discrepancies: wrong dates, wrong roles, wrong affiliations, inflated claims

### 2C. Temporal Consistency Agent

**Purpose:** Check that dates and timelines are internally consistent and externally accurate.

**Checks:**
- Founding dates match across entity YAML, page frontmatter, and prose
- Event timelines are chronologically valid (cause before effect)
- "Current" claims are actually current (not stale from page creation date)
- Historical projections in `/history/` pages are framed as such, not as current facts

### 2D. Numeric Fact Verifier

**Purpose:** Extract all numeric claims (funding amounts, employee counts, publication counts,
dates) and verify them against authoritative sources.

**Method:**
1. Use `data/facts/*.yaml` as ground truth where available
2. Cross-reference numeric claims in prose against fact YAML
3. For claims not in facts YAML, web-search for authoritative source
4. Flag: prose says "$100M funding" but fact YAML says "$50M"

### 2E. Full Adversarial Sweep Agent

**Purpose:** An orchestrator that runs all the above agents in a coordinated sweep across
the wiki, prioritizing high-risk pages.

```bash
# Run full adversarial sweep
pnpm crux evals adversarial-sweep --budget=50 --top=100

# Run specific agent
pnpm crux evals adversarial-sweep --agent=reference-sniffer --top=20

# Run on specific page
pnpm crux evals adversarial-sweep --page=anthropic
```

**Priority ordering:**
1. Pages with hallucination risk score > 60 (high)
2. Pages with no human review
3. Pages with low citation density
4. Pages with most external traffic / highest importance score
5. Recently auto-updated pages

---

## Part 3: Integration Plan

### New CLI Commands

```bash
# Eval commands
pnpm crux evals inject <page-id> --errors=3    # Inject errors into a golden page
pnpm crux evals run --suite=injection           # Run injection eval suite
pnpm crux evals run --suite=fake-entity         # Run fake entity eval suite
pnpm crux evals run --suite=citation-roundtrip  # Run citation round-trip eval
pnpm crux evals run --suite=all                 # Run everything
pnpm crux evals report                          # Show latest eval results
pnpm crux evals report --compare                # Compare with previous run

# Adversarial agent commands
pnpm crux evals hunt --agent=reference-sniffer --top=20
pnpm crux evals hunt --agent=description-auditor --all
pnpm crux evals hunt --agent=temporal-consistency --top=50
pnpm crux evals hunt --agent=numeric-verifier --top=50
pnpm crux evals hunt --sweep --budget=50

# Dashboard
/internal/hallucination-evals  — eval results over time, per-detector performance
```

### Dashboard Page

New internal dashboard at `/internal/hallucination-evals`:
- Eval suite results over time (recall/precision trends)
- Per-detector performance breakdown
- Adversarial sweep findings (severity distribution, category breakdown)
- Pages needing attention (ranked by finding severity)

### CI Integration

- Run lightweight injection evals on every PR that touches crux/lib/hallucination-risk.ts,
  citation-auditor.ts, or content-integrity.ts
- Full eval suite runs weekly via GitHub Actions
- Adversarial sweep runs monthly (budget-capped)

---

## Part 4: Prioritized Implementation Order

### Phase 1: Foundation (this session)
1. Create `crux/evals/` directory structure
2. Implement error injection framework with 2-3 error types
3. Implement eval harness (inject → detect → score)
4. Create 5 golden page fixtures
5. Wire up `pnpm crux evals run --suite=injection`

### Phase 2: Fake Entity Evals
6. Implement fake entity test cases
7. Measure research pipeline's resistance to confabulation
8. Add `--suite=fake-entity` to eval runner

### Phase 3: Adversarial Agents
9. Reference sniffer agent (deep citation verification)
10. Description auditor (entity YAML + frontmatter checking)
11. Orchestrator for coordinated sweeps

### Phase 4: Dashboard & CI
12. Internal dashboard page
13. CI integration for regression detection
14. Weekly/monthly scheduled runs

---

## Open Questions

1. **LLM cost budget**: Evals that call LLMs (citation-auditor, adversarial-review) cost money.
   What's an acceptable per-run budget? Suggest: injection evals ~$2-5, fake entity ~$5-10,
   full adversarial sweep ~$30-50.

2. **Golden page selection**: Which pages are trustworthy enough to be ground truth? Candidates:
   human-reviewed pages with high citation density and low risk scores.

3. **Eval frequency**: How often should evals run? Suggestion: injection evals on every PR
   touching detectors, full suite weekly, adversarial sweep monthly.

4. **Finding triage**: When adversarial agents find potential hallucinations in real pages,
   what's the workflow? Auto-create issues? Flag for human review? Auto-fix?
