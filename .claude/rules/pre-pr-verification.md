# Pre-PR Verification — MANDATORY

Before opening or updating a PR, you MUST run these verification steps. Do not skip them. A PR without verification is incomplete.

## 1. Build verification

Run `pnpm build` and confirm it exits 0. This catches:
- TypeScript errors in new/modified code
- SSR rendering issues (missing `"use client"`, server/client boundary violations)
- Import resolution failures
- MDX compilation errors across all 600+ pages

If `pnpm build` is too slow for the change scope, `pnpm build-data:content` + `npx tsc --noEmit` is an acceptable substitute for content-only or type-only changes.

## 2. Test verification

Run `pnpm test` and confirm existing tests still pass. If you added new logic (helpers, utilities, data transformations), write tests for it.

### When to write tests

**Always write tests for:**
- New utility functions or helpers (e.g., `hasMarkup()`, `formatValue()`)
- Data transformation logic
- Validation rules
- CLI command logic

**Tests are optional for:**
- Pure JSX layout changes (no logic)
- Configuration changes (presets, constants)
- CSS/styling changes

## 3. Gate check (if modifying MDX, YAML, or validation code)

Run `pnpm crux validate gate --fix` to catch CI-blocking issues.

## 4. Completeness check

Before opening a PR, verify that ALL acceptance criteria from the issue are met.

A PR that ships half a feature and plans to "finish in a follow-up" is not acceptable. If the scope is genuinely too large for one session:
- Split the issue into smaller, independently-shippable pieces BEFORE starting work
- Each piece must be functional on its own (no "Part 1 of 3" PRs that break without Part 2)
- Document the split in the original issue

## 5. What to do when verification fails

Fix the issue before opening the PR. If you can't fix it:
- Note the failure in the PR description
- Do NOT open the PR and claim it works when it doesn't
- Ask the user for guidance

## Why this matters

PRs that don't build waste reviewer time. A 2-minute build check prevents a round-trip of "CI failed → fix → re-push → re-review." Build verification is the minimum bar for a PR being worth reviewing.
