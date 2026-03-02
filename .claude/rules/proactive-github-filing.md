# Proactive GitHub Filing — When Agents Should Create Issues, Comments, and Discussions

Agents should **actively contribute to the project's issue tracker** — not just consume issues, but create them. When you encounter friction, bugs, tech debt, missing docs, or improvement opportunities during a session, capture them in GitHub so they're not lost.

## When to File a New Issue

File a GitHub issue when you encounter any of the following during normal work:

| Trigger | Example | Priority |
|---------|---------|----------|
| **Bug you can't fix now** | "Build fails if entity has no `lastEdited`" | P1-P2 |
| **Tech debt you noticed** | "Three copy-pasted validation blocks in `gate.ts`" | P2-P3 |
| **Missing documentation** | "No docs on how `update_frequency` interacts with `evergreen: false`" | P3 |
| **Confusing DX** | "Error message says 'invalid entity' but doesn't say which field" | P2-P3 |
| **Flaky or slow process** | "Gate check takes 5 min but could skip unchanged validators" | P2 |
| **Missing validation** | "Nothing prevents duplicate `numericId` across YAML files" | P1-P2 |
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
pnpm crux issues search "your topic here"
pnpm crux issues search "your topic here" --closed   # also check resolved issues
```

- **Match found (open)** → Add a comment: `pnpm crux issues comment <N> "your finding"`
- **Match found (closed)** → Check if the fix resolved your concern. If not, file a new issue referencing it.
- **No match** → File a new issue

## How to File

```bash
pnpm crux issues create "Descriptive title" \
  --problem="What's wrong and why it matters" \
  --model=haiku \
  --criteria="Fix applied|Tests pass|CI green" \
  --label=enhancement
```

For longer descriptions, use `--problem-file=/tmp/problem.md`. Run `crux issues create --help` for full options.

**File issues immediately when you notice them** — don't defer. The search + create flow takes under 30 seconds. Then continue your primary work.

## Guardrails

- **Rate limited**: `crux issues create` enforces a daily cap (2/day). This is intentional — if you're hitting the limit, you're filing too many.
- **Agent-labeled**: All agent-filed issues are auto-labeled `filed-by-agent` for tracking.
- **Volume target**: 0-2 issues per session is normal. If you're finding 10+ problems, file the top 2-3 and batch the rest into one umbrella issue.

## GitHub Discussions

Use `crux epic create` for **open-ended questions** that don't have a clear fix ("Should we restructure X?", "What's our strategy for Y?"). Issues are for concrete actionable tasks; discussions are for decisions that need human input.
