# FINAL PARANOID REVIEW: Hallucination Evals Brainstorm
**Comprehensive Analysis from Independent Review Agent**

---

## Executive Summary

**Brainstorm Quality:** ⭐⭐⭐⭐⭐ (Excellent ideas, well-researched)
**Implementation Readiness:** ⭐⭐⭐ (6.5/10 — needs critical fixes)
**Risk Level:** MEDIUM (3 critical blockers, 6 major clarifications needed)

**Recommendation:** DO NOT IMPLEMENT without resolving critical issues. Proceed to architecture phase after fixes.

---

## 🔴 CRITICAL BLOCKERS (Must Fix Before Coding)

### 1. SYNTHETIC DATA WOULD LEAK TO PRODUCTION ⚠️ CRITICAL
**Issue:** Brainstorm proposes storing synthetic facts/pages in `/data/evals/` and `/data/facts/synthetic-facts.yaml`

**Why it's catastrophic:**
- `apps/web/scripts/build-data.mjs` loads ALL `data/facts/*.yaml` files
- Synthetic facts get compiled into `database.json` and deployed live
- **Users see fake facts in the wiki** (major quality regression)

**Evidence:**
```javascript
// Line in build-data.mjs:
// Load canonical facts from data/facts/*.yaml
```

**Required Fix (choose one):**
- **Option A:** Filter in build-data.mjs: `if (fact.source === 'synthetic') skip;`
- **Option B:** Move all eval data to `/crux/evals/test-data/` (not `/data/`)
- **Option C:** Add `/data/evals/` to `.gitignore` + build filter

**Confidence of Issue:** 100% (verified against build script)

---

### 2. test-mode FLAG DOESN'T EXIST ⚠️ CRITICAL
**Issue:** Brainstorm says `pnpm crux content create ... --test-mode` but this flag isn't implemented

**Impact:** Can't test "graceful empty results" for non-existent entities

**Required Fix (choose one):**
- **Option A:** Implement `--test-mode` flag (~1-2 hrs)
- **Option B:** Mock the search API in tests instead
- **Option C:** Skip this specific test, implement later

**Confidence of Issue:** 100% (verified by grep for test-mode across crux/)

---

### 3. EFFORT ESTIMATES UNDERESTIMATED BY 2-3x ⚠️ CRITICAL
**Issue:** Fact-grounding adversary estimated at "2-3 hrs" but likely needs 4-6 hrs

**Why estimates are wrong:**
- Claim extraction (LLM-based NLP) → requires new module
- Claim-to-citation matching → complex heuristic or semantic search
- LLM API cost tracking → documentation + monitoring
- Citation auditor is only ~20% of the work

**Other underestimated items:**
- Cross-page inconsistency hunter: 2-3 hrs estimated, likely 4-6 hrs (clustering, extraction, semantic matching)
- Dashboard: Server-side vs. client-side decision blocks 1-2 weeks

**Impact:** Project timeline will slip 50-100% if estimates are wrong

**Confidence of Issue:** 95% (code review + complexity analysis)

---

## 🟡 MAJOR CLARIFICATIONS NEEDED (Architecture Phase)

### 4. CLI Namespace Unclear
**Decision:** Where should `pnpm crux adversarial <agent>` live?
- Option A: `/crux/commands/adversarial.ts` (new top-level command)
- Option B: `/crux/authoring/adversarial/` (part of page pipeline)
- Option C: Both (embedded in improve pipeline + standalone CLI)

**Why it matters:** Affects file structure, testing strategy, integration points

---

### 5. Dashboard: Server-Side or Client-Side?
**Decision:** Where do adversarial findings live?
- **Server-side (wiki-server):** Requires new API, postgres schema, real-time sync. ~2 weeks.
- **Client-side (Next.js):** Simpler but static/cached findings. ~3-4 days.

**Impact:** Completely different implementation approach

**Status:** No architectural decision documented yet

---

### 6. Wiki-Server API Capabilities
**Questions to verify:**
- Can wiki-server query "all pages mentioning entity X" efficiently?
- Pagination/rate limiting strategy?
- Required endpoints: Are they documented?

**Agent finding:** ✅ Verified that wiki-server has `getRelatedPages()`, `getBacklinks()`, `searchPages()` APIs. **Cross-page inconsistency is feasible.**

**Risk level:** LOW (APIs exist, but need to clarify which endpoints required for performance)

---

### 7-9. Other Clarifications
- **Confidence-calibration scope:** Limit to AI/technical safety initially?
- **Findings triage workflow:** Who reviews? GitHub integration? SLA?
- **False positive acceptance criteria:** Should be <5% on real pages

---

## ✅ VERIFIED AS CORRECT

