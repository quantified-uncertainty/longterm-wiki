## 2026-02-13 | claude/add-evergreen-flag-zhlon | Auto-default evergreen flag for internal/project pages

**What was done:** Added path-based auto-detection so all `internal/` and `project/` pages are treated as non-evergreen by default (excluded from update scheduling), without needing explicit `evergreen: false` in every page's frontmatter. Added `evergreen: false` to 9 additional point-in-time pages and `evergreen: true` to `critical-insights` (which has `update_frequency` and should stay on the schedule).

**Pages:** gap-analysis-2026-02, page-length-research, anthropic-pages-refactor-notes, enhancement-queue, reports/index, research-reports, similar-projects, strategy-brainstorm, vision, critical-insights

**Issues encountered:**
- `critical-insights.mdx` in `project/` has `update_frequency: 45` — needed explicit `evergreen: true` to opt back in under the new path-based default

**Learnings/notes:**
- The `isPageEvergreen()` helper in `crux/lib/content-types.ts` centralizes the logic: explicit frontmatter wins, then path-based default for `internal/` and `project/` dirs
- The same logic is mirrored in `build-data.mjs` for the frontend UI badge
- New internal/project pages will automatically be excluded from update scheduling without any manual flagging
