---
description: Adaptive, intensive PR review. Triages the diff, builds a verification plan scaled to risk/size, and executes it — biased toward more verification, not less.
effort: high
---

# Review PR — Adaptive Intensive Review

This skill triages the current branch's changes, builds a verification plan from a menu of steps, and executes everything that applies. The bias is always toward **doing more verification, not less** — when in doubt about whether a step applies, include it.

**When to use:** Before shipping any PR. Called automatically by `/agent-ship` for all code PRs, with verification intensity scaled to PR size and risk.

---

## Phase 1: Triage — Analyze the diff and build a verification plan

**Prerequisite:** Verify the agent checklist exists (`.claude/wip-checklist.md`). If not, run `pnpm crux sys agent-checklist init "PR review" --type=infrastructure` before proceeding.

Run these commands to understand what changed:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
git diff main...HEAD | head -3000
```

Classify the changes into categories. A PR can belong to multiple categories:

| Category | Detected by | Examples |
|----------|------------|---------|
| **UI** | `.tsx`, `.css`, layout/component files | New component, changed page layout |
| **API** | `apps/wiki-server/src/routes/` | New endpoint, changed response shape |
| **CLI** | `crux/commands/`, `crux/lib/` | New command, changed command behavior |
| **Data pipeline** | `build-data`, transform scripts | Changed data loading or transformation |
| **Content** | `.mdx`, `.yaml` in `content/` or `data/` | Page edits, entity changes |
| **Infrastructure** | CI, Docker, config, migrations | Workflow changes, new env vars |
| **Tests** | `*.test.ts`, `*.spec.ts` | New or modified tests |
| **Types/schemas** | Type definitions, Zod schemas | Changed interfaces, validation rules |

Count the metrics:
- **Files changed**: from `git diff --stat`
- **Lines changed**: insertions + deletions from `git diff --stat` summary line (this is the number used for all thresholds below)
- **New files**: files that don't exist on main
- **New exports**: new `export function`, `export const`, `export class`, `export async function`, `export default`, `export type` in changed files

### Build the verification plan

Select steps from the menu below. **The default is to INCLUDE a step** — only exclude if clearly irrelevant (e.g., no .tsx files means skip UI testing). Print the plan before executing:

```
═══════════════════════════════════════════════════════════════
  REVIEW PLAN — [N] files changed, [M] lines, categories: [X, Y, Z]
═══════════════════════════════════════════════════════════════
  ✓ Build + type check              (always)
  ✓ Test suite                      (always for code changes)
  ✓ Gate check                      (always)
  ✓ Diff review via subagent        (≥30 lines)
  ✓ Simplification pass             (≥2 code files or ≥50 lines)
  ✓ Test coverage audit             (new functions/exports found)
  ✓ Red-team                        (≥100 lines or security/API/data)
  ✓ Interactive UI testing          (UI category detected)
  ✓ API endpoint testing            (API category detected)
  ✓ CLI command testing             (CLI category detected)
  ✓ Adversarial input fuzzing       (new functions with parameters)
  — Content gate only               (content-only, no code logic)
═══════════════════════════════════════════════════════════════
```

Mark steps with `✓` (will execute) or `—` (skipping, with reason). Then execute them in order.

---

## Phase 2: Mechanical verification (always runs)

These are non-negotiable. Run them first to catch obvious breakage.

### 2a. Build

```bash
pnpm build
```

Must exit 0. If it fails, fix before proceeding — nothing else matters if it doesn't build.

### 2b. Type checking

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
npx tsc --noEmit -p apps/wiki-server/tsconfig.json
npx tsc --noEmit -p crux/tsconfig.json
```

Check all three projects, not just the one that changed — changes in shared types can break dependents.

### 2c. Test suite

```bash
pnpm test
```

If new test files were added, verify they actually run:
```bash
npx vitest run --config crux/vitest.config.ts <new-test-files>
```

### 2d. Gate check

```bash
pnpm crux w validate gate --fix
```

---

## Phase 3: Diff review (subagent) — ≥30 lines changed

Use the Agent tool to spawn a fresh subagent (subagent_type: "general-purpose") with NO prior context.

Provide it with the full diff (`git diff main...HEAD`) and this prompt:

> You are a hostile code reviewer. Your job is to find problems, not to compliment the code. You have zero context about why these changes were made — evaluate purely on correctness, security, and quality.
>
> Review this diff for:
> 1. **Bugs**: Logic errors, off-by-one, null/undefined access, race conditions, incorrect async handling
> 2. **Security**: Injection (SQL, shell, XSS), secrets in code, unsafe deserialization, path traversal
> 3. **Dead code**: Unused imports, unreachable branches, commented-out code, unused parameters
> 4. **Missing exports**: New functions/types not exported where needed
> 5. **Test gaps**: New behavior without test coverage — list every new function/branch that lacks a test
> 6. **DRY violations**: Copy-pasted logic (>3 lines similar) that should be extracted
> 7. **Hardcoded values**: Magic numbers, URLs, paths, timeouts that should be constants
> 8. **Shell safety**: Unquoted variables, missing error handling in bash/workflow files
> 9. **Error handling**: Silent `.catch(() => {})`, missing error cases, swallowed exceptions
> 10. **API contract**: Changed response shapes that might break callers, missing validation on inputs
> 11. **Naming**: Misleading names, abbreviations that aren't obvious, inconsistent conventions
> 12. **Complexity**: Functions doing too many things, deep nesting, overly clever code
>
> For each finding:
> - Rate severity: CRITICAL / HIGH / MEDIUM / LOW
> - Give confidence: 0-100
> - Explain what's wrong and what the fix should be
> - Only report findings with confidence >= 60
>
> Output format: `[SEVERITY] (confidence: N) file:line — description`
>
> End with a summary: how many findings at each severity level, and your overall assessment.

