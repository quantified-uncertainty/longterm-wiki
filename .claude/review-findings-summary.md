# Hallucination Evals Brainstorm: Critical Review Findings

**TL;DR:** Good ideas with 3 critical issues that must be resolved before implementation can proceed.

---

## 🔴 Critical Blockers

### 1. Synthetic Facts Would Contaminate Production
**Issue:** Storing test facts in `/data/facts/synthetic-facts.yaml` leaks them into production.

**Why:** `build-data.mjs` loads ALL `data/facts/*.yaml` files → compiled into `database.json` → deployed live

**Impact:** Users see fake facts in the wiki (major quality regression)

**Required Fix:**
```javascript
// Option A: Filter in build-data.mjs
if (fact.source === 'synthetic' || fact.source === 'test') skip this fact;

// Option B: Store elsewhere
/crux/evals/fixtures/synthetic-facts.yaml (not /data/)

// Option C: Use temp/in-memory facts
Don't persist synthetic facts to YAML
```

**Action:** Choose storage strategy before implementation

---

### 2. test-mode Flag Doesn't Exist
**Issue:** Brainstorm says `crux content create --test-mode` but this flag doesn't exist

**Impact:** Can't test "graceful empty results" behavior

**Required Fix:**
- Implement `--test-mode` flag on content creator (~1-2 hrs)
- OR use alternative: mock search API instead of adding flag
- OR skip this specific test for now, add later

**Action:** Decide approach before implementation starts

---

### 3. Effort Estimates May Be 2-3x Too Low
**Issue:** Fact-grounding adversary estimated at "2-3 hrs" but likely 4-6 hrs

**Why:**
- Claims extraction (LLM) + parsing → new module
- Claim-to-citation matching logic → complex heuristic
- LLM API cost implications → documentation needed
- Citation auditor is only ~20% of the work

**Impact:** Project timeline will slip if estimates are wrong

**Action:** Revise estimates after architecture review

---

## 🟡 Major Clarifications Needed

### 4. CLI Architecture Unclear
**Decision needed:** Where should `pnpm crux adversarial` live?
- In `/crux/commands/adversarial.ts`? (new top-level command)
- Or integrated into `/crux/authoring/` (embedded in page pipeline)?
- Or both (standalone + integrated)?

**Why it matters:** Affects file structure, testing, and integration points

---

### 5. Dashboard: Server vs. Client Side
**Decision needed:** Where does the findings dashboard live?
- **Server-side (wiki-server):** Requires new API, postgres schema, real-time updates
- **Client-side (Next.js):** Simpler but can't show live findings

**Impact:** Completely different implementation

---

### 6. Wiki-Server API Capabilities Unknown
**Question:** Does wiki-server have endpoints for:
- "Find all pages mentioning entity X"?
- Efficient entity linking queries?

**Impact:** Cross-page inconsistency hunter depends on this

**Action:** Verify with wiki-server before implementation

---

## ✅ What's Good

1. ✅ **Synthetic evals first** — Safe, deterministic, good for regression testing
2. ✅ **No auto-fix** — Humans review findings, prevents over-correction
3. ✅ **Reuses infrastructure** — Builds on citation-auditor, risk scorer, rules (good DRY)
4. ✅ **Concrete examples** — 2-3 examples per agent type, realistic hallucinations
5. ✅ **Multi-tier evals** — Citations, truncation, contradictions, etc. cover different issues

---

## 📋 Before Implementation

### Must Do
- [ ] Resolve synthetic facts storage (choose option A/B/C)
- [ ] Clarify test-mode flag approach
- [ ] Revise effort estimates to 4-6 hrs for fact-grounding
- [ ] Document CLI architecture decision
- [ ] Decide dashboard: server or client side
- [ ] Verify wiki-server API capabilities

### Should Do
- [ ] Design findings triage workflow (who reviews? SLA?)
- [ ] Document LLM API costs per agent
- [ ] Create comprehensive test plan
- [ ] Validate <30s performance claims on real pages
- [ ] Add false positive rate to acceptance criteria

### Nice to Have
- [ ] Limit confidence-calibration to AI topics initially
- [ ] Create GH issues for deployment strategy
- [ ] Benchmark synthetic eval detection on 50+ real pages

---

## 🎯 Recommended Next Steps

1. **Create GitHub issues** for critical blockers (synthetic facts, test-mode, CLI arch)
2. **Review with wiki-server owner** (API capabilities, dashboard placement)
3. **Architecture discussion** (30 min sync on CLI, dashboard, storage decisions)
4. **Revise brainstorm** with decisions from above
5. **Then begin implementation** starting with synthetic evals (quick wins 3+5)

---

## 📊 Implementation Readiness

| Category | Status | Notes |
|----------|--------|-------|
| **Idea quality** | ✅ Strong | Good fundamentals, realistic approach |
| **Existing infrastructure** | ✅ Solid | Risk scorer, citation auditor, 49 rules in place |
| **Architecture decisions** | ❌ Pending | CLI, dashboard, wiki-server integration unclear |
| **Effort estimates** | ⚠️ Likely high | 2-3x underestimated on complex agents |
| **Test strategy** | ❌ Missing | No unit/integration test plan |
| **Deployment readiness** | ❌ Unknown | LLM costs, wiki-server capacity not assessed |
| **False positive handling** | ❌ Not designed | No triage workflow specified |

**Overall:** 6.5/10 ready for implementation (good ideas, needs clarity on integration)

---

## Paranoid Review Document

Full detailed review (with code references, integration checklist, deployment considerations, and GitHub issue templates) is at:

```
.claude/paranoid-review-hallucination-evals-brainstorm.md
```

Recommend reading before implementation.
