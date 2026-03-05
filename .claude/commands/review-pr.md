# Review PR

Comprehensive paranoid review of the current branch's changes. Combines diff review with execution-based verification.

**When to use:** Before shipping any non-trivial PR. Called automatically by `/agent-session-ready-PR`.

## Phase 1: Diff Review (spawn subagent)

Use the Task tool to spawn a fresh subagent (subagent_type: "general-purpose") with NO prior context.

Provide it with the full diff (`git diff main...HEAD`) and this prompt:

> You are a paranoid code reviewer with fresh eyes. You have no context about why these changes were made — evaluate purely on correctness and quality.
>
> Review this diff for:
> 1. **Bugs**: Logic errors, off-by-one, null/undefined access, race conditions
> 2. **Security**: Injection, XSS, secrets in code, unsafe shell commands
> 3. **Dead code**: Unused imports, unreachable branches, commented-out code
> 4. **Missing exports**: New functions/types not exported where needed
> 5. **Test gaps**: New behavior without test coverage
> 6. **DRY violations**: Copy-pasted logic that should be extracted
> 7. **Hardcoded values**: Magic numbers, URLs, paths that should be constants
> 8. **Shell safety**: Unquoted variables, missing error handling in bash/workflow files
>
> For each finding, rate severity (CRITICAL / HIGH / MEDIUM / LOW) and give a confidence score (0-100).
> Only report findings with confidence >= 70.
> Output format: `[SEVERITY] (confidence: N) file:line — description`

If the subagent reports CRITICAL or HIGH findings (confidence >= 80), fix them before proceeding.

## Phase 2: Test Plan Validation

Run `pnpm crux pr validate-test-plan` on the current PR.

If the test plan fails validation:
- Add missing test plan section to PR body
- Execute the tests described in the plan
- Check off items as they pass

## Phase 3: Execution-Based Verification

This is the most important phase. Do NOT skip it. Actually run the code and verify it works.

### 3a. Unit/Integration Tests

```bash
# Run the full test suite
pnpm test

# If new test files were added, verify they actually run
npx vitest run --config crux/vitest.config.ts <new-test-files>
```

### 3b. Type Checking

```bash
# Verify no type errors
npx tsc --noEmit -p apps/web/tsconfig.json
npx tsc --noEmit -p crux/tsconfig.json
```

### 3c. Feature-Specific Verification

Based on what changed, do targeted verification:

- **CLI commands**: Run the new/modified command with `--help`, then with real arguments. Verify output is correct.
- **API routes**: If a wiki-server route changed, test it against the dev server if available.
- **UI components**: If a React component changed, check that the dev server renders it (`pnpm dev` then describe what you see, or check for build errors).
- **Data pipeline**: If build-data scripts changed, run `pnpm build-data:content` and verify output.
- **Validation rules**: If validators changed, run `pnpm crux validate gate --fix` and verify the expected behavior.
- **GitHub Actions**: Review the YAML carefully. Verify all referenced commands exist and work locally.

### 3d. Edge Case / Fuzz Testing

For new functions or significant logic changes:

1. Identify 3-5 edge cases not covered by existing tests
2. Test them manually or write quick throwaway test cases
3. Try unexpected inputs: empty strings, null, very long inputs, special characters

### 3e. Regression Check

```bash
# Ensure nothing existing broke
pnpm crux validate gate --fix
```

## Phase 4: Update Test Plan

After executing all verification steps:

1. Update the PR body's test plan section with checked items reflecting what was actually verified
2. Add any additional test items that were performed beyond the original plan
3. Use `pnpm crux pr validate-test-plan` to confirm it passes

## Phase 5: Mark review complete

After completing all phases above, create the review marker file so `/agent-session-ready-PR` knows this session was reviewed.

The marker must include a **diff hash** (proof-of-work) that ties the review to the specific changes. This prevents trivial forgery — the gate check verifies the hash matches the current diff.

```bash
# Compute diff hash (proof-of-work tied to the actual changes)
DIFF_HASH=$(git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)...HEAD | shasum -a 256 | cut -c1-12)
echo "reviewed $(git rev-parse HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ) ${DIFF_HASH}" >| .claude/review-done
```

This file is gitignored. It persists for the life of the session and is read by `/agent-session-ready-PR` to populate the `reviewed` field in the session log. Both the commit SHA and diff hash are verified by the `review-marker` gate check — if new commits are added after review or the diff changes, the marker becomes stale and the gate will fail.

## Output

Summarize findings:
- Issues found and fixed (from diff review)
- Tests executed and results
- Edge cases verified
- Regressions checked
- Overall confidence: HIGH / MEDIUM / LOW
