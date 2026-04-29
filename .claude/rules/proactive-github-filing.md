# Proactive Issue Filing — When Agents Should Create Issues

**Linear is the primary issue tracker.** All new issues go in Linear (QUA team), not GitHub Issues.

Agents should **actively contribute to the project's issue tracker** — not just consume issues, but create them. When you encounter friction, bugs, tech debt, missing docs, or improvement opportunities during a session, capture them in Linear so they're not lost.

## When to File a New Issue

File an issue when you encounter any of the following during normal work:

| Trigger | Example | Priority |
|---------|---------|----------|
| **Bug you can't fix now** | "Build fails if entity has no `lastEdited`" | P1-P2 |
| **Tech debt you noticed** | "Three copy-pasted validation blocks in `gate.ts`" | P2-P3 |
| **Missing documentation** | "No docs on how `update_frequency` interacts with `evergreen: false`" | P3 |
| **Confusing DX** | "Error message says 'invalid entity' but doesn't say which field" | P2-P3 |
| **Flaky or slow process** | "Gate check takes 5 min but could skip unchanged validators" | P2 |
| **Missing validation** | "Nothing prevents duplicate `wikiId` across YAML files" | P1-P2 |
| **Inconsistency** | "Some pages use `<R>` components, others use raw markdown links for the same resources" | P3 |
| **Stale content** | "Page references 2024 data but it's now 2026" (if not fixable in current session) | P3 |
| **Security concern** | "API endpoint doesn't validate input length" | P0-P1 |

**Do NOT file issues for:**
- Things you can fix right now as part of the current task (e.g., a typo on the page you're editing) — just fix them
- Vague observations without actionable next steps — "the site should be faster" or "the codebase could be cleaner" are not issues
- Duplicates of existing issues (check first — see below)
- Your own work-in-progress — don't file an issue for something you're about to do in this session
- Hypothetical problems you have not observed — "this might fail if..." without evidence that it actually fails
- Performance concerns without measurements — "this could be slow" without profiling data or benchmarks
- Follow-up issues for work you are about to ship — if the PR needs a follow-up to be functional, the PR is incomplete

**Bad issue examples** (do NOT file these):
- "Code quality could be improved" — too vague, no specific location or fix
- "Consider adding more tests" — every codebase could have more tests; be specific about what's untested and why it matters
- "Documentation is incomplete" — which documentation, for what, and what's missing?
- "This might cause race conditions under high load" — speculation without observed evidence
- "Part 2: finish implementing X" — if X doesn't work without Part 2, don't ship Part 1 separately

## Before Filing: Always Search First

**This is mandatory.** Before creating any issue, check if it already exists:

```bash
pnpm crux linear search "your topic here"
```

- **Match found (open)** → Add a comment: `pnpm crux linear comment QUA-NNN "your finding"`
- **No match** → File a new issue

## How to File

```bash
pnpm crux linear create "Descriptive title" \
  --description="What's wrong and why it matters" \
  --project="<Project Name>"
```

`--project` is **required** (or pass `--parent=QUA-NNN` to inherit). The CLI refuses with exit 2 otherwise — see `.claude/rules/linear-project-ownership.md` for which project to pick. Bypass with `--allow-no-project` only if the issue genuinely has no home yet.

For longer descriptions, use `--description-file=/tmp/description.md`.

**File issues immediately when you notice them** — don't defer. The search + create flow takes under 30 seconds. Then continue your primary work.

## Guardrails

- **Evidence required**: You must have *observed* the problem in the current session — do not file speculative or hypothetical issues. Point to a specific file, error message, or behavior you encountered.
- **Volume target**: 0-2 issues per session is normal. If you're finding 10+ problems, file the top 2-3 and batch the rest into one umbrella issue.
- **Re-verify before dispatching** *(applies when picking up a previously-filed ticket, not when filing a new one)*: tickets get fixed between filing and dispatch. Before starting work on a ticket that claims a prod symptom, run the acceptance test that would catch it (render-audit, e2e spec, etc.) and confirm it still fails. If it passes, comment with the test result and close — don't write a fix for a bug that's already gone. See `implementation-quality.md` § "Bug fixes — TDD workflow" step 0.

## Mandatory tracking — red flags that MUST produce a ticket

The patterns below have a documented history of getting lost when an agent "just flags it verbally" or "assumes someone else will handle it." If you observe any of these, **you must file or reopen a Linear ticket before ending the session.** Not doing so is a violation of this rule, not a judgement call.

| Red flag | Required action | Rationale |
|---|---|---|
| **Prod incident observed** (failed deploy, stuck migration, 5xx spike, prod endpoint returning wrong status) | File **Urgent/P0** Linear ticket with root cause + prescribed fix + link to evidence. Do NOT just mention it in PR comments or chat. | 2026-04-11 incident: wiki-server deploy stuck 12+h because the failure was "noticed" but never ticketed. |
| **Symptom patch** (baseline bump, `test.skip()`, catch-and-swallow in an error path that previously threw, commented-out code, `// TODO` without issue number, silencing a validator you don't understand) | File a separate ticket naming (a) the symptom that was patched, (b) the suspected root cause, (c) what would let us unpatch. Link from the patching PR. | Symptom patches are permanent by default. Without a ticket, nobody ever unpatches them. |
| **Misdiagnosis discovered** (you or another session filed a ticket with the wrong root cause, or a ticket's scope turned out to be pointing at the wrong thing) | Close the wrong ticket with a "misdiagnosed — actual cause is X" comment **and** file the correct ticket. Don't silently abandon. | Abandoned wrong tickets waste future agent time (they're still in the backlog). |
| **Premature "Done"** (parent/epic ticket was closed while residual work remains — e.g., PR merged closing the ticket but a follow-up piece is still needed) | Reopen the parent ticket with a "partial completion — see remaining work" comment, OR file a follow-up ticket and link it before ending the session. | 2026-04-11 incident: QUA-156 closed Done when its migration actually bricked the deploy. Closure masked the failure. |
| **N+ related symptoms in a narrow window** (≥2 consecutive baseline bumps in the same file, ≥2 PRs reverting each other, ≥2 patches silencing the same validator) | **Stop patching.** File a ticket describing the pattern and why you stopped. Escalate to the coordinator. | 2026-04-11 incident: 7 PRs in 24h patched sourcing-ratchet symptoms while the real problem (stuck deploy) was untracked. Any one agent stopping at symptom #2 would have caught it. |

### When in doubt, file

If you're unsure whether something meets the bar above, **file it.** False-positive tickets are cheap (close with "actually fine"). False-negative missed root causes are expensive — see the 2026-04-11 cascade.

### Not a red flag

- Things you fix completely in this session — no ticket needed, the PR is the record.
- Style/cleanup observations you have no evidence hurt anyone — use the "Do NOT file issues for..." list above.
- Work you're about to ship in the same PR — not a follow-up, just part of the PR.

## GitHub Discussions

Use `crux gh epic create` for **open-ended questions** that don't have a clear fix ("Should we restructure X?", "What's our strategy for Y?"). Issues are for concrete actionable tasks; discussions are for decisions that need human input. Discussions stay on GitHub — they are not tracked in Linear.
