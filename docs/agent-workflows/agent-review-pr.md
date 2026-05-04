# Review PR — Adaptive Intensive Review

This skill triages the current branch's changes, builds a verification plan from a menu of steps, and executes everything that applies. The bias is always toward **doing more verification, not less** — when in doubt about whether a step applies, include it.

**When to use:** Before shipping any PR. Called automatically by `/agent-ship` for all code PRs, with verification intensity scaled to PR size and risk.

> **Phase count is intentional, not aspirational.** This skill ran with 11 phases through 2026-04 and three sessions in a row (QUA-928, QUA-933, QUA-936) skipped phases that *felt* duplicate — Phase 4 (simplification) and Phase 5 (coverage audit) reliably found nothing because Phase 3b's hostile reviewer already covered them. QUA-961 folded those two into 3b's prompt items #12 and #5 so the surface is honest about what's happening. **Do not split simplification or coverage audit back out as standalone phases** — strengthen the 3b prompt instead.

---

## Code review rules to enforce

When reviewing the diff (Phase 3b in particular) flag any violations of these project-wide rules. Most are also caught by gate checks; review surfaces the ones gate misses.

- **No `(r: any)` in wiki-server routes** — define typed row interfaces for raw SQL results (gate-enforced)
- **No `as unknown as T` double-casts** — use runtime type narrowing or proper generics
- **Batch endpoints must use transactions or bulk SQL** — never sequential per-row updates
- **Migration file prefixes must be unique** — no two `.sql` files with the same numeric prefix (gate-enforced)
- **Destructive endpoints (DELETE, bulk UPDATE) must log actions** before executing
- **New wiki-server routes must use Hono RPC method-chaining** (`const app = new Hono().get(...).post(...)` with `export type Route = typeof app`) so client types infer via `InferResponseType<>`. Canonical pattern: `apps/wiki-server/src/routes/factbase/facts.ts`.
- **API callers must use typed wiki-server client functions** (`crux/lib/wiki-server/*.ts`) — not raw `apiRequest<{...}>` with hand-written type parameters. If no typed client exists, create one using `InferResponseType<>`. Gate-enforced via `validate-typed-client` (QUA-770). New direct `apiRequest<T>` calls require either a typed client or a `// typed-client-ok: <reason>` marker.
- **Batch write callers must handle partial success** — `updated < total` may mean "already processed on retry" not "failed". Treat partial success as non-fatal when the endpoint has idempotent semantics.
- **LLM prompts must escape user content** — `escapeXml()` from `crux/lib/prompt-utils.ts` for XML-delimited prompts; `JSON.stringify()` or `---` fencing for other formats. See `docs/agent-rules/llm-prompt-safety.md`.
- **No standalone weak assertions in tests** — `toBeDefined()` alone doesn't catch wrong values; follow with `toBe()`, `toEqual()`, or `toMatchObject()` on specific fields.
- **No `it.skip` without issue number** — skipped tests must reference `#1234` or `QUA-NNN` in the skip reason.

---

## Phase 1: Triage — Analyze the diff and build a verification plan

**Prerequisite:** Verify the agent checklist exists (`.claude/wip-checklist.md`). If not, run `pnpm crux sys agent-checklist init "PR review" --type=infrastructure` before proceeding.

**Initialize the phase tracker** (QUA-950 — required for the marker write at Step 7):

```bash
pnpm crux sys review-phase init
```

This wipes any prior tracker and anchors a new one to the current `HEAD` + diff hash. Every phase below records to `.claude/review-phases-done`; `crux sys review-phase write-marker` refuses to write the review marker until every required phase has either an execution timestamp or an explicit `reason=...` skip.

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

Select steps from the menu below. **The default is to INCLUDE a step** — only exclude if clearly irrelevant. Print the plan before executing:

