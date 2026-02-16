## 2026-02-16 | claude/code-review-refactoring-1RpWV | Deep code review for refactoring opportunities

**What was done:** Conducted comprehensive code review across all major codebase areas (app/, crux/, build scripts, data layer, tests) identifying 26 refactoring opportunities organized by priority. Produced CODE-REVIEW.md with detailed findings, file locations, and a phased refactoring roadmap.

**Issues encountered:**
- None

**Learnings/notes:**
- Frontmatter scanner only scans 3 of 10 content directories — real bug that should be fixed
- `withRetry` and `startHeartbeat` are duplicated identically in two crux authoring files
- metrics-extractor has two diverging implementations (.mjs for build, .ts for crux)
- Build script writes numericIds to MDX files as a side effect during builds, which can leave repo in inconsistent state on failure
- 6 files exceed 700 lines and mix multiple concerns
