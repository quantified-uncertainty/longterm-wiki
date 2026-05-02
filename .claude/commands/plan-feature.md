---
description: Create an intensive plan for big functionality. Brainstorm, research, red-team, iterate, then post as a Linear umbrella (or GitHub Discussion for open-ended strategy RFCs).
argument-hint: "<feature description>"
effort: high
---

# Intensive Feature Planning

Deep, multi-pass planning process for significant new functionality. Uses ~17 parallel subagents across 8 phases — empirical archaeology, heavy upfront research, divergent brainstorming, adversarial review with iteration, quality infrastructure planning, and a polished plan posted as a **Linear umbrella** with child issues (default) or a GitHub Discussion (only for open-ended strategy RFCs with no concrete implementation phases — see Phase 7c).

**Argument:** `$ARGUMENTS` is the feature description. If empty, ask the user what to plan before proceeding.

**Output:** A Linear umbrella issue with the final plan as its description, child issues filed per Phase, all linked in the umbrella body. (For RFC-style plans with no concrete phases, a GitHub Discussion may be preferred — rare; default to Linear.)

**Cost:** ~$15-25, 20-40 minutes.

**Discipline this skill enforces:** `.claude/rules/agent-planning-discipline.md` (auto-loaded). Read it now if you haven't this session — it explains the failure modes (over-scoping, additive-only red-teams, framing without empirical evidence, sunk-cost commitment from early Phase 0 PRs) that this skill's structure exists to prevent.

---

## Before Starting: Gate Checks

Run these checks before launching any agents. **STOP and ask the user** if any trigger.

1. **Vague input**: If `$ARGUMENTS` has no concrete nouns (no specific system, page type, data model, or user action), STOP. Say: "This description is too vague for structured planning. Can you be more specific? For example: 'restructure navigation to add politicians and races directories' instead of 'improve the site'."

2. **Too small**: If the feature modifies < 5 files, needs no new tables/routes, and has no architectural decisions, STOP. Say: "This looks like a 1-2 session task. Consider starting with `/agent-init` instead. Proceed with full planning anyway?"

3. **Content-only work**: If the feature is primarily adding/improving wiki pages (not engineering), STOP. Say: "This is content work. Use `/review-knowledge-gap` for gap analysis or `pnpm crux w create`/`pnpm crux w improve` for pages. Proceed with full planning anyway?"

