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

Run `pnpm crux w validate gate --fix` to catch CI-blocking issues.

## 4. UI verification with Playwright (if modifying .tsx pages or components)

When your PR changes pages or UI components, **verify them visually with Playwright** before opening the PR. Do not ask the user to manually check pages you could verify programmatically.

```bash
# Run against production (no local server needed):
cd apps/web && PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com npx playwright test e2e/render-audit.spec.ts

# Run a specific test file:
cd apps/web && PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com npx playwright test e2e/homepage.spec.ts

# Run against local dev server (starts automatically if not running):
cd apps/web && DEV_PORT=3015 npx playwright test e2e/render-audit.spec.ts

# Quick ad-hoc page check (no test file needed):
cd apps/web && node -e "
const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3015/things', { waitUntil: 'networkidle' });
  const text = await page.textContent('body') ?? '';
  console.log('Page loaded, length:', text.length);
  // Check for error states:
  const errors = await page.locator('.text-red-600, .text-red-500').count();
  console.log('Error elements:', errors);
  await browser.close();
})();
"
```

**When to run Playwright:**
- New pages or routes — verify they render without errors
- Changed layouts or tables — verify data displays correctly
- Display bug fixes — add a regression check to `e2e/render-audit.spec.ts`

**Existing e2e specs** (17 files in `apps/web/e2e/`): render-audit, directory-pages, entity-detail-pages, homepage, factbase, explore, mobile-nav, header-dropdowns, etc.

## 5. Completeness check

Before opening a PR, verify that **all acceptance criteria** from the issue or task description are met:

- Re-read the original issue and compare what was asked vs what was implemented
- For each acceptance criterion, cite a specific file+line or test that satisfies it
- A PR that needs a follow-up PR to be functional is **incomplete** — do not ship it
- If the scope is too large to complete in one session, split the issue into independently-shippable pieces **before** starting work, not after
- No "Part 1 of 3" PRs that break without Part 2

## 6. What to do when verification fails

Fix the issue before opening the PR. If you can't fix it:
- Note the failure in the PR description
- Do NOT open the PR and claim it works when it doesn't
- Ask the user for guidance

## Why this matters

PRs that don't build waste reviewer time. A 2-minute build check prevents a round-trip of "CI failed → fix → re-push → re-review." Build verification is the minimum bar for a PR being worth reviewing.
