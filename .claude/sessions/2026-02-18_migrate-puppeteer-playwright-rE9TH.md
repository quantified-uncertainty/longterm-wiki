## 2026-02-18 | claude/migrate-puppeteer-playwright-rE9TH | Migrate Puppeteer → Playwright

**What was done:** Replaced Puppeteer with Playwright for the visual review screenshot feature. Updated `app/package.json` devDependency, rewrote `takeScreenshot()` in `crux/visual/visual-review.ts` to use Playwright's API (`chromium.launch`, `context.newPage`, `setViewportSize`, `networkidle`), and updated help text in `crux/commands/visual.ts`.

**Pages:** None

**Model:** sonnet-4

**Duration:** ~15min

**Issues encountered:**
- None

**Learnings/notes:**
- Playwright uses `browser.newContext()` → `context.newPage()` instead of `browser.newPage()` directly
- `page.waitForTimeout()` is deprecated in Playwright; used `new Promise(r => setTimeout(r, 3000))` instead
- `waitUntil: 'networkidle'` replaces Puppeteer's `'networkidle2'`
- `setViewportSize()` replaces `setViewport()`
- Playwright installed as 1.58.2 (latest available)