4. **Enormous scope**: If the feature would replace an entire subsystem or require >8 implementation phases of the resulting plan (not this skill's phases), STOP. Say: "This scope exceeds what a single plan can cover. Consider breaking into 2-3 independent features. Which sub-problem should we plan first?"

---

## Phase 0: Empirical Archaeology — quantify the problem

**Run this BEFORE any solution thinking.** A plan whose scope is set without empirical evidence will over-scope by default — see `.claude/rules/agent-planning-discipline.md` § "Empirical evidence before scope" and the QUA-1045 retro for why. The v4 plan that triggered this gate scoped 5 months of work on the assumption that "the YAML pipeline is fragile"; an empirical pass run after the plan's scaffolding PRs had already shipped found the real incident set was 7 across 4 mechanisms — fundamentally changing the plan. ("Scaffolding PRs" = the resulting plan's own Phase 0 — implementation Phase 0, distinct from this skill's Phase 0 here.)

### 0a. Skip conditions

Skip Phase 0 only when:
- The feature is purely additive (a new directory page, a new dashboard) with no claim of fixing an existing problem
- The feature is user-requested with explicit scope ("add X to Y") and no implicit "because Z is broken" framing

If the feature framing contains *any* "because [system] is fragile / unreliable / leaks / drifts / silently fails" claim, **do not skip Phase 0**. That claim is exactly what needs evidence.

### 0b. Search for prior incidents — 2 parallel agents

1. **Linear + GitHub history agent** (general-purpose): "Search for incidents in the problem class for {{FEATURE}}. Run:
   - `pnpm crux linear search '{{PROBLEM_KEYWORDS}}'` — open and closed
   - `gh issue list -R quantified-uncertainty/longterm-wiki --search '{{PROBLEM_KEYWORDS}}' --state all --limit 50 --json number,title,createdAt,closedAt,labels`
   - `gh pr list --search '{{PROBLEM_KEYWORDS}}' --state merged --limit 30 -R quantified-uncertainty/longterm-wiki --json number,title,mergedAt,body`
   - `git log --all --oneline --since='12 months ago' --grep='{{PROBLEM_KEYWORDS}}'`
   For each hit: confirmed incident or speculative? Date? Mechanism (one-line root cause)? Report as a table: | Date | ID/PR# | Confirmed? | Mechanism | Notes |."

2. **Symptom-pattern agent** (general-purpose): "For {{FEATURE}}, search for the *user-visible symptoms* it claims to address (broken pages, wrong values, drift, missing data, etc.). Run `pnpm crux query search` for relevant terms; check `apps/web/e2e/` for tests that exist for this class; check session logs in `.claude/sessions/` if present. Report: (1) confirmed symptoms with evidence, (2) hypothesized symptoms with no observed instance — flag clearly."

### 0c. Synthesize evidence summary

Read both agent results. Then write `/tmp/plan-feature-evidence.md` with:

- **Confirmed incidents**: count, dates, mechanisms (categorized).
- **Distinct mechanism classes**: 1, 2, 3+? If all incidents share a root cause, scope is narrow. If distinct, scope is broader but each may need its own targeted fix rather than one umbrella.
- **Frequency**: incidents per month over the last year.
- **Cost-per-incident**: minutes/hours of human time, blast radius, recurrence rate.
- **Hypothesized but unobserved**: list separately. These do not justify scope on their own.

### 0d. CHECKPOINT 0 — Framing approval gate

**This gate is mandatory and human-only.** Print to the user:

```
═══════════════════════════════════════════
  EMPIRICAL EVIDENCE — FRAMING GATE
═══════════════════════════════════════════
  Feature framing:    [the "because X" claim]
  Confirmed incidents: [N] in last 12 months
  Distinct mechanisms: [M] classes
  Frequency:          [N] / month
  Hypothetical-only:  [list, or "none"]
═══════════════════════════════════════════
  Recommend: [proceed | narrow scope to one mechanism | halt — insufficient evidence]
  Reason: [one sentence]
═══════════════════════════════════════════
```

**Then stop and wait for user response.** The user must explicitly approve the framing in their own words ("yes, plan for the [N]-mechanism case", "narrow to mechanism X only", "halt — this is theoretical") before Phase 1 begins. Paraphrasing or pushback is the *positive signal* that the user has actually engaged with the framing — it is what you want, not a problem to overcome. But engagement alone is not yet approval; the engagement must be followed by an explicit "yes, proceed" before Phase 1 begins. Silence ≠ approval. "Looks good" without paraphrasing or pushback ≠ approval (it could mean the user skimmed without engaging).

If the user wants to proceed despite weak evidence, document the choice in the eventual plan body under "Open Questions" — "Empirical evidence weak; proceeded anyway because [user reason]." This makes the assumption legible to the next reader.

**Why this gate is non-negotiable:** see `.claude/rules/agent-planning-discipline.md` § "Don't outsource framing to agents." The QUA-943 v4 plan locked in 5 months of scope without this gate — it cannot be re-introduced as a soft guideline.

---

## Phase 1: Deep Research (no solutions yet)

Spend significant time understanding what exists. **No solutions until Phase 3.**

### 1a. Problem statement

Parse `$ARGUMENTS`. Write a 2-3 sentence problem statement covering:
- **Core goal**: What outcome?
- **Who benefits**: Users? Developers? Content pipeline?
- **Success criteria**: How do we know it's done and working?

In all agent prompts below, replace `{{FEATURE}}` with this problem statement.

### 1b. Gather context — 3 parallel agents

1. **Codebase agent** (Explore, thoroughness: "very thorough"): "Search the codebase for anything related to {{FEATURE}}. Find: existing code, partial implementations, related systems, data models, database tables, API routes, UI components, test files. Check: `apps/web/src/app/`, `apps/wiki-server/src/routes/`, `crux/commands/`, `data/`, `packages/`. Report as a table: | File/system | What it does | Lines | Relevant to plan because... |"

2. **GitHub history agent** (general-purpose): "Search GitHub for all prior work on {{FEATURE}}. Run:
   - `pnpm crux gh issues search '{{FEATURE_KEYWORDS}}'` (open and `--closed`)
   - `gh discussion list -R quantified-uncertainty/longterm-wiki --limit 30 --json number,title,comments` then filter for relevant titles
   - `git log --all --oneline --grep='{{FEATURE_KEYWORDS}}' | head -20`
   For the most relevant discussions, read their full bodies. Report: (1) all related issues/discussions/PRs, (2) what approaches were tried and abandoned and why, (3) for past plans that succeeded (5+ comments, work implemented): what made them work? For plans that died (0 comments): what was missing?"

3. **Content + bug pattern agent** (general-purpose): "Two tasks for {{FEATURE}}:
   (A) Search wiki content and data: `pnpm crux query search '{{FEATURE_KEYWORDS}}'`, check `data/` directories, `content/docs/internal/`.
   (B) Search for recent bugs in related areas: `gh pr list --state merged --limit 40 -R quantified-uncertainty/longterm-wiki --json number,title --jq '.[] | select(.title | test(\"fix|bug|patch|broken\"; \"i\")) | \"\(.number)\t\(.title)\"'`. Read bug-fix PRs related to {{FEATURE}} area.
   Report as two sections: (1) Existing content/data, (2) Bugs found in related systems with root causes."

### 1c. Synthesize and check for duplicates

Read all three agent results. Then:

1. **Check for existing plans**: Search Linear (`pnpm crux linear search "feature keywords"`) AND GitHub Discussions for existing plans. If either has a substantially complete plan for this feature, STOP and ask: "QUA-NNN / Discussion #N already has a plan for this. Should I update that plan, create a new one, or proceed knowing there's overlap?"

2. **Check for prior art**: Does something in the codebase already do 80% of what's needed? List overlapping systems.

3. **Write research summary**: Use the Write tool to save a consolidated summary (under 2,000 words) to `/tmp/plan-feature-research.md`. Include: problem statement, key existing code, related GitHub history, bug patterns found.

### 1d. CHECKPOINT 1 — Report to user

Print:
- Problem statement
- Key findings: what exists, what's been tried, what failed
- Any overlapping systems or duplicate plans
- "Proceeding to external research + brainstorming. Interrupt if the framing is wrong."

If the user did not engage substantively at the Phase 0 framing gate (single-word approval, immediate "looks good") **and** Phase 1 surfaced material new findings (existing 80% solution, prior abandoned attempt, conflicting epic), pause again here and re-confirm framing before continuing. New findings can invalidate the Phase 0 evidence.

---

## Phase 2: External Research (optional)

**Skip if** the feature is purely internal infrastructure with no UI or external parallels. Tell the user: "Skipping external research — this is internal infrastructure with no external parallels."

Launch **2 parallel agents**:

1. **Competitive analysis agent** (general-purpose, uses WebSearch): "How do other projects solve {{FEATURE}}? Search for examples from: Wikipedia, Wikidata, EA Forum, LessWrong, Metaculus, and similar knowledge bases/wikis. Also check open-source projects and commercial products. Search: '{{FEATURE_KEYWORDS}} site design', '{{FEATURE_KEYWORDS}} information architecture'. Report as: | Project | How they solve it | What we can borrow | URL |. If searches return only generic SEO content, say 'no actionable results' — do not pad with fluff."

2. **Technical patterns agent** (general-purpose, uses WebSearch): "Search for architecture patterns and common pitfalls for {{FEATURE_TYPE}}. Look for: how mature projects structure this, common mistakes, anti-patterns. Search: '{{FEATURE_TYPE}} architecture best practices', '{{FEATURE_TYPE}} common mistakes'. Report as: | Pattern | Adopt/Avoid | Why |. If nothing specific found, say so."

If both agents return nothing useful, note "external research yielded no actionable insights" and move on.

---

## Phase 3: Divergent Brainstorming

Generate many approaches. Quantity over quality. Do NOT evaluate yet.

### 3a. Solution brainstorm — 4 parallel agents

Each agent reads `/tmp/plan-feature-research.md` first (include "First, use the Read tool to read `/tmp/plan-feature-research.md` for context" in each prompt).

1. **Minimalist agent** (general-purpose): "Read `/tmp/plan-feature-research.md`. Your mandate is SIMPLICITY for {{FEATURE}}. Simplest implementation that solves the core problem. No new abstractions, tables, systems. What's the smallest change for 80% of the value? Report: approach name, 3-sentence summary, exact files/tables to modify, effort (number of sessions), key tradeoff."

2. **Ambitious agent** (general-purpose): "Read `/tmp/plan-feature-research.md`. Your mandate is COMPLETENESS for {{FEATURE}}. Thorough implementation — all edge cases, best UX, proper architecture. Include ASCII mockup for any UI. Report: approach name, 3-sentence summary, new files/tables/routes needed, effort (sessions), key tradeoff."

3. **Lateral agent** (general-purpose): "Read `/tmp/plan-feature-research.md`. Your mandate is CREATIVITY for {{FEATURE}}. Unconventional angles: repurpose existing systems? Reframe the problem? External inspiration? Propose 3 unconventional approaches. For each report: approach name, 3-sentence summary, what's novel about it, effort (sessions), key tradeoff."

4. **Incremental agent** (general-purpose): "Read `/tmp/plan-feature-research.md`. Your mandate is INCREMENTALISM for {{FEATURE}}. Smallest shippable increments. Each independently useful. Phase 1 achievable in one session. Report: approach name, 3-sentence summary, phase breakdown (3-4 phases with 1 sentence each), effort per phase (sessions), key tradeoff."

### 3b. CHECKPOINT 2 — User chooses direction

Create a comparison table from the agent results:

| Approach | Summary | Effort | Risk | Value | Key tradeoff |
|----------|---------|--------|------|-------|-------------- |
| A: Minimal | ... | ... | ... | ... | ... |
| B: Full | ... | ... | ... | ... | ... |
| C: Creative | ... | ... | ... | ... | ... |
| D: Incremental | ... | ... | ... | ... | ... |

**Your response MUST end after presenting this table and asking the user which approaches to investigate.** Do NOT read or execute Phase 4+ in this turn. The user's next message tells you which approaches to pursue. If the user rejects all approaches, return to Phase 1a to revise the problem statement.

---

## Phase 4: Deep Research on Chosen Approaches

For each approach the user selected, launch **3 parallel agents** (up to 6 if 2 approaches):

1. **Technical feasibility agent** (Explore, thoroughness: "very thorough"): "For approach [X] to implement {{FEATURE}}: What existing code changes? New files/tables/routes? Check specific file paths. Report as: | File | Action (create/modify/delete) | What changes | Blocking dependencies |. Also: what existing tests cover this area? What new tests needed?"

2. **Precedent agent** (Explore): "Find the most similar recently-implemented feature. Check: `git log --oneline --since='60 days ago' | head -30`, directory pages in `apps/web/src/app/`, dashboards in `apps/web/src/app/internal/`. For the closest match: what files created, patterns used, lines of code, tests written, follow-up fix PRs? Report as: precedent name, file list, what worked, what caused bugs."

3. **Risk + bug pattern agent** (general-purpose): "Read `/tmp/plan-feature-research.md` for bug findings. For approach [X] to {{FEATURE}}, check against these known bug patterns:
   - Incomplete refactoring (missing call sites after migration)
   - Production timeout/limit mismatches (client assumes limits server doesn't have)
   - Merge-conflict residue (stale variables after rename)
   - Data integrity from LLM enrichment (hallucinated facts)
   - Cumulative QA debt (skipping UI review)
   Which apply? What specific risks exist for data migration, scale (700+ pages), build impact (~3 min), deploy complexity? Report as: | Risk | Severity | Mitigation |"

---

## Phase 5: Draft Plan + Quality Infrastructure + Red Team

### 5a. Write the draft plan

Re-read `/tmp/plan-feature-research.md` before writing. Based on Phases 1-4, write a complete draft including all sections from the Phase 7a template. Pay special attention to the Quality & Verification section (5b).

### 5b. Quality & Verification — MANDATORY

Every plan must address these areas. This exists because most bugs in this repo come from missing verification, not bad designs.

| Area | Specify | Motivated by |
|------|---------|-------------|
| **Tests** | Exact test files to create. Scenarios + edge cases. | Features ship without tests, break silently |
| **Migration verification** | If refactoring: grep command to confirm zero remaining old-pattern call sites | PR #3691 missed 4 of 36 call sites |
| **Integration smoke test** | Command to run against real data confirming end-to-end functionality | PR #3584 shipped with `limit=5000` but server caps at 200 — never worked |
| **UI verification** | Pages to load, data states to check (empty, sparse, full, edge-case) | 15 PRs shipped, then QA sweep found 37 issues |
| **Deploy steps** | New env vars? Manual migration? Post-deploy check? | Timeout mismatches surface only in production |
| **Documentation** | Internal docs to update? New CLAUDE.md conventions? | Agent sessions repeat fixed mistakes |
| **Monitoring** | How to detect breakage post-deploy? Dashboard? Health check? | Features degrade silently |

If an area doesn't apply, write "N/A — [reason]" rather than omitting it.

### 5c. Red team — ≥3 parallel agents with explicitly different mandates

Write the draft plan to `/tmp/feature-plan-draft.md` using the Write tool. **Each reviewer below has a different mandate by design** — see `.claude/rules/agent-planning-discipline.md` § "Watch the additive-only red-team smell" for why two same-mandate red-teams (the QUA-943 v4 anti-pattern) produce 19 mitigations and 0 deletions. The deletion-only reviewer is non-negotiable.

Each agent reads `/tmp/feature-plan-draft.md` from disk before evaluating.

1. **Technical critic** (general-purpose): "Read `/tmp/feature-plan-draft.md`. ATTACK the technical aspects. Find: unstated assumptions, missing edge cases, scaling problems, pattern inconsistencies, migration risks, CI/build breakage. Check: does the Quality & Verification section actually cover the likely failure modes? Are the proposed tests sufficient? For each criticism: | Issue | Severity (blocking/significant/minor) | Suggested fix |"

2. **UX critic** (general-purpose, uses WebSearch): "Read `/tmp/feature-plan-draft.md`. Evaluate from the user's perspective. Will this make the site better or more complex? Is the IA intuitive? Would a new visitor understand it? Search the web for '{{FEATURE_TYPE}} UX best practices' and compare. For each concern: | Issue | Severity | Suggested fix |"

3. **Deletion-only reviewer** (general-purpose) — *the constrained mandate*: "Read `/tmp/feature-plan-draft.md` and `/tmp/plan-feature-evidence.md`. Your mandate is constrained: **you may ONLY argue for deleting scope.** You may not propose new validators, safety nets, fallback layers, monitoring systems, or 'one more abstraction.' You may not say 'add X to handle Y.' Your only outputs are: phases that should be cut, mitigations that should be removed, abstractions that should be inlined, sub-tasks that should be deferred to a future ticket. For each deletion: | What to cut | Why it's not needed | What evidence (or lack of evidence) supports cutting it | Risk of cutting |. If you find nothing to cut, say 'no deletions found' explicitly — do not pad with additive findings. The plan author will weigh these against the technical critic's additive findings."

4. **Strategic challenger** (general-purpose): "Read `/tmp/feature-plan-draft.md` and `/tmp/plan-feature-evidence.md`. Question the *premise*, not just the design. Ask: (1) Is the problem this plan solves the actual problem, or a proxy for it? (2) Is the chosen approach addressing the highest-frequency mechanism in the evidence summary, or a smaller one? (3) Is there an entirely different framing — patch the specific bugs, change the contract, accept the failure mode — that's never been considered? (4) Is the plan over-fitted to the loudest recent incident? Report: | Premise question | Why it might be wrong | Alternative framing |. Do not refine the existing plan; argue against it."

### 5d. Reconcile + flag the additive-only smell

Tally the reviews:

- **Total deletions proposed**: count from the deletion-only reviewer (and any deletions volunteered by the others).
- **Total additions proposed**: count from the technical critic (and others).
- **Ratio**: additions ÷ deletions.

If additions > 3× deletions, **stop and flag it explicitly to the user**: "Red-team passes are biased toward additive findings ([N] adds vs [M] cuts). This is the QUA-943 v4 pattern. Please review the plan body for over-scoping before I proceed." Do not silently absorb the additions.

For each blocking or significant criticism: modify the plan OR document the tradeoff. For each deletion finding: apply it OR document why scope is preserved (one sentence per preserved item).

**Print to user:** "Red team found [N] blocking, [N] significant, [N] minor issues. Deletions proposed: [M] (applied: [K]). Key changes: [summary]. Proceeding to final review."

---

## Phase 6: Final Review + Revision

### 6a. Revise and review — 2 parallel agents

1. **Revision + reframing agent** (general-purpose): "Read `/tmp/feature-plan-draft.md`. The plan received these criticisms: [paste blocking/significant criticisms and resolutions]. Two questions: (1) Are the fixes adequate, or did fixing one problem introduce another? (2) Are we solving the right problem, or is there a fundamentally different framing that avoids these issues? Report: remaining issues + framing assessment."

2. **Implementability agent** (general-purpose): "Read `/tmp/feature-plan-draft.md`. For each implementation phase: Is the task description specific enough for an agent to start without ambiguity? Are file paths and schemas concrete? Could Phase 1 be done in one session? Does the Quality & Verification section give clear gates for each phase? Report: | Phase | Implementable? | What's missing or ambiguous |"

### 6b. Final revisions

Incorporate feedback. If blocking issues remain, escalate to the user.

---

## Phase 7: Finalize + Post

### 7a. Write the final plan

Use the Write tool to create `/tmp/feature-plan.md`. Target: 10,000-16,000 characters.

```markdown
<!-- agent-project
priority: [low|medium|high]
status: not-started
phases_total: [N]
phases_done: 0
last_agent_session: [DATE]
framing_approved_by: [user name + date — populated at Checkpoint 0]
empirical_evidence: [N confirmed incidents, M mechanisms — or "N/A — purely additive feature"]
-->

## [Feature Name] — Implementation Plan

### TL;DR
[3-4 sentences: the problem, chosen approach, Phase 1 scope, top open question.]

### Problem
[What this solves and why now. 2-3 sentences.]

### Current State
[MANDATORY TABLE — exact file paths, table names, route paths, row counts.]

| Asset | Status | Gap |
|-------|--------|-----|
| ... | ... | ... |

### Proposed Approach
[Description. ASCII mockup/diagram for any UI component.]

### Key Decisions
- **Decision**: [what]
  - Alternatives: [rejected options + why]
  - Rationale: [why this one]

### Architecture
[Exact file paths, schemas, route patterns.]

| File | Action | Purpose |
|------|--------|---------|
| ... | create/modify | ... |

### Implementation Phases

#### Phase 1: [description] — [S/M/L]
**Goal**: [What a user notices after this ships]
- [ ] Task 1
- [ ] Task 2
**Quality gates**: [Tests, pages to check, commands to run]
**Exit criteria**: [How to verify]

#### Phase 2: ...

### Scope Cuts
[MANDATORY: What is explicitly NOT included and why.]

### Quality & Verification Infrastructure
[From Phase 5b — all 7 areas.]

### Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|------------|
| ... | ... | ... |

### Open Questions
[Genuine uncertainties needing human input.]

### Rejected Approaches
[Each approach not chosen + why.]

<details>
<summary>Red Team Log</summary>

[Criticisms and resolutions from both rounds.]

</details>
```

### 7b. Quality check

Verify before posting:
- [ ] No `[placeholder]` or `[...]` text remains — every cell has specific content
- [ ] Current State has a concrete table with file paths
- [ ] Scope Cuts section is non-empty
- [ ] Quality & Verification covers: tests, smoke test, UI verification (minimum)
- [ ] Phase 1 is achievable in one agent session with explicit quality gates
- [ ] ASCII mockup included for any UI component
- [ ] Document is 10,000-16,000 characters
- [ ] Sections that don't apply are omitted (not left with placeholder text)

### 7c. Post umbrella + create children

**Default: Linear umbrella with children.** Concrete multi-phase implementation plans belong in Linear. A GitHub Discussion is only appropriate for open-ended strategy RFCs with no concrete Phase 1 — in that case, skip the umbrella, use `pnpm crux gh epic create` instead, and explain the choice to the user.

Step 1 — create the umbrella (the plan body becomes its description):

```bash
pnpm crux linear create "Umbrella: [Feature Name]" \
    --description-file=/tmp/feature-plan.md \
    --project="<project name from linear-project-ownership.md>" \
    --priority=2
# → captures QUA-NNN for the umbrella; reuse it for --parent below
```

Step 2 — file each Phase's child issues with `--parent=QUA-NNN`. At minimum, file Phase 1 tasks. Prefer one child per 1-3 session chunk, not per atomic task:

```bash
pnpm crux linear create "Phase 1: <task>" \
    --description-file=/tmp/phase1-a.md \
    --project="<same project>" \
    --priority=2 \
    --parent=QUA-NNN
```

Step 3 — if the umbrella has a sibling epic (e.g. this plan complements QUA-544), post a comment on the sibling:

```bash
pnpm crux linear comment QUA-544 "Sibling: QUA-NNN tracks [complementary axis]. See [link]."
```

Project picking: follow `.claude/rules/linear-project-ownership.md`. If unsure, ask the user.

### 7d. CHECKPOINT 3 — Final report

Print:
```
═══════════════════════════════════════════
  PLAN COMPLETE
═══════════════════════════════════════════
  Umbrella:   QUA-NNN — [URL]
  Approach:   [3-4 sentence summary]
  Phases:     [N] ([Phase 1 title] is ready to start)
  Issues:     [Phase 1 issue URLs]
  Open Qs:    [list, or "none"]
═══════════════════════════════════════════
  To start: /agent-next-issue or
  pnpm crux sys agent-checklist init --issue=N
═══════════════════════════════════════════
```

---

## Error Handling

- **Subagent returns empty/fails**: Note the gap and continue. Do not block on one failed agent — the other parallel agents provide redundancy.
- **`crux linear create` fails**: Plan is already at `/tmp/feature-plan.md`. Tell the user: "Umbrella creation failed. Plan saved to `/tmp/feature-plan.md`. Create manually with `pnpm crux linear create 'Umbrella: Title' --description-file=/tmp/feature-plan.md --project=<name> --priority=2`."
- **WebSearch returns garbage**: Note "no actionable results" and skip the External Inspiration section.
- **User doesn't respond at Checkpoint 2**: After presenting the comparison table, wait for the user. If they send a follow-up message that doesn't choose approaches, remind them: "Which approaches should I investigate? Pick 1-2 from the table, or tell me what's missing."

---

## Subagent Summary

| Phase | Agents | Purpose |
|-------|--------|---------|
| 0b. Empirical archaeology | 0-2 | Linear+GitHub history, symptom patterns (skipped only for purely additive features) |
| 1b. Research | 3 | Codebase, GitHub history+lessons, content+bugs |
| 2. External | 0-2 | Competitive analysis, technical patterns |
| 3a. Brainstorm | 4 | Minimalist, ambitious, lateral, incremental |
| 4. Deep research | 3-6 | Feasibility, precedent, risk (per approach) |
| 5c. Red team | 4 | Technical, UX, **deletion-only** (constrained mandate), strategic challenger |
| 6a. Final review | 2 | Revision+reframing, implementability |
| **Total** | **16-23** | |

All agents within a phase run in parallel. Sequential between phases. **4 user checkpoints** — Phase 0d (framing approval, mandatory), 1d (research synthesis), 3b (approach selection), and 7d (final report).

## Guardrails

- **Intermediate artifacts**: Write `/tmp/plan-feature-research.md` after Phase 1 and `/tmp/feature-plan-draft.md` before red team. If the session dies, the user has something to resume from.
- **Plans are living documents**: The Linear umbrella's description can be edited during implementation (via Linear UI or API). But Phase 1 must be concrete enough to start without ambiguity.
- **No implementation in this skill**: Plan only. Implementation in separate sessions via `/agent-init`.