**Action on findings:**
- CRITICAL (any confidence ≥ 60): Fix immediately before proceeding
- HIGH (confidence ≥ 70): Fix immediately before proceeding
- MEDIUM (confidence ≥ 80): Fix unless there's a strong reason not to (document why)
- LOW: Note in PR description if relevant, otherwise skip

---

## Phase 4: Simplification pass — ≥2 code files or ≥50 lines changed

For each changed code file (not test files, not content), read the full file and ask:

1. **Is there unnecessary abstraction?** Helpers/utilities used only once, premature generalization, wrapper functions that just forward calls
2. **Is there unnecessary complexity?** Nested ternaries, complex conditionals that could be simplified, over-engineered error handling for impossible cases
3. **Are there redundant patterns?** Multiple similar code blocks that should be a loop or helper, copy-pasted logic
4. **Is the code longer than it needs to be?** Verbose null checks where optional chaining works, manual iteration where `.map`/`.filter` is clearer
5. **Are there unnecessary dependencies?** Imports that could be avoided, libraries used for trivial operations

**Concretely**: Read each changed file, identify simplification opportunities, and apply them. This is not optional "nice to have" — simpler code has fewer bugs and is easier to review. If a simplification would change behavior, write a test first.

After simplifications, re-run `pnpm test` and `pnpm build` to verify nothing broke.

---

## Phase 5: Test coverage audit — when new functions/exports exist

Grep for new exports in the diff:

```bash
git diff --name-only main...HEAD -- '*.ts' '*.tsx' ':!*.test.*' ':!*.spec.*' | xargs -I{} git diff main...HEAD -- {} | grep -E '^\+.*(export (default |)(function|const|class|async function)|export \{|export \*)'
```

For each new exported function/class:
1. Search for a corresponding test: `grep -r "functionName" --include="*.test.ts" --include="*.spec.ts"`
2. If no test exists, **write one**. Not a trivial assertion — test the core behavior and at least one edge case.
3. For new error paths (`.catch`, `try/catch`, `if (error)`), verify a test triggers each one.

**Test quality check** — for any new tests (whether you wrote them or they were in the PR):
- No trivial assertions (`expect(result).toBeDefined()`, `typeof x === 'object'`)
- Assert on specific values that would catch regressions
- Each test should fail if the implementation is wrong (mentally remove the code under test — would the test catch it?)

---

## Phase 6: Red-team — ≥100 lines changed, or security/API/data changes

This is the most important phase for catching real bugs. The goal is to **actively try to break the solution**, not passively review it.

### 6a. Threat modeling

For each significant change, ask:
- **What assumptions does this code make?** List them explicitly. Then try to violate each one.
- **What happens with malicious input?** Not just malformed — actively adversarial. SQL injection, XSS payloads, path traversal, oversized inputs.
- **What happens under concurrent access?** Two requests hitting the same endpoint simultaneously. Two users editing the same entity.
- **What happens when dependencies fail?** Database down, API timeout, file not found, network error mid-operation.
- **What state can this leave behind on failure?** Partial writes, orphaned records, inconsistent caches.

### 6b. Construct and execute break scenarios

For each threat identified above, **actually try it**. Don't just think about it — run the code with adversarial inputs.

```bash
# Example: test a new CLI command with adversarial inputs
pnpm crux <command> ""                    # empty input
pnpm crux <command> "'; DROP TABLE--"     # injection attempt
pnpm crux <command> "$(echo pwned)"       # shell injection
pnpm crux <command> "a]]]]]]]"            # special chars
pnpm crux <command> "$(python3 -c 'print("x" * 100000)')"  # huge input
```

For API routes, construct actual HTTP requests:
```bash
curl -X POST http://localhost:<port>/api/endpoint -d '{"field": null}'
curl -X POST http://localhost:<port>/api/endpoint -d '{}'
curl -X POST http://localhost:<port>/api/endpoint -d '{"field": "<script>alert(1)</script>"}'
```

### 6c. Write tests for any bugs found

If the red-team phase finds a bug:
1. Write a failing test that reproduces it
2. Fix the bug
3. Verify the test passes

---

## Phase 7: Interactive UI testing — when .tsx component files changed

If UI components were modified, **actually look at them in a browser**.

### 7a. Start the dev server

```bash
# Use the correct port for your agent slot (3010 + slot number)
# NEVER use port 3001 — that's the user's dev server
npx next dev -p <your-port> &
DEV_PID=$!
echo "Dev server PID: $DEV_PID"
```

