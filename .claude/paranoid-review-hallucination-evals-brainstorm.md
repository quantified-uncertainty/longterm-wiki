# PARANOID REVIEW: Hallucination Evals & Adversarial Testing Brainstorm

**Reviewer:** Claude (paranoid mode)
**Date:** 2026-02-22
**Document:** `.claude/wip-hallucination-evals-brainstorm.md`
**Status:** GOOD IDEAS with CRITICAL ISSUES requiring clarification

---

## 🔴 CRITICAL ISSUES (Block Implementation)

### Issue 1: Synthetic Facts Would Leak to Production
**Location:** Section 1.2 "Fact Assertion Evals"
**Problem:** Document proposes creating `/data/facts/synthetic-facts.yaml` with test data.
**Why it's bad:**
- `apps/web/scripts/build-data.mjs` loads ALL files from `data/facts/*.yaml`
- Synthetic facts would be compiled into `database.json` and deployed to production
- Users would see fabricated facts in the wiki (major quality issue)

**Evidence:**
```javascript
// apps/web/scripts/build-data.mjs loads facts with:
// Load canonical facts from src/data/facts/*.yaml
```

**Fix required:**
- Store synthetic facts in `/crux/evals/fixtures/synthetic-facts.yaml` OR
- Store in `/data/evals/synthetic-facts.yaml` + add build-data.mjs filter to exclude `/data/evals/` OR
- Mark synthetic facts with `source: "synthetic-test"` + filter during build OR
- Use temporary/in-memory facts for evals, don't store to YAML

**Recommendation:** Add filter to `build-data.mjs`:
```javascript
// Skip synthetic/test facts during build
if (fact.source === 'synthetic' || fact.source === 'test') continue;
```

---

### Issue 2: test-mode Flag Doesn't Exist on content create
**Location:** Section 1.3 "Research Requests on Non-Existent Entities"
**Problem:** Brainstorm proposes `--test-mode` flag on `pnpm crux content create`.
**Why it's bad:**
- No test-mode flag exists in `crux/authoring/`
- Would require implementation before evals can run
- Adds 1-2 hrs of work not mentioned in "quick wins"

**Evidence:** Grep found zero matches for `test-mode|testMode|test_mode` in crux/authoring/

**Fix required:**
- Add `--test-mode` flag to content creator that:
  - Returns empty search results (simulated)
  - Creates stub page with "sources unavailable" notice
  - Automatically sets risk score to HIGH
- Or: Use different approach (e.g., mock the search API)

**Recommendation:** Add this as a "quick win" or use alternative (mock search service)

---

### Issue 3: Fact Grounding Adversary Integration Unclear
**Location:** Section 2.1, Quick Win #1
**Problem:** Claims fact-grounding can "reuse existing citation-auditor.ts" + 2-3 hrs work
**Why it's unclear:**
- `citation-auditor.ts` has `auditCitations()` for **existing citations**
- Fact-grounding needs **claim extraction** (LLM) + citation linking
- These are different workflows; citation-auditor is ~20% of the work
- Actual effort likely 4-6 hrs, not 2-3 hrs

**Missing:**
- Claim extraction logic (LLM → parse claim text → identify factual vs. opinion)
- Claim-to-citation matching (nearest citation heuristic or semantic search?)
- Performance (LLM call per claim = expensive)

**Recommendation:**
- Revise estimate to 4-6 hrs
- Create separate `claim-extractor.ts` module
- Document LLM API cost implications

---

## 🟡 MAJOR ISSUES (Should Refactor/Clarify)

### Issue 4: CLI Namespace Collision/Architecture
**Location:** Part 3 "Integration & Workflow"
**Problem:** Proposes `pnpm crux adversarial <agent>` commands
**Why it matters:**
- No existing `adversarial` subcommand in crux/commands/
- Would require new `/crux/commands/adversarial.ts`
- Should this live in `/crux/authoring/adversarial/` instead (closer to page-improver)?
- Or is this a new separate concern that belongs in `/crux/commands/`?

**Questions:**
- Will adversarial agents run as standalone CLI? Or embedded in page-improver?
- Do we want `pnpm crux improve --adversarial-hunt` or `pnpm crux adversarial` as top-level?
- Should fact-grounding integrate INTO improve pipeline, or stay separate?

**Recommendation:**
- Clarify architecture: Are these embedded in page workflows, or standalone hunting tools?
- Document where `/crux/commands/adversarial.ts` should live
- Show file structure in implementation plan

---

### Issue 5: Dashboard Deployment Target Unclear
**Location:** Part 3, Section "Dashboard: /internal/adversarial-hunt"
**Problem:** Dashboard location proposed but server-side vs. client-side not specified
**Why it matters:**
- If server-side (wiki-server): Requires data API + postgres tables
- If client-side (Next.js app): Requires static JSON export + loading logic
- Real-time requirement ("Real-time display") suggests server-side
- But wiki-server might not have room for new feature

**Missing:**
- Database schema for adversarial findings
- API endpoints needed
- Whether wiki-server maintains state or just renders findings

