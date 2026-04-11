---
description: Create an intensive plan for big functionality. Brainstorm, research, red-team, iterate, then post as GitHub Discussion.
argument-hint: "<feature description>"
effort: high
---

# Intensive Feature Planning

Deep, multi-pass planning process for significant new functionality. Uses ~17 parallel subagents across 7 phases — heavy upfront research, divergent brainstorming, adversarial review with iteration, quality infrastructure planning, and a polished plan posted as a GitHub Discussion.

**Argument:** `$ARGUMENTS` is the feature description. If empty, ask the user what to plan before proceeding.

**Output:** A GitHub Discussion (epic) with the final plan, Phase 1 issues linked.

**Cost:** ~$15-25, 20-40 minutes.

---

## Before Starting: Gate Checks

Run these checks before launching any agents. **STOP and ask the user** if any trigger.

1. **Vague input**: If `$ARGUMENTS` has no concrete nouns (no specific system, page type, data model, or user action), STOP. Say: "This description is too vague for structured planning. Can you be more specific? For example: 'restructure navigation to add politicians and races directories' instead of 'improve the site'."

2. **Too small**: If the feature modifies < 5 files, needs no new tables/routes, and has no architectural decisions, STOP. Say: "This looks like a 1-2 session task. Consider starting with `/agent-init` instead. Proceed with full planning anyway?"

3. **Content-only work**: If the feature is primarily adding/improving wiki pages (not engineering), STOP. Say: "This is content work. Use `/review-knowledge-gap` for gap analysis or `pnpm crux w create`/`pnpm crux w improve` for pages. Proceed with full planning anyway?"

4. **Enormous scope**: If the feature would replace an entire subsystem or require >8 implementation phases, STOP. Say: "This scope exceeds what a single plan can cover. Consider breaking into 2-3 independent features. Which sub-problem should we plan first?"

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

1. **Check for existing plans**: If a GitHub Discussion already has a substantially complete plan for this feature, STOP and ask: "Discussion #N already has a plan for this. Should I update that plan, create a new one, or proceed knowing there's overlap?"

2. **Check for prior art**: Does something in the codebase already do 80% of what's needed? List overlapping systems.

3. **Write research summary**: Use the Write tool to save a consolidated summary (under 2,000 words) to `/tmp/plan-feature-research.md`. Include: problem statement, key existing code, related GitHub history, bug patterns found.

### 1d. CHECKPOINT 1 — Report to user

Print:
- Problem statement
- Key findings: what exists, what's been tried, what failed
- Any overlapping systems or duplicate plans
- "Proceeding to external research + brainstorming. Interrupt if the framing is wrong."

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

### 5c. Red team — 3 parallel agents

Write the draft plan to `/tmp/feature-plan-draft.md` using the Write tool. Each red team agent reads from disk:

1. **Technical critic** (general-purpose): "Read `/tmp/feature-plan-draft.md`. ATTACK the technical aspects. Find: unstated assumptions, missing edge cases, scaling problems, pattern inconsistencies, migration risks, CI/build breakage. Check: does the Quality & Verification section actually cover the likely failure modes? Are the proposed tests sufficient? For each criticism: | Issue | Severity (blocking/significant/minor) | Suggested fix |"

2. **UX critic** (general-purpose, uses WebSearch): "Read `/tmp/feature-plan-draft.md`. Evaluate from the user's perspective. Will this make the site better or more complex? Is the IA intuitive? Would a new visitor understand it? Search the web for '{{FEATURE_TYPE}} UX best practices' and compare. For each concern: | Issue | Severity | Suggested fix |"

3. **Scope critic** (general-purpose): "Read `/tmp/feature-plan-draft.md`. Find UNNECESSARY COMPLEXITY. What could be cut without reducing value? New abstractions that aren't needed? Tables that could be views? Is Phase 1 truly independent of Phase 3? Compare to the minimalist approach. Is quality infrastructure proportional to risk? For each cut: | What to cut | Why | Impact on value |"

### 5d. Address criticisms + report

For each blocking or significant criticism: modify the plan OR document the tradeoff.

**Print to user:** "Red team found [N] blocking, [N] significant, [N] minor issues. Key changes: [summary]. Proceeding to final review."

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

### 7c. Post discussion + create issues

```bash
pnpm crux gh epic create "[Feature Name] — Implementation Plan" --body-file=/tmp/feature-plan.md
```

Create Linear issues for Phase 1 tasks:

```bash
pnpm crux linear create "Task title" --description="..."
```

### 7d. CHECKPOINT 3 — Final report

Print:
```
═══════════════════════════════════════════
  PLAN COMPLETE
═══════════════════════════════════════════
  Discussion: [URL]
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
- **`crux gh epic create` fails**: Write the plan URL-encoded to `/tmp/feature-plan.md` (already done) and tell the user: "Discussion creation failed. Plan saved to `/tmp/feature-plan.md`. Create manually with `pnpm crux gh epic create 'Title' --body-file=/tmp/feature-plan.md`."
- **WebSearch returns garbage**: Note "no actionable results" and skip the External Inspiration section.
- **User doesn't respond at Checkpoint 2**: After presenting the comparison table, wait for the user. If they send a follow-up message that doesn't choose approaches, remind them: "Which approaches should I investigate? Pick 1-2 from the table, or tell me what's missing."

---

## Subagent Summary

| Phase | Agents | Purpose |
|-------|--------|---------|
| 1b. Research | 3 | Codebase, GitHub history+lessons, content+bugs |
| 2. External | 0-2 | Competitive analysis, technical patterns |
| 3a. Brainstorm | 4 | Minimalist, ambitious, lateral, incremental |
| 4. Deep research | 3-6 | Feasibility, precedent, risk (per approach) |
| 5c. Red team | 3 | Technical, UX, scope |
| 6a. Final review | 2 | Revision+reframing, implementability |
| **Total** | **15-20** | |

All agents within a phase run in parallel. Sequential between phases. 3 user checkpoints.

## Guardrails

- **Intermediate artifacts**: Write `/tmp/plan-feature-research.md` after Phase 1 and `/tmp/feature-plan-draft.md` before red team. If the session dies, the user has something to resume from.
- **Plans are living documents**: The Discussion can be updated during implementation. But Phase 1 must be concrete enough to start without ambiguity.
- **No implementation in this skill**: Plan only. Implementation in separate sessions via `/agent-init`.