```
═══════════════════════════════════════════════════════════════
  REVIEW PLAN — [N] files changed, [M] lines, categories: [X, Y, Z]
═══════════════════════════════════════════════════════════════
  ✓ Build                           (frontend paths touched — see Phase 2a)
  ✓ Type check                      (always)
  ✓ Test suite                      (always for code changes)
  ✓ Gate check                      (skip if pre-push gate just ran — see Phase 2d)
  ✓ Diff review via subagent        (≥30 lines — covers simplification + coverage)
  ✓ Red-team                        (≥100 lines or security/API/data)
  ✓ Interactive UI testing          (UI category detected)
  ✓ API endpoint testing            (API category detected)
  ✓ CLI command testing             (CLI category detected)
  ✓ Adversarial input fuzzing       (new functions with parameters)
  — Content gate only               (content-only, no code logic)
═══════════════════════════════════════════════════════════════
```

Mark steps with `✓` (will execute) or `—` (skipping, with reason). For Phase 2a and 2d carve-outs, the reason must reference the diff property that triggered the skip (specific paths in scope, or a verified pre-push gate cache hit), not free-form text. Then execute them in order.

After printing the plan, record Phase 1 completion:

```bash
pnpm crux sys review-phase record phase-1-triage
```

---

## Phase 2: Mechanical verification

These are non-negotiable except for the documented carve-outs. Run them first to catch obvious breakage.

### 2a. Build — conditional on frontend-touching paths

Run `pnpm build` ONLY if the diff touches any of:

- `apps/web/src/**`
- `apps/web/scripts/build-data*`
- `apps/web/next.config.*`
- `apps/web/tailwind.config.*`
- any `*.tsx` file (anywhere in the repo)

```bash
# Detect with:
git diff --name-only main...HEAD | grep -E '^(apps/web/src/|apps/web/scripts/build-data|apps/web/next\.config\.|apps/web/tailwind\.config\.)|\.tsx$' | head -1
```

If the grep matches:

```bash
pnpm build
```

Must exit 0. If it fails, fix before proceeding — nothing else matters if it doesn't build.

If the grep is empty (pure `crux/`, wiki-server, content, or non-frontend changes), **skip 2a** — Phase 2b's typecheck on three projects catches the same TS errors in ~10s vs `pnpm build`'s ~60s+. Record the skip in the plan with the diff predicate that justified it (e.g. `Phase 2a — N/A: 0 frontend paths in diff`).

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

### 2d. Gate check — conditional on pre-push gate cache freshness

Check whether the pre-push hook already ran the full gate against the current commit. The hook writes a cache file at `.cache/pre-push-gate-cache` after a successful gate run; the line is `<commit-sha> <iso-timestamp>`.

```bash
GATE_CACHE=.cache/pre-push-gate-cache
HEAD_SHA=$(git rev-parse HEAD)
if [ -f "$GATE_CACHE" ] && [ "$(awk '{print $1}' "$GATE_CACHE")" = "$HEAD_SHA" ]; then
  echo "Phase 2d — N/A: pre-push gate cache hit on $HEAD_SHA at $(awk '{print $2}' "$GATE_CACHE")"
else
  pnpm crux w validate gate --fix
fi
```

If the cache hit is invalid (different SHA, missing file, file corrupted), fall through to running the gate. Do NOT use `--no-verify` or any other shortcut to bypass — the carve-out is "gate already ran on this exact commit," not "gate seems unnecessary."

When recording the skip, the predicate must reference the cache (e.g. `Phase 2d — N/A: pre-push gate cache hit on $HEAD_SHA`).

After all four 2x checks pass (or are documented as carved-out), record completion:

```bash
pnpm crux sys review-phase record phase-2-mechanical
```

---

## Phase 3: Diff review (subagent) — ≥30 lines changed

### 3a. Narrow-patch signature check (always, fast)

Before spawning the review subagent, run the narrow-patch detector. It flags the "column-name-gated value probe" pattern that produced the QUA-316 → QUA-346 → QUA-354 cascade, where raw `f_xxx` fact IDs were masked one column at a time until a content-based regex replaced both narrow patches.