**Recommendation:**
- Decision: Server-side (wiki-server) or client-side dashboard?
- If server-side: Add schema + API design to implementation plan
- If client-side: Simplify to "export findings as JSON, load in Next.js"

---

### Issue 6: Wiki-Server API Assumptions Not Verified
**Location:** Cross-page inconsistency hunter (2.3), uses "wiki-server for related pages"
**Problem:** Brainstorm assumes wiki-server can query "all pages mentioning entity X"
**Why it matters:**
- Not clear if this query capability exists
- Might require new API endpoint
- Performance implications (large wiki, many entities)

**Questions:**
- Does wiki-server have `GET /api/pages?entity=anthropic` endpoint?
- Can it efficiently find all pages linking to an entity?
- Is there pagination/rate limiting?

**Recommendation:**
- Verify wiki-server API capabilities before implementation
- Document required endpoints
- Add pagination support for large result sets

---

### Issue 7: Performance Requirements Not Validated
**Location:** Part 5 "Acceptance Criteria"
**Claims made:**
- "Fact grounding adversary runs in <30s on a typical page"
- "Dashboard loads all findings in <5s"

**Why it's risky:**
- Fact grounding uses LLM for EACH claim (not parallel → could be 100+ seconds)
- Dashboard for "all findings" might be 10K+ findings (pagination needed)
- No mention of caching, batch processing, or async jobs

**Recommendation:**
- Validate with benchmarks on real pages
- Add async/batch processing if needed (e.g., background job queue)
- Clarify dashboard paginated vs. full load
- Document expected latency per operation

---

### Issue 8: False Positive / Triage Workflow Missing
**Location:** Throughout brainstorm
**Problem:** No workflow for handling adversarial findings
**What's missing:**
- How do findings get triaged? (e.g., "confirmed hallucination" vs. "false positive")
- Who reviews findings? (automate or human?)
- How do false positives get fed back to improve agents?
- Do findings get tracked in GitHub issues? Or a separate system?

**Why it matters:**
- "No auto-fix" is good, but implies human review workflow
- Need clear SLA: "findings reviewed within X days"
- False positives erode user trust

**Recommendation:**
- Create findings triage workflow
- Document GitHub integration (if any)
- Add metrics for false positive rate
- Create issue: "Design hallucination findings review workflow"

---

### Issue 9: Temporal Consistency Rule Duplicates Existing Validation
**Location:** Part 4 "Quick Win #4"
**Problem:** Proposes "Temporal Consistency Rule" but similar checks might exist
**Why it matters:**
- `temporal-artifacts.ts` rule already detects "as of 2022" temporal markers
- `editorial-artifacts.ts` detects "TODO", "FIXME" temporal work
- New rule should not duplicate these checks

**Questions:**
- Does a "causality violation" detector already exist?
- Should we extend existing rules or create new one?

**Recommendation:**
- Audit existing temporal/timeline rules first
- Extend existing rules rather than create new ones
- Document which rules would be enhanced vs. new

---

## 🟢 GOOD DECISIONS

### ✅ Synthetic Evals Over Adversarial First
Document correctly prioritizes synthetic evals (deterministic, verifiable) before adversarial agents (higher risk of false positives). Good.

### ✅ No Auto-Fix Policy
Correct decision: adversarial agents report findings, humans decide fixes. Reduces over-aggressive corrections.

### ✅ Reuses Existing Infrastructure
Good strategy: leverage citation-auditor, risk scorer, validation rules instead of building from scratch.

### ✅ Concrete Examples
2-3 examples per agent type help implementation. Einstein, funding fabrication, trademark violations, etc. are realistic.

### ✅ Multi-Tier Approach
Fault injection (synthetic pages, citation forgeries, truncation, contradictions) covers distinct hallucination categories.

---

## 🟠 MEDIUM ISSUES (Should Clarify)

### Issue 10: Claim Frequency Analysis Leverages Search Index?
**Location:** Section 2.4
**Observation:** Claim frequency analyzer extracts claims from all pages. Could this use wiki-server full-text search + frequency analysis instead?
**Recommendation:** Clarify if this builds on existing search infrastructure or reinvents.

---

### Issue 11: Confidence Calibration Checker Scope
**Location:** Section 2.6
**Observation:** "Category-based uncertainty assessment (AI capabilities > historical facts)" requires domain knowledge.
**Risk:** LLM might over-penalize appropriate hedging on technical topics.
**Recommendation:** Limit to AI/technical safety topics initially, expand later.

---

### Issue 12: Synthetic Eval Metrics Don't Include False Positives
**Location:** Section 1.4 "Synthetic Eval Harness"
**Claims:** Precision/Recall/F1 on synthetic pages only
**Missing:** Precision on REAL pages (false positive rate)
**Recommendation:** Add eval: "Run all agents on 20 random real pages, measure false positive rate"

---

## 📋 INTEGRATION CHECKLIST

This brainstorm would require changes to:

