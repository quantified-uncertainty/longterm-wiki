# Implementation Quality

Applies to sessions that write or modify code (not content-only MDX/YAML edits).

## Persistence

- When stuck after 3 approaches, stop and document what failed. Research alternatives or file a GitHub issue with findings and ask the user — do not ship a broken version.
- If scope is too large to do thoroughly, split into independently-shippable pieces. A thorough version of a smaller thing beats a shallow version of the whole thing.

## Testing Depth

**Test core functionality first.** Before writing any test, ask: "What is the one thing this code absolutely must do?" Write that test first, then edge cases. Do not write peripheral tests while skipping the main behavior.

- Every error path the code handles (`.catch()`, `try/catch`, `if (error)`) must have a test that triggers it — except intentional fire-and-forget paths documented per `error-handling.md`.
- Test with adversarial inputs: empty strings, null/undefined, boundary values (0, -1, MAX_INT), malformed data, very large inputs.
- No trivial assertions (`typeof result === 'object'`). Assert on specific values and shapes that would catch regressions.
- **Test skip discipline**: No `it.skip()` without a linked GitHub issue number. Unskip in the same PR that fixes the underlying bug.
- **Mock fidelity**: Test mocks for the same DB table must share a single in-memory store. Don't create parallel mock stores (e.g., separate `suggestResourceStore`) for different endpoints that hit the same table.

**Bug fixes — TDD workflow:**
1. Write a failing test that reproduces the bug FIRST
2. Confirm the test fails
3. Fix the bug
4. Confirm the test passes
5. Do NOT edit code without a reproducing test

## Simplicity

**Simpler code is better code.** Before committing, review each changed file and ask:

- Is there unnecessary abstraction? (helpers used once, premature generalization)
- Is there unnecessary complexity? (nested ternaries, over-engineered error handling for impossible cases)
- Is the code longer than it needs to be? (verbose null checks where `?.` works, manual iteration where `.map()` is clearer)
- Could a reader understand this in one pass? If not, simplify or add a brief comment.

The `/agent-review-pr` skill includes a simplification pass — but don't rely on the review to catch what you should write simply in the first place.

## Codebase-Wide Sweeps — Validator-First

When applying a structural rule across more than 5 files (moving components, enforcing positioning, renaming patterns, adding a prop everywhere), **write a validator first, then fix violations.** Don't trust manual inspection to find every instance.

### Why

LLMs are bad at exhaustive codebase sweeps that require structural understanding (e.g., "which column is this component in?"). They miss files, misread structure, and produce PRs that need 2-3 follow-ups to reach 100% coverage. A validator finds violations mechanically and confirms when you're actually done.

### The pattern

1. **Write a validator** (`crux/validate/validate-<rule>.ts`) that defines the rule as code. Export a `runCheck()` function returning `{ passed, errors, violations }`. Make it runnable standalone: `npx tsx crux/validate/validate-<rule>.ts`.
2. **Run it** to get the full violation list. This is your work queue.
3. **Fix every violation.** The validator output tells you exactly which files and lines need changes.
4. **Run the validator again** to confirm zero violations.
5. **Wire it into the gate** by adding an entry to the `parallelChecks` array in `crux/validate/validate-gate.ts`. Decide blocking vs advisory — new rules that enforce a freshly-applied pattern should be blocking so the pattern doesn't regress.

### Validator complexity tiers

Not every rule needs a 200-line AST parser. Match the validator to the rule:

| Rule type | Validator approach | Example |
|-----------|-------------------|---------|
| **Text pattern** (banned import, naming convention) | `grep` / regex scan over file contents | `validate-no-console-log.ts` — find `console.log` in server code |
| **Structural pattern** (component position in JSX, column order) | Line-by-line state machine tracking open/close tags or braces | `validate-dot-position.ts` — track `<td>` nesting to find first-column dots |
| **Cross-file invariant** (unique IDs, matching FK references) | Load data from multiple files, check constraints in memory | `validate-drizzle-journal.ts` — check migration prefixes are unique |
| **Runtime check** (rendered output, computed values) | Playwright e2e test instead of a static validator | `e2e/render-audit.spec.ts` — verify pages render without errors |

Start with the simplest validator that catches violations. A 10-line grep wrapper is better than no validator. You can always strengthen it later if edge cases slip through.

### When to use this vs. direct sweep

Use validator-first when:
- The rule applies to **>5 files**
- The rule is **structural** (not just text find-replace — involves understanding nesting, ordering, or context)
- **100% coverage matters** (a missed file = a user-visible bug or inconsistency)

Direct sweep is fine when:
- The change is a **simple text replacement** (`rg --files-with-matches 'oldName' | xargs sed`)
- Only **2-3 files** are affected
- You can verify completeness with a grep (`rg 'oldName'` returns 0 results)

### Anti-pattern: sweep first, validator as afterthought

The validator loses most of its value if written after the sweep, because:
- You've already shipped the "95% done" PR and moved on
- The validator catches the remaining 5% in a follow-up PR
- A third PR fixes the validator itself

Write the validator *before* making any changes. The violation list from the first run is your TODO list.

## Pre-Commit Review

Before committing, re-read the diff and actively look for problems:

1. **Adversarial inputs**: What breaks this? null, empty, huge, concurrent, malformed, missing fields
2. **Callers and dependents**: Does this change break anything that uses this code or depends on its output shape?
3. **Race conditions**: Shared mutable state without synchronization? Assumptions about async execution order?
4. **No TODO/FIXME without issue number**: No `// TODO`, `// HACK`, `// FIXME` in committed code without a `#<issue-number>`
5. **Discoverability**: New feature/endpoint linked from navigation, help text, or parent pages?
6. **Idempotency**: For job handlers and batch operations — what happens if this runs twice? Does the caller handle already-processed items (e.g., `updated < total` on retry) as success, not failure?
7. **Test coverage**: Every new exported function has at least one test. Every error path has a test that triggers it.
8. **Pattern fixes must be global**: When fixing a pattern (e.g., replacing `.max(N)` with `clampedLimit(N)`, replacing `as X` with Zod validation), grep the entire codebase for the same pattern before committing. If you find >3 instances, fix them all in the same PR. A partial fix guarantees a follow-up PR for the remainder. Mechanical sweeps across many files are fine — they're easy to review even at scale.
9. **Multi-source aggregation requires an overlap test**: When adding a second data source that merges into the same output (e.g., combining diff-detected tasks with PR-scraped tasks), write at least one test where both sources produce overlapping items. The interesting behavior is always at the intersection, not in isolation.
10. **Display bug fixes must include a regression check**: Every fixed display bug becomes a permanent check. Add it to the appropriate layer:

| Bug type | Where to add check |
|----------|-------------------|
| Client-rendered display (stat cards, tables) | `apps/web/e2e/render-audit.spec.ts` — add page to test list + assertion |
| Component formatting logic | Component `__tests__/*.test.tsx` — add test with exact input that caused the bug |
| Data-layer display (YAML/MDX) | `crux/validate/validate-display-formatting.ts` — add pattern to validator |

11. **UI changes must be verified with Playwright before shipping**: Don't ask the user to manually check pages. Run Playwright e2e tests or write ad-hoc checks. See `.claude/rules/pre-pr-verification.md` section 4 for commands. At minimum, run `cd apps/web && PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com npx playwright test e2e/render-audit.spec.ts` to catch broken renders.
