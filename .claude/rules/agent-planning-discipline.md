# Agent Planning Discipline

Applies to multi-week plans, multi-PR refactors, and any feature where an agent (you, this session, or a subagent) is authoring scope that will direct future execution. Triggered by `/plan-feature`, by drafting epics or umbrellas, by writing migration roadmaps, and by any session whose deliverable is "a plan."

## Why this file exists

QUA-943 ("machine-write PG-primary transition") shipped through a costly planning failure. An agent authored a 5-month / ~30,000-LOC plan (v4). Two red-team passes added 19 mitigations and 0 deletions. Nine PRs of Phase 0 work merged before the framing was challenged. A v5 reframe (~5 weeks, ~3,000 LOC) was drafted and 12 child tickets filed — and an empirical investigation then revealed v5 was *also* over-scoped and partially mistargeted.

The pattern that worked was the user pushing back specifically and repeatedly: "Why migrate everything?" "Why is it so hard?" "Investigate more." Without that, the agent would have happily executed v5 as first sketched. This file encodes the lessons so that pushback is structural, not personal. Full retro: QUA-1045.

## The 7 failure modes — recognize them in yourself

Each rule below maps to a failure mode observed in the QUA-943 retro. When you catch yourself doing one of these, stop.

### 1. Don't outsource framing to agents

**The "should we do this at all" call is a human decision.** Agents elaborate; they don't simplify. When an agent authors strategic framing — choice of approach, scope of work, decision to migrate vs. patch — that framing must get explicit human signoff *before* any Phase 0 / scaffolding / "foundation" work ships.

What this means concretely:

- A plan written by an agent is a draft until the user has read the framing section and said yes. Not "looks good" — explicitly "yes, this framing."
- "Phase 0 is just plumbing, we can ship it before we agree on the rest" is the trap. Phase 0 PRs commit you to the framework. Don't ship them until the framework is signed off.
- If the user has not engaged with the framing in their own words (paraphrasing, pushing back, asking "why this and not X"), the framing is not approved. Silence is not signoff.

### 2. Empirical evidence before scope

**"We have a problem with X" needs a count, a frequency, and a cost-per-incident.** Reasoning from code structure — "this looks fragile," "this could fail," "this might drift" — is not evidence. It's a story.

Before scoping a multi-week plan, run an **empirical archaeology pass**:

1. Search prior incidents in the problem class — Linear (`pnpm crux linear search`), GitHub PR/issue history (`gh pr list --search`, `gh issue list --search`), git log (`git log --all --grep`).
2. Quantify recurrence — how many incidents in the last 6–12 months? Confirmed vs. suspected? Distinct mechanisms or one root cause?
3. Categorize — if all incidents share a root cause, the fix is narrow. If they're across distinct classes, scope is broader.
4. Output a one-page evidence summary — incidents, dates, mechanisms, counts. This justifies (or invalidates) the scope.

Do this **before** writing the plan, not after. v4's scope assumed "the YAML pipeline is fragile" — an empirical pass that took ~4 hours found 7 confirmed incidents in 4 distinct classes, fundamentally changing the plan. That pass should have happened before v4 was authored, not after Phase 0 had already shipped.

If you cannot find empirical evidence and you're still planning, that itself is evidence — that the urgency is theoretical. Halt and surface this to the user.

### 3. Watch the additive-only red-team smell

**If two consecutive review passes return only additive findings — new validators, new safety nets, new layers — the framework is wrong.** Red-teams structurally find risks → demand responses → responses are layers. Without counter-pressure, the pattern recurses. The v4 plan accumulated 19 mitigations and 0 deletions across two red-team passes. That's a smell, not rigor.

Counter-pressure rules:

- Default to **≥3 reviewers with explicitly different mandates**, not 2× same red-team. Diverse mandates produce diverse findings.
- At least one reviewer must be **constrained to deletion findings only**: "you may not propose new safety nets, validators, or layers; you may only argue for deleting scope." This is the single most effective intervention observed.
- Track the deletion-to-addition ratio across reviews. If a review pass produces zero deletions, name that fact in the next pass's prompt: "Prior pass produced 0 deletions; mandate for this pass is to find scope to remove."

### 4. Cap iterations on a moving foundation

**If scope keeps moving across plan revisions, stop planning and start measuring.** v4 → v5 → "v5 is also wrong" is the sound of a foundation that hasn't been validated. Each new layer of refinement is more compute and more sunk cost on an unverified premise.

Heuristics:

- Two plan revisions on the same problem in one session: pause. Run the empirical archaeology pass (rule 2) if you haven't.
- Three revisions: stop the planning thread entirely. The scope is unstable because the *evidence* is missing, not because the planner is bad.
- New revisions that subtract scope are healthy. New revisions that re-arrange the same scope under different framings are not.

### 5. Don't trust "everyone agrees"

**Two agents on the same problem converge on similar reasoning patterns.** They share a model. Two red-teams returning compatible findings is not independent confirmation; it's the same model running twice.

When you see strong agreement across multiple agent passes on a non-trivial decision:

- Treat the agreement as one signal, not N signals.
- Bring in genuinely different perspectives — explicitly different mandates (skeptic, auditor, simplification challenger), not "do another red-team."
- Surface the agreement to the user as "two agents agreed, but they have the same prior — do you see anything they missed?" Don't present convergent agent opinion as consensus.

### 6. Don't ship Phase 0 to lock in framing

**Sunk cost from early shipping is a planning anti-pattern, not just a project-management one.** When ~9 PRs of v4 Phase 0 had merged, reversing the framing meant either (a) defending merged work or (b) absorbing it as "useful foundation we're keeping." Both options preserve a framework that hasn't been validated.

Rules:

- No Phase 0 / scaffolding / "low-risk plumbing" PRs ship until the framing is explicitly signed off (rule 1).
- "It's low-risk, we can revert it" is not justification — the cost isn't the revert, it's the framework commitment. Phase 0 PRs make the next framing question harder, not easier.
- If you have already shipped Phase 0 work and the framing is being reconsidered, name the sunk cost out loud: "Reversing the framing means [defending / absorbing / reverting] the N PRs already merged. The reframe should be evaluated on its merits, not against the cost of unwinding."

### 7. Catch yourself repeating these mistakes mid-session

**The same agent that knows these rules will violate them in the same session.** Today's session — the one that surfaced all 7 failure modes — also produced an initial v5 sketch with 22 shapes (vs. an actual machine-write set of ~3), included a useless `drizzle-zod` validator, missed two entity fields, and filed 12 tickets before the empirical archaeology had been run. Each of those was the same agent enacting the same patterns it had just identified.

Mid-session checks:

- After drafting a section, ask: "Did I just enumerate everything I saw, or did I justify why each item is in scope?" Enumeration ≠ scoping.
- Before filing tickets that span weeks of future work, ask: "Have I run the empirical pass? If not, I'm pre-committing to scope I haven't validated."
- When the user pushes back on a specific point, treat the push as a structural signal, not a local correction. The pattern that's wrong about *this* item is probably wrong elsewhere.

## Mandatory pre-planning checklist

Before authoring a plan that spans more than ~5 sessions or ~10 PRs, run this checklist. Skipping any item requires a comment in the plan body explaining why.

| Item | Concrete action |
|------|-----------------|
| Empirical archaeology done | Search for prior incidents, count them, categorize mechanisms. Output: one-page evidence summary. |
| Framing approval requested | User has read the problem statement + chosen approach in their own words and said yes. Silence ≠ signoff. |
| Diverse-mandate review planned | At least 3 reviewers with explicitly different mandates, including one deletion-only reviewer. |
| Phase 0 gated | No "foundation" PRs ship before framing approval. State this explicitly in the plan. |
| Scope cuts section non-empty | The plan names what is *not* included and why. If you can't name cuts, you haven't reviewed the scope. |

## When to apply this rule

Triggered by:

- `/plan-feature` (mandatory — the skill enforces these gates)
- Drafting a Linear umbrella spanning >3 child tickets
- Authoring a migration roadmap, refactor plan, or "rewrite X" proposal
- Any session whose primary deliverable is "a plan" rather than "code"

Not triggered by:

- Single-session bug fixes or features
- Small refactors (<5 files, <2 sessions of work)
- Content editing or page authoring
- Tactical decisions inside an already-approved plan

## Related artifacts

- `/plan-feature` skill — operationalizes these rules in the planning workflow (framing-approval gate, empirical archaeology pass, ≥3 diverse reviewers)
- `.claude/rules/proactive-github-filing.md` § "Hypothetical problems you have not observed" — same instinct applied to ticket filing
- `.claude/rules/implementation-quality.md` § "Bug fixes — TDD workflow" step 0 — same principle applied to fixes (verify the symptom exists before writing the fix)
- QUA-1045 — the v4/v5 retrospective that produced this file
- QUA-943 — the umbrella where the planning failure happened