Wait for the server to be ready. If Playwright MCP tools are not available (browser_navigate fails), fall back to checking `pnpm build` output for rendering errors and skip interactive testing.

### 7b. Navigate to affected pages with Playwright

Use the Playwright MCP tools to:

1. **Navigate to each affected page**: `browser_navigate` to the relevant URL
2. **Take a snapshot**: `browser_snapshot` to see the rendered state
3. **Check for visual issues**: Missing content, broken layout, error boundaries
4. **Test interactions**: Click buttons, fill forms, trigger the new behavior
5. **Test edge cases in the UI**: Empty states, error states, loading states, very long content
6. **Check responsive behavior**: `browser_resize` to mobile width, take another snapshot
7. **Check console for errors**: `browser_console_messages` to catch React warnings, failed fetches

### 7c. Specific UI checks

- **New components**: Verify they render without errors in all expected contexts
- **Changed layouts**: Compare against the expected design (check issue description or screenshots)
- **Data-driven components**: Verify they handle empty data, missing fields, and malformed data gracefully
- **Links and navigation**: Click through links, verify they go to the right place
- **Forms**: Submit with valid data, empty data, and invalid data

After testing, stop the dev server by PID (job control is unreliable across shell invocations):
```bash
kill $DEV_PID  # NEVER use pkill -f "next dev" — that kills ALL dev servers
```

---

## Phase 8: Category-specific testing

### API endpoint testing (when route files changed)

If a wiki-server route was modified:
1. Start the wiki-server if not running
2. Hit the endpoint with valid inputs — verify correct response shape
3. Hit with missing required fields — verify proper error response
4. Hit with wrong types — verify validation catches it
5. Hit with oversized payloads — verify it doesn't crash
6. Check that the RPC type inference matches the actual response (if using Hono RPC)

### CLI command testing (when crux/ commands changed)

1. Run with `--help` — verify help text is accurate
2. Run with the happy path — verify correct output
3. Run with missing required args — verify helpful error message
4. Run with invalid args — verify it doesn't crash or produce garbage
5. Run with edge case inputs (empty strings, paths with spaces, unicode)

### Data pipeline testing (when build-data scripts changed)

1. Run `pnpm build-data:content` — verify it completes
2. Spot-check `database.json` for expected changes
3. Verify no entities were accidentally dropped or corrupted

### Infrastructure testing (when CI, Docker, config, or migrations changed)

1. **GitHub Actions**: Verify all referenced commands exist and work locally. Check that action versions are pinned. Review trigger conditions.
2. **Migrations**: Review SQL for correctness. Check for idempotency. Verify the migration follows patterns in `database-migrations.md`.
3. **Config changes**: Verify env vars are documented, defaults are sensible, and no secrets are hardcoded.
4. **Docker**: Verify the image builds locally if feasible.

---

## Phase 9: Final verification

**If any review phase made changes** (simplifications, new tests, bug fixes), commit them and re-verify:

```bash
pnpm build
pnpm test
pnpm crux w validate gate --fix
```

All three must pass. If no changes were made during review, this phase is redundant with Phase 2 — skip it.

---

## Phase 10: Update test plan and mark review complete

### 10a. Update PR test plan

1. Update the PR body's test plan section with checked items reflecting what was actually verified
2. Add items for any verification steps performed beyond the original plan
3. Run `pnpm crux gh pr validate-test-plan` to confirm it passes

### 10b. Commit any review-induced changes, then create review marker

If the review wrote tests, applied simplifications, or fixed bugs, **commit those changes first**. The marker must be written after the final commit so the diff hash is stable.

```bash
# Only if there are uncommitted changes from the review:
git add -A && git commit -m "review: tests, simplifications, and fixes from /agent-review-pr"

# Then write the marker against the final state:
DIFF_HASH=$(git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)...HEAD | shasum -a 256 | cut -c1-12)
echo "reviewed $(git rev-parse HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ) ${DIFF_HASH}" >| .claude/review-done
```

This file is gitignored. It persists for the life of the session and is read by `/agent-ship` to populate the `reviewed` field in the session log. Both the commit SHA and diff hash are verified — if new commits are added after review or the diff changes, the marker becomes stale.

---

## Output

Summarize the review with:

```
═══════════════════════════════════════════════════════════════
  REVIEW COMPLETE
═══════════════════════════════════════════════════════════════
  Plan executed:    [N/M steps]
  Skipped:          [list with reasons]

  Diff review:      [N findings — X fixed, Y documented, Z dismissed]
  Simplifications:  [N applied]
  Tests written:    [N new tests]
  Red-team:         [N scenarios tested, M bugs found and fixed]
  UI verified:      [N pages tested] or N/A
  API verified:     [N endpoints tested] or N/A
  CLI verified:     [N commands tested] or N/A

  Build:            PASS
  Tests:            PASS ([N] tests)
  Gate:             PASS
  Type check:       PASS

  Overall confidence: HIGH / MEDIUM / LOW
  [If MEDIUM or LOW, explain what remains uncertain]
═══════════════════════════════════════════════════════════════
```
