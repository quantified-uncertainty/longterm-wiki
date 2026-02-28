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

**Bad issue examples** (do NOT file these):
- "Code quality could be improved" — too vague, no specific location or fix
- "Consider adding more tests" — every codebase could have more tests; be specific about what's untested and why it matters
- "Documentation is incomplete" — which documentation, for what, and what's missing?

## Before Filing: Always Search First

**This is mandatory.** Before creating any issue, check if it already exists:

```bash
# Search open issues by keyword
pnpm crux issues search "your topic here"

# Also check closed issues (maybe it was already fixed)
pnpm crux issues search "your topic here" --closed
```

Based on the search results:

| Result | Action |
|--------|--------|
| **Exact match (open)** | Add a comment to the existing issue with your new context/findings |
| **Similar match (open)** | Read the issue. If it covers your concern, add a comment. If it's adjacent but different, file a new issue and reference the related one with `Related: #N` |
| **Match is closed** | Check if the fix actually resolved your concern. If not, file a new issue referencing the closed one: "Follow-up to #N — the original fix didn't address X" |
| **No matches** | File a new issue |

## How to File an Issue

Always use the `crux issues create` command — never raw curl:

```bash
pnpm crux issues create "Descriptive title" \
  --problem="What's wrong and why it matters" \
  --model=haiku \
  --criteria="Fix applied|Tests pass|CI green" \
  --label=enhancement \
  --cost="<$1"
```

For longer problem descriptions, use `--problem-file` to avoid shell expansion issues:

```bash
cat >| /tmp/issue-problem.md <<'EOF'
The `gate.ts` validation runs all validators even when only MDX files changed.
This wastes ~4 minutes on TypeScript checks that can't be affected by content edits.

**Current behavior:** Full gate takes ~5 min regardless of change scope.
**Expected behavior:** Content-only changes should only run content validators (~15s).

Found during session on branch `claude/fix-escaping-xyz`.
EOF

pnpm crux issues create "Gate check should skip irrelevant validators for content-only changes" \
  --problem-file=/tmp/issue-problem.md \
  --model=sonnet \
  --criteria="Scope detection works|Content-only gate runs in <30s|Full gate still works" \
  --label=tooling,enhancement \
  --cost="~$3-5"
```

### Required fields

- **Title**: Specific and actionable ("X doesn't handle Y" not "X is broken")
- **`--problem`**: What's wrong, with concrete details (file paths, error messages, reproduction steps)
- **`--model`**: Which AI model should tackle this (haiku for small/simple, sonnet for moderate, opus for complex)
- **`--criteria`**: Pipe-separated acceptance criteria — how will we know it's done?

### Recommended fields

- **`--label`**: Use existing labels (`bug`, `enhancement`, `tooling`, `content`, `documentation`)
- **`--cost`**: Estimated AI cost to fix
- **`--fix`**: If you have a proposed approach, include it

## Adding Comments to Existing Issues

When you find an issue that's related to something you encountered, add useful context:

```bash
pnpm crux issues comment <N> "Found another instance of this in \`crux/commands/validate.ts:142\` — the same pattern causes failures when the YAML has trailing whitespace."

# For longer comments, use --body-file to avoid shell expansion issues:
pnpm crux issues comment <N> --body-file=/tmp/comment.md
```

The command validates that the issue exists, rejects PRs, and appends session attribution (branch name) automatically.

Good comments include:
- New reproduction steps or failure modes you discovered
- Additional affected files or code paths
- Workarounds you used
- Priority adjustment suggestions ("This is more urgent than P3 — it affects every content session")

## When to Use GitHub Discussions Instead

GitHub Discussions are better than Issues for **open-ended topics** that don't have a clear fix:

| Use Discussions for | Use Issues for |
|---------------------|----------------|
| "Should we restructure the entity type hierarchy?" | "Entity type X is missing from the canonical list" |
| "What's our strategy for handling deprecated pages?" | "Page Y has `evergreen: false` but is still in the update schedule" |
| "Architectural question: should facts be stored in YAML or DB?" | "Fact X has wrong value in YAML" |
| "Pattern we should adopt across the codebase" | "File Z doesn't follow the established pattern" |
| Cross-cutting observations from multiple sessions | Single concrete bug or improvement |

To create a discussion, use the `crux epic create` command (which creates GitHub Discussions under the hood):

```bash
pnpm crux epic create "Should we migrate all internal dashboards to server components?" \
  --body="During sessions E912 and E913, I noticed that all dashboards use client-side data fetching..."
```

**Note:** `crux epic create` creates GitHub Discussions, which are the right tool for open-ended topics even when they aren't traditional "epics." Use a descriptive title that frames the question rather than implying a decision has been made.

## Integration with Session Workflow

### During a session

**File issues immediately when you notice them** — don't defer to "later" because you will forget. The search + create flow takes under 30 seconds:

1. **Quick check**: `pnpm crux issues search "topic"`
2. **If no match**: File the issue right now while context is fresh
3. **If match exists**: `pnpm crux issues comment <N> "your finding"`
4. **Continue your primary work** — don't get sidetracked fixing the newly filed issue

### At session end

The `/agent-session-ready-PR` workflow asks about follow-up issues filed. List any issues you created during the session — they'll be included in the session log and PR description.

### In maintenance sweeps

The `/maintain` command generates a report that may surface problems. **File issues for P3+ items too large to fix in the current sweep** rather than letting them disappear. This is a key output of maintenance — converting discovered problems into tracked work items.

## Labels to Use

| Label | When to use |
|-------|-------------|
| `bug` | Something is broken |
| `enhancement` | Improvement to existing feature |
| `tooling` | CLI, scripts, build system, validation |
| `content` | Wiki page content issues |
| `documentation` | Missing or wrong docs |
| `P0` / `P1` / `P2` / `P3` | Priority (use your judgment) |
| `effort:low` / `effort:high` | Estimated effort |
| `model:haiku` / `model:sonnet` / `model:opus` | Applied automatically by `--model` flag |

## Volume Guidelines

- **Don't flood the tracker.** 1-3 issues per session is typical. If you're finding 10+ problems, file the top 3-5 most important ones and mention the rest in a single umbrella issue.
- **Quality over quantity.** A well-described issue with clear acceptance criteria is worth more than five vague ones.
- **Batch related concerns.** If you find 4 similar escaping problems across different validators, file one issue covering all of them rather than four separate issues.