### System Claims Validated ✓
- ✅ Hallucination risk scorer exists with 19 factors (doc claims 20+, acceptable)
- ✅ Citation auditor is LLM-based, properly exported
- ✅ 49 validation rules exist (doc says 48, off by 1 — MINOR)
- ✅ Adversarial review phase in page-improver pipeline
- ✅ Wiki-server has required query APIs
- ✅ Internal dashboard infrastructure exists (17+ existing dashboards)

### Integration Strategy Verified ✓
- ✅ CLI command patterns well-established (feasible to add `adversarial` domain)
- ✅ Citation-auditor module is properly exposed for reuse
- ✅ Rule registration system works (can add temporal-consistency rule)
- ✅ No hardcoded constants in brainstorm (good design)

---

## ⚠️ MAJOR ISSUES (Should Refactor)

### Issue 10: Blocking Gates Count Wrong
**Brainstorm claims:** "6 blocking CI gates"
**Actual system:** 10 blocking gates
- 6 unified rules (comparison-operators, dollar-signs, frontmatter-schema, no-quoted-subcategory, numeric-id-integrity, prefer-entitylink)
- PLUS 4 sequential checks:
  1. Test run (`pnpm test`)
  2. YAML schema validation (`crux validate schema`)
  3. TypeScript type check (`tsc --noEmit`)
  4. *(with --full)* Full Next.js build

**Impact:** MINOR (affects understanding of system scope, not implementation)

---

### Issue 11: Cross-Page Inconsistency Scope Underestimated
**Brainstorm scope:** "2-3 hrs" to implement cross-page inconsistency hunter

**Required components:**
1. Multi-page entity clustering (find all pages mentioning "Anthropic")
2. Fact extraction from frontmatter + body (LLM-based)
3. Semantic drift detection (±1 year acceptable, ±5 suspicious)
4. Confidence ranking per finding

**Realistic estimate:** 4-6 hrs (or 1 week if building clustering from scratch)

**Impact:** MEDIUM (timeline risk, not feasibility)

---

### Issue 12: 6 Agents Lack Orchestration
**Problem:** Brainstorm lists 6 agents but no:
- Dependency graph (which run first?)
- Conflict resolution (if agents disagree, what wins?)
- Orchestration logic (how to coordinate efficiently?)

**Impact:** MEDIUM (needs architecture before implementation)

---

### Issue 13: Storage Layer for Findings Undefined
**Missing:** Where do adversarial findings live?
- Local JSON file?
- Wiki-server database?
- Ephemeral cache?

**Impact:** MAJOR (blocks dashboard + triage workflow)

---

### Issue 14: No Precision/False Positive Metrics
**Brainstorm metric:** "Synthetic evals achieve ≥80% detection rate"

**Missing:** No precision target or false positive threshold
- 80% recall with 50% false positive rate = unusable system

**Should add:** F1 score target (e.g., ≥0.85) that balances precision + recall

---

### Issue 15: Performance Assumptions Unvalidated
**Claims:**
- "Fact grounding adversary runs in <30s on a typical page"
- "Dashboard loads all findings in <5s"

**Reality check:**
- Fact-grounding uses LLM per claim (~1-5 sec per claim, could be 20-100 sec total)
- Dashboard for "all findings" needs pagination (lazy loading for 1000+ items)

**Recommendation:** Benchmark on real pages before finalizing performance targets

---

## 🟢 GOOD DECISIONS

1. ✅ **Synthetic evals first** — Deterministic, safe, excellent for regression testing
2. ✅ **No auto-fix** — Forces human review, prevents over-correction
3. ✅ **Reuses infrastructure** — Builds on citation-auditor, risk scorer, 49 rules (excellent DRY)
4. ✅ **Concrete examples** — 2-3 realistic examples per agent type (Einstein fabrications, etc.)
5. ✅ **Multi-tier evals** — Covers citations, truncation, contradictions, timeline, confidence (comprehensive)
6. ✅ **Prioritizes precision over recall** — Better to miss some issues than over-flag (correct call)
7. ✅ **No mentions of magic numbers** — All thresholds documented (good for configurability)

---

## 📋 INTEGRATION CHECKLIST

Would require changes to ~15-20 files:

**Core infrastructure:**
- [ ] `apps/web/scripts/build-data.mjs` — Filter synthetic facts/pages
- [ ] `crux/commands/adversarial.ts` — New command handler
- [ ] `crux/lib/rules/temporal-consistency.ts` — New validation rule
- [ ] `crux/lib/adversarial/` — New modules (claim-extractor, matcher, orchestrator)

**Testing & CI:**
- [ ] `.github/workflows/ci.yml` — Wire synthetic evals into CI
- [ ] `crux/evals/` — Eval harness + fixtures

