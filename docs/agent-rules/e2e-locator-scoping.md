# E2E Locator Scoping — Wiki Chrome Traps in `/internal/*` Specs

Read this before writing or debugging any Playwright spec that navigates to an `/internal/*` route, and before interpreting a Playwright `N × locator resolved to …` call log.

## Page-wide locators in `/internal/*` specs match wiki chrome, not just the dashboard

Several `/internal/*` dashboard routes are now `redirect()` stubs pointing at a wiki page that hosts the dashboard via an MDX component. Example: `apps/web/src/app/internal/data-quality/page.tsx` is just `redirect("/wiki/E2600")`, and the dashboard renders inside E2600 through `DataQualityContent` (from `@/app/internal/data-quality/data-quality-content`), registered in the component map in `apps/web/src/components/mdx-components.tsx`.

Consequence: a spec that does `page.goto("/internal/data-quality")` lands on a **full wiki page**. Every page-wide locator then competes with wiki chrome — `PageStatus`, sidebar, info boxes — and `PageStatus` is deliberately rendered *above* the article (`apps/web/src/app/wiki/[id]/page.tsx`), so its elements come **earlier in the DOM** than the dashboard's.

**How it fails**: `page.getByText(/^healthy$|^stale$|…/).first()` in `e2e/things-search-mv.spec.ts` resolved to `PageStatus`'s collapsed `Stale` issue badge instead of the panel's own label. The badge is hidden, so `toBeVisible()` failed while the panel was perfectly healthy. Red for ~5 weeks across 5 post-deploy runs (#4920, fix in #4961).

As of 2026-08-02 the unscoped locator is still on `main` at `apps/web/e2e/things-search-mv.spec.ts:21` — #4961 carries the fix but has not merged.

**The trigger is time, not code.** `PageStatus` pushes a `Stale` issue only when `lastEdited` is more than 60 days old *and* the page is not marked `evergreen: false` (`apps/web/src/components/PageStatus.tsx:542-553`). The test passed for months, then broke because the *page aged past the threshold*. Nothing about the dashboard changed. Expect this class to fire on any long-lived spec whenever content goes stale.

**Prevention**: in any spec targeting an `/internal/*` route, scope assertions to the panel instead of the page:

```ts
const panel = page.locator("section", {
  has: page.getByRole("heading", { name: /things_search materialized view/i }),
}).first();
await expect(panel.getByText(/^healthy$|^warning$|^stale$|^unknown$/i).first()).toBeVisible();
```

Verify the scoping actually narrowed: assert the `section` locator matches exactly 1 element, and that the decoy is excluded (`await panel.getByText(/^Stale$/).count()` → 0). A scoped locator matching nothing will time out rather than pass, but an over-broad ancestor `section` can re-admit the chrome.

Also beware page-wide `consoleErrors` assertions in these specs — they now measure a whole wiki page.

## `N × locator resolved to …` means N polls, not N matches

Playwright's call-log line `9 × locator resolved to <span>…` means the locator was **re-evaluated 9 times across the timeout**, each poll resolving to the *same* element. It does **not** mean 9 elements matched.

Misreading this sent two rounds of investigation on #4920 toward "multiple staleness rows have appeared on the dashboard" when there was exactly one decoy element, from a completely different component. Confirm real match counts with `await locator.count()` before theorising about duplicates.

## See also

- `.claude/rules/implementation-quality.md` § "Display bug fixes must include a regression check" — where each fixed display bug's permanent check belongs
- `docs/agent-rules/maintenance-sweep-discipline.md` — why this trap consumed six sweeps of budget before being written down
- #4920 (the bug), #4961 (the fix), #4980 (the request to record this)