- [ ] `apps/web/scripts/build-data.mjs` — Filter synthetic facts
- [ ] `crux/commands/` — New `adversarial.ts` command handler
- [ ] `crux/authoring/` — Possible integration with page-improver
- [ ] `crux/lib/rules/` — New temporal consistency rule
- [ ] `crux/validate/` — Register new validations
- [ ] `.github/workflows/` — Wire synthetic evals into CI
- [ ] `apps/web/src/app/internal/` — New dashboard page
- [ ] `apps/wiki-server/` — New API endpoints (if server-side dashboard)
- [ ] `data/` — Structure for eval fixtures

**Estimate:** 2-4 files modified per agent, ~15-20 files total integration points

---

## 🧪 TEST PLAN GAPS

Document mentions acceptance criteria but **no test plan** for:

1. **Unit tests** for each adversary agent
2. **Integration tests** for end-to-end workflows (page → agent → findings)
3. **False positive benchmark** (should be <5% on real pages)
4. **Performance tests** (fact-grounding <30s, dashboard <5s)
5. **Regression tests** (evals catch synthetic hallucinations consistently)

**Recommendation:** Add `## Test Plan` section to brainstorm:
```
### Unit Tests
- Each agent has dedicated test suite
- Mock wiki-server API for integration tests
- Test 5 synthetic pages + 20 real pages per agent

### Integration Tests
- End-to-end: page → agent → findings
- Dashboard load test (1000+ findings)
- Performance benchmark under load

### Acceptance Tests
- Synthetic evals: ≥80% detection rate, <5% false positives
- Real page audit: ≥3 hallucinations found in existing wiki
- Performance: agents run in <2 minutes total on 100-page batch
```

---

## 🚀 DEPLOYMENT CONSIDERATIONS

**Not mentioned in brainstorm:**

1. **LLM API costs** — Fact-grounding + confidence-calibration + claim-frequency use LLM heavily
   - Recommend cost estimate per agent type

2. **Wiki-server capacity** — New API endpoints + possible database tables
   - Recommend architecture review with wiki-server owner

3. **CI/CD integration** — `pnpm crux evals run-synthetic` in GitHub Actions?
   - Recommend timing estimate

4. **Data persistence** — Where do findings live? Ephemeral or persistent?
   - Recommend: persistent in postgres, queryable, auditable

5. **Rate limiting** — If agents hit wiki-server heavily, need throttling
   - Recommend: exponential backoff, pagination

**Recommendation:** Create GitHub issue: "Hallucination evals: deployment requirements & cost analysis"

---

## 🎯 RECOMMENDATION SUMMARY

**Status:** ✅ GOOD BRAINSTORM with specific fixes needed before implementation

**Critical fixes (must do):**
1. Resolve synthetic facts leakage (filter in build or use temp storage)
2. Implement `--test-mode` flag or use alternative approach
3. Clarify fact-grounding effort estimate (likely 4-6 hrs, not 2-3 hrs)

**Important clarifications (before implementation):**
4. Decide CLI namespace/architecture (adversarial in commands/ or authoring/?)
5. Decide dashboard: server-side or client-side?
6. Verify wiki-server API has required query capabilities
7. Design findings triage/review workflow
8. Validate performance claims with benchmarks

**Nice-to-haves (during implementation):**
9. Reduce scope of confidence-calibration to AI topics first
10. Add false positive rate to acceptance criteria
11. Create comprehensive test plan
12. Document LLM API cost implications

---

## 📝 GITHUB ISSUES TO CREATE

Recommend creating these issues before implementation:

1. **"[Infrastructure] Synthetic hallucination evals: test facts storage strategy"**
   - Labels: infrastructure, evals, hallucination-risk
   - Body: Resolve synthetic facts leakage issue

2. **"[Feature] test-mode flag for content creation pipeline"**
   - Labels: infrastructure, content-creation
   - Body: Enable graceful handling of empty search results

3. **"[Infrastructure] Hallucination adversarial agents: architecture & deployment plan"**
   - Labels: infrastructure, adversarial, hallucination-risk
   - Body: CLI namespace, wiki-server integration, cost analysis

4. **"[Feature] Adversarial findings triage workflow"**
   - Labels: workflow, hallucination-risk
   - Body: Design review process, GitHub integration, false positive handling

5. **"[Documentation] Hallucination evals: detailed implementation plan"**
   - Labels: documentation, evals
   - Body: Consolidate findings from this review + create file structure

---

## ✨ CONCLUSION

This is a **well-thought-out, ambitious brainstorm** that would significantly improve hallucination detection. The ideas are sound and the existing system (risk scorer, citation auditor, validation rules) provides excellent foundation.

**However, implementation should address the critical issues above**, particularly:
- Synthetic facts production leakage
- Effort estimates and missing flags
- Architecture decisions (CLI, dashboard, wiki-server)
- Test plan and deployment strategy

**Recommend:** Create GitHub issues for critical items, refine brainstorm based on findings, then proceed with phased implementation starting with synthetic evals (quick wins #3 + #5).

**Confidence in approach:** 8/10 (good ideas, needs clarification on integration points)