```bash
npx tsx crux/pr-review/detect-narrow-patch.ts
```

The detector fires at MEDIUM severity when the diff adds a conditional that *both* gates on a literal column name (`columnName === "..."`, `field.name === "..."`, etc.) *and* probes the value's signature (`.startsWith(`, `.test(`, `.match(`, `.includes(`). Pure formatting transforms (`toFixed`, `Intl.NumberFormat`, `formatCurrency`) are not flagged.

**Action on a hit:** before proceeding with the rest of the review, ask explicitly whether the fix could be content-based (match the value's shape regardless of column) instead of column-name-gated. A content-based fix prevents the recurring per-column patch loop. If you confirm the column-gated version is correct (e.g. the column name genuinely carries meaning beyond the value's shape), document the reasoning in the PR body — otherwise rewrite it before shipping. See `.claude/rules/proactive-github-filing.md` § "N+ related symptoms in a narrow window" for the broader rule.

After running the detector and acting on any hits, record completion:

```bash
pnpm crux sys review-phase record phase-3a-narrow
```

### 3b. Hostile reviewer subagent

Use the Agent tool to spawn a fresh subagent (subagent_type: "general-purpose") with NO prior context.

> **Items #5 and #12 absorb prior standalone Phases 4 (simplification) and 5 (coverage audit) per QUA-961 — do not split them back out.** Their matrix-style enumeration is what made the standalone phases redundant; weakening either prompt back to the original one-liner re-creates the rationalization surface that QUA-928, QUA-933, and QUA-936 fell into.

Provide it with the full diff (`git diff main...HEAD`) and this prompt:

> You are a hostile code reviewer. Your job is to find problems, not to compliment the code. You have zero context about why these changes were made — evaluate purely on correctness, security, and quality.
>
> Review this diff for:
> 1. **Bugs**: Logic errors, off-by-one, null/undefined access, race conditions, incorrect async handling
> 2. **Security**: Injection (SQL, shell, XSS), secrets in code, unsafe deserialization, path traversal
> 3. **Dead code**: Unused imports, unreachable branches, commented-out code, unused parameters
> 4. **Missing exports**: New functions/types not exported where needed
> 5. **Test coverage matrix**: For each (a) new exported function/class, (b) new error path (`.catch`, `throw`, `if (error)`, status-non-2xx branch), (c) new conditional branch — produce a row with `name | tested? (yes/no/partial) | test file:line if tested`. Include the **full matrix** in your output (not just uncovered items), so reviewers can verify the enumeration was exhaustive. Flag every uncovered or partially-covered row as a finding.
> 6. **DRY violations**: Copy-pasted logic (>3 lines similar) that should be extracted
> 7. **Hardcoded values**: Magic numbers, URLs, paths, timeouts that should be constants
> 8. **Shell safety**: Unquoted variables, missing error handling in bash/workflow files
> 9. **Error handling**: Silent `.catch(() => {})`, missing error cases, swallowed exceptions
> 10. **API contract**: Changed response shapes that might break callers, missing validation on inputs
> 11. **Naming**: Misleading names, abbreviations that aren't obvious, inconsistent conventions
> 12. **Simplification matrix**: For each changed source file (not test, not content), list every (a) helper used only once that should be inlined, (b) wrapper that just forwards calls, (c) nested ternary or complex conditional that could be simplified, (d) verbose null check where optional chaining works, (e) manual iteration where `.map`/`.filter` is clearer, (f) function doing too many things, (g) deeply nested code. Include the **full matrix** in your output. For each row, recommend either applying the simplification or explain why not (e.g., "single-use helper retained for testability"). Don't compress to "no findings" — show the enumeration so the reviewer can verify it ran.
>
> For each finding:
> - Rate severity: CRITICAL / HIGH / MEDIUM / LOW
> - Give confidence: 0-100
> - Explain what's wrong and what the fix should be
> - Only report findings with confidence >= 60
>
> Output format: `[SEVERITY] (confidence: N) file:line — description`
>
> End with a summary: how many findings at each severity level, and your overall assessment. Include the full test-coverage matrix (item #5) and simplification matrix (item #12) **before** the findings list, so reviewers can see what you enumerated regardless of whether each row produced a finding.

**Action on findings:**
- CRITICAL (any confidence ≥ 60): Fix immediately before proceeding
- HIGH (confidence ≥ 70): Fix immediately before proceeding
- MEDIUM (confidence ≥ 80): Fix unless there's a strong reason not to (document why)
- LOW: Note in PR description if relevant, otherwise skip

**Action on the matrices:** Read both matrices end-to-end. For the test-coverage matrix, every `no` row is a missing test — write it before continuing unless the row carries a documented "untestable" reason. For the simplification matrix, every "apply" row is a change to make in the diff before shipping. The matrices are deliverables, not commentary — empty cells or "n/a — too many to list" make the phase incomplete.

If the subagent fails (API error, timeout, disconnect), retry once with a chunked diff. If retry also fails, run the same prompt inline in your own context as a fallback — the inline review is weaker than a fresh subagent, but it catches the round-up-to-done loophole where a failed 3b is treated as completed.

After the subagent (or fallback) runs AND any HIGH/CRITICAL fixes are applied, record completion:

```bash
pnpm crux sys review-phase record phase-3b-hostile
# OR if the diff is below the 30-line threshold:
pnpm crux sys review-phase record phase-3b-hostile --reason="N/A: diff under 30 lines"
```

---

## Phase 4: Red-team — ≥100 lines changed, or security/API/data changes

This is the most important phase for catching real bugs. The goal is to **actively try to break the solution**, not passively review it. (See QUA-936 / PR #4748 — red-team caught a path-traversal bug in `--tag` that 3b missed, because adversarial *execution* surfaces what passive code reading does not.)

### 4a. Threat modeling

For each significant change, ask:
- **What assumptions does this code make?** List them explicitly. Then try to violate each one.
- **What happens with malicious input?** Not just malformed — actively adversarial. SQL injection, XSS payloads, path traversal, oversized inputs.
- **What happens under concurrent access?** Two requests hitting the same endpoint simultaneously. Two users editing the same entity.
- **What happens when dependencies fail?** Database down, API timeout, file not found, network error mid-operation.
- **What state can this leave behind on failure?** Partial writes, orphaned records, inconsistent caches.

### 4b. Construct and execute break scenarios

For each threat identified above, **actually try it**. Don't just think about it — run the code with adversarial inputs.

```bash
# Example: test a new CLI command with adversarial inputs
pnpm crux <command> ""                    # empty input
pnpm crux <command> "'; DROP TABLE--"     # injection attempt
pnpm crux <command> "$(echo pwned)"       # shell injection
pnpm crux <command> "a]]]]]]]"            # special chars
pnpm crux <command> "$(python3 -c 'print("x" * 100000)')"  # huge input
pnpm crux <command> "../../etc/passwd"    # path traversal (if any arg becomes a path)
```

For API routes, construct actual HTTP requests:
```bash
curl -X POST http://localhost:<port>/api/endpoint -d '{"field": null}'
curl -X POST http://localhost:<port>/api/endpoint -d '{}'
curl -X POST http://localhost:<port>/api/endpoint -d '{"field": "<script>alert(1)</script>"}'
```

### 4c. Write tests for any bugs found

If the red-team phase finds a bug:
1. Write a failing test that reproduces it
2. Fix the bug
3. Verify the test passes

After threat modeling + execution + any bug fixes, record completion:

```bash
pnpm crux sys review-phase record phase-4-redteam
# OR for content-only or trivial diffs that don't meet the trigger:
pnpm crux sys review-phase record phase-4-redteam --reason="N/A: <100 lines and no security/API/data changes"
```

---

## Phase 5: Category-specific testing

Run the subsections that match the categories detected in Phase 1. UI is just one category alongside API, CLI, data pipeline, and infrastructure — they all live here.

### 5a. Interactive UI testing — when .tsx component files changed

If UI components were modified, **actually look at them in a browser**.

#### Start the dev server

```bash
# Use the correct port for your agent slot (3010 + slot number)
# NEVER use port 3001 — that's the user's dev server
npx next dev -p <your-port> &
DEV_PID=$!
echo "Dev server PID: $DEV_PID"
```

Wait for the server to be ready. If Playwright MCP tools are not available (browser_navigate fails), fall back to checking `pnpm build` output for rendering errors and skip interactive testing.

#### Navigate to affected pages with Playwright

Use the Playwright MCP tools to:

1. **Navigate to each affected page**: `browser_navigate` to the relevant URL
2. **Take a snapshot**: `browser_snapshot` to see the rendered state
3. **Check for visual issues**: Missing content, broken layout, error boundaries
4. **Test interactions**: Click buttons, fill forms, trigger the new behavior
5. **Test edge cases in the UI**: Empty states, error states, loading states, very long content
6. **Check responsive behavior**: `browser_resize` to mobile width, take another snapshot
7. **Check console for errors**: `browser_console_messages` to catch React warnings, failed fetches

#### Specific UI checks

- **New components**: Verify they render without errors in all expected contexts
- **Changed layouts**: Compare against the expected design (check issue description or screenshots)
- **Data-driven components**: Verify they handle empty data, missing fields, and malformed data gracefully
- **Links and navigation**: Click through links, verify they go to the right place
- **Forms**: Submit with valid data, empty data, and invalid data

After testing, stop the dev server by PID (job control is unreliable across shell invocations):
```bash
kill $DEV_PID  # NEVER use pkill -f "next dev" — that kills ALL dev servers
```

### 5b. API endpoint testing — when route files changed

If a wiki-server route was modified:
1. Start the wiki-server if not running
2. Hit the endpoint with valid inputs — verify correct response shape
3. Hit with missing required fields — verify proper error response
4. Hit with wrong types — verify validation catches it
5. Hit with oversized payloads — verify it doesn't crash
6. Check that the RPC type inference matches the actual response (if using Hono RPC)

### 5c. CLI command testing — when crux/ commands changed

1. Run with `--help` — verify help text is accurate
2. Run with the happy path — verify correct output
3. Run with missing required args — verify helpful error message
4. Run with invalid args — verify it doesn't crash or produce garbage
5. Run with edge case inputs (empty strings, paths with spaces, unicode)

### 5d. Data pipeline testing — when build-data scripts changed

1. Run `pnpm build-data:content` — verify it completes
2. Spot-check `database.json` for expected changes
3. Verify no entities were accidentally dropped or corrupted

### 5e. Infrastructure testing — when CI, Docker, config, or migrations changed

1. **GitHub Actions**: Verify all referenced commands exist and work locally. Check that action versions are pinned. Review trigger conditions.
2. **Migrations**: Review SQL for correctness. Check for idempotency. Verify the migration follows patterns in `docs/agent-rules/database-migrations.md`.
3. **Config changes**: Verify env vars are documented, defaults are sensible, and no secrets are hardcoded.
4. **Docker**: Verify the image builds locally if feasible.

After running the sub-categories that apply (5a-5e), record completion. Phase 5 covers all five sub-categories under one record line:

```bash
pnpm crux sys review-phase record phase-5-category
# OR if no sub-category triggered:
pnpm crux sys review-phase record phase-5-category --reason="N/A: no UI/API/CLI/data/infra files in diff"
```

---

## Phase 6: Final verification

**If any review phase made changes** (simplifications, new tests, bug fixes), commit them and re-verify:

```bash
pnpm build           # only if Phase 2a's frontend predicate still applies
pnpm test
pnpm crux w validate gate --fix
```

All three must pass. If no changes were made during review, this phase is redundant with Phase 2 — **skip it**, do not run defensively. Re-running tests on an unchanged tree feels safe but burns context for zero new signal.

Then record completion (this phase is non-skippable — even when no review changes shipped, recording it confirms you considered the question):

```bash
pnpm crux sys review-phase record phase-6-final
```

---

## Phase 7: Update test plan and mark review complete

### 7a. Update PR test plan

1. Update the PR body's test plan section with checked items reflecting what was actually verified
2. Add items for any verification steps performed beyond the original plan
3. Run `pnpm crux gh pr validate-test-plan` to confirm it passes

### 7b. Commit any review-induced changes, then create review marker

If the review wrote tests, applied simplifications, or fixed bugs, **commit those changes first**. The marker must be written after the final commit so the diff hash is stable.

```bash
# Only if there are uncommitted changes from the review:
git add -A && git commit -m "review: tests, simplifications, and fixes from /agent-review-pr"

# Validate phase coverage and write the marker in one step (QUA-950):
pnpm crux sys review-phase write-marker
```

`crux sys review-phase write-marker` is the sanctioned path to write `.claude/review-done` for full reviews. It validates the phase tracker first and refuses (exit 2) when any of the 7 required phases is missing — each must have either an execution timestamp or an explicit `reason=...` skip.

The marker file lives at a path the agent can also write directly (the auto-approve hook permits it for backwards-compat with `pr-patrol`'s lightweight-fix flow), so the gate is operationally enforced via this skill, not OS-level. If you bypass `write-marker` you also bypass the phase coverage check — don't do that for a real review. For `pr-patrol` lightweight fixes that don't run the full review, pass `--force --reason="patrol-fix: targeted change, full review unnecessary"` to record the bypass in the tracker.

If you committed new changes after the last `record` call, the tracker's diff hash will no longer match HEAD and `write-marker` will refuse. Re-run any phases that need to repeat (typically just `phase-6-final`), then re-init if the diff has substantively changed:

```bash
pnpm crux sys review-phase init               # only if the diff itself changed
pnpm crux sys review-phase record phase-6-final
pnpm crux sys review-phase write-marker
```

This file is gitignored. It persists for the life of the session and is read by `/agent-ship` to populate the `reviewed` field in the session log. Both the commit SHA and diff hash are verified — if new commits are added after review or the diff changes, the marker becomes stale.

> **Why the structural enforcement exists.** Earlier reviews could declare "complete" after running phases 1-3 + 6-7, skipping phases 4-5 silently. The hostile reviewer subagent's findings looked thorough enough to anchor the perceived rigor of the whole review, but each phase actually catches a different class of issue — Phase 4 (red-team) found a path-traversal bug on QUA-936 that Phase 3b's passive review missed. The phase tracker turns "I ran the review" into a verifiable claim. See QUA-950 for the original incident write-up.

---

## Output

Summarize the review with:

```
═══════════════════════════════════════════════════════════════
  REVIEW COMPLETE
═══════════════════════════════════════════════════════════════
  Plan executed:    [N/M steps]
  Skipped:          [list with predicates — Phase 2a/2d skips MUST cite the diff property or cache hit]

  Diff review:      [N findings — X fixed, Y documented, Z dismissed]
  Coverage matrix:  [N rows total, M uncovered → tests written / documented]
  Simplification:   [N rows total, M applied / explained]
  Red-team:         [N scenarios tested, M bugs found and fixed]
  UI verified:      [N pages tested] or N/A
  API verified:     [N endpoints tested] or N/A
  CLI verified:     [N commands tested] or N/A

  Build:            PASS or N/A (no frontend paths in diff)
  Tests:            PASS ([N] tests)
  Gate:             PASS or N/A (pre-push gate cache hit on $HEAD_SHA)
  Type check:       PASS

  Overall confidence: HIGH / MEDIUM / LOW
  [If MEDIUM or LOW, explain what remains uncertain]
═══════════════════════════════════════════════════════════════
```