**UI/Dashboard:**
- [ ] `apps/web/src/app/internal/adversarial-findings/` — New dashboard
- [ ] Possibly `apps/wiki-server/` — New API endpoints (if server-side)

---

## 🧪 MISSING: COMPREHENSIVE TEST PLAN

Brainstorm has acceptance criteria but no detailed test plan:

**Unit tests needed:**
- [ ] Fact-grounding adversary (5+ test cases per agent)
- [ ] Citation auditor integration (mock sources)
- [ ] Cross-page clustering (test entity matching)
- [ ] Temporal consistency (timeline validation)
- [ ] Confidence calibration (topic-based uncertainty)

**Integration tests needed:**
- [ ] End-to-end: page → agent → findings
- [ ] Dashboard data loading + pagination
- [ ] False positive handling (findings marked as "fixed")
- [ ] Wiki-server API availability fallback

**Regression tests:**
- [ ] Synthetic evals catch hallucinations consistently
- [ ] No false positives on 50 real pages baseline
- [ ] Performance benchmarks (fact-grounding <2 min, dashboard <5s)

---

## 🎯 FINAL RECOMMENDATIONS

### Before Implementation Starts:
1. **CRITICAL:** Resolve synthetic data leakage (choose storage location + add CI filter)
2. **CRITICAL:** Clarify test-mode flag approach
3. **CRITICAL:** Revise effort estimates to 4-6 hrs for complex agents
4. **MAJOR:** Decide CLI architecture (commands/ or authoring/?)
5. **MAJOR:** Decide dashboard placement (wiki-server or Next.js?)
6. **MAJOR:** Define storage layer for adversarial findings
7. **MEDIUM:** Build agent orchestration layer + conflict resolution rules

### Phase 1: Architecture & Setup (1-2 weeks)
- [ ] Create GitHub issues for critical blockers
- [ ] Hold architecture sync: CLI, dashboard, storage, wiki-server integration
- [ ] Finalize test plan with precision/F1 targets
- [ ] Revise brainstorm with architecture decisions

### Phase 2: MVP Implementation (4-6 weeks)
- [ ] Start with synthetic evals (quick wins #3 + #5)
- [ ] Implement temporal consistency rule
- [ ] Implement fact-grounding adversary
- [ ] Build synthetic eval harness + run initial benchmarks

### Phase 3: Expand (6-8 weeks)
- [ ] Add remaining agents (reference-jailbreak, cross-page, claim-frequency, confidence-calibration)
- [ ] Build adversarial findings dashboard
- [ ] Integrate into page-improver pipeline (if appropriate)
- [ ] Monitor false positive rate, iterate on agents

---

## 📊 FINAL SCORECARD

| Category | Status | Score | Notes |
|----------|--------|-------|-------|
| **Idea Quality** | ⭐⭐⭐⭐⭐ | 9/10 | Excellent strategy, realistic approach |
| **Existing Infrastructure** | ⭐⭐⭐⭐ | 8/10 | Strong foundation (risk scorer, citation auditor, rules) |
| **Architecture Clarity** | ⭐⭐ | 4/10 | CLI, dashboard, storage undefined |
| **Effort Estimates** | ⭐ | 3/10 | Underestimated 2-3x on complex agents |
| **Test Strategy** | ⭐ | 2/10 | Missing comprehensive test plan |
| **Deployment Readiness** | ⭐ | 2/10 | LLM costs, wiki-server integration not assessed |
| **Blockers Resolution** | ⭐⭐ | 3/10 | 3 critical issues must be fixed |
| **Overall Readiness** | ⭐⭐⭐ | **6.5/10** | **Good ideas, needs clarity before implementation** |

---

## ✨ CONCLUSION

This is a **well-researched, ambitious, achievable brainstorm** with excellent foundational ideas. The approach of synthetic evals + adversarial agents is sound, and leveraging the existing citation-auditor + risk scorer is smart design.

**However, 3 critical blockers must be resolved before any coding begins.** These aren't minor fixes—they're architectural decisions (where to store test data, whether to add a new CLI flag, realistic time estimates) that affect the entire project scope and timeline.

**Confidence in approach:** 8.5/10 on the ideas themselves
**Confidence in implementation readiness:** 6.5/10 (pending resolution of blockers)
**Estimated time to first implementation:** +1-2 weeks for architecture decisions + blockers, then 4-6 weeks for phased implementation

---

## 📚 Reference Documents

- **`.claude/wip-hallucination-evals-brainstorm.md`** — Original brainstorm (383 lines)
- **`.claude/paranoid-review-hallucination-evals-brainstorm.md`** — Detailed paranoid review (500+ lines)
- **`.claude/review-findings-summary.md`** — TL;DR summary
- **This document** — Consolidated final review with agent findings

All documents committed to `claude/hallucination-eval-tests-1JLRf` branch.
