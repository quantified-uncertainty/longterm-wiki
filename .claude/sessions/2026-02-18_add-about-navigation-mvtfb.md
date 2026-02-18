## 2026-02-18 | claude/add-about-navigation-mvtfb | Add About navigation section

**What was done:** Added an "About" section to the header navigation and sidebar, separating user-facing pages (About This Wiki, Vision, Strategy, Roadmap, Value Proposition) from the developer-focused Internal section. About pages get their own sidebar, breadcrumbs, and are no longer marked as noindex for search engines.

**Model:** opus-4-6

**Duration:** ~20min

**Issues encountered:**
- None

**Learnings/notes:**
- About pages still physically live under `content/docs/internal/` but are detected via `isAboutPage()` slug matching in `wiki-nav.ts`. Future work could move them to a dedicated `content/docs/about/` directory.
- The `ABOUT_PAGE_SLUGS` set in `wiki-nav.ts` must be updated when adding new about pages.
