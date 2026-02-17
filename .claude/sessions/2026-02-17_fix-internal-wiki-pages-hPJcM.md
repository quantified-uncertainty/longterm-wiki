## 2026-02-17 | claude/fix-internal-wiki-pages-hPJcM | DRY helpers and .md support for wiki infrastructure

**What was done:** Added `isFullWidth()` helper (eliminates 2x duplication in wiki route), `isIndexFile()` helper (eliminates 3x duplication in wiki-nav), and `.md` file support in research report generator. Rebased after parallel work on main superseded the original internal-page routing changes.

**Pages:** (no page content changes — infrastructure only)

**PR:** #180

**Issues encountered:**
- Major rebase conflict: main merged opposite architectural approach (internal pages route through `/wiki/E<id>` instead of `/internal/*`), superseding ~80% of original PR changes
- Had to reset to main and apply only the still-additive DRY/defensive changes

**Learnings/notes:**
- Main now routes internal pages through `/wiki/E<id>` with `isInternal` checks to hide wiki-only UI — our original `/internal/*` rendering approach was superseded
- `findMdxFiles()` in `crux/lib/file-utils.ts` already supports `.md`, so validate-mdx-compile.ts didn't need changes
- When parallel PRs diverge architecturally, better to reset to main and cherry-pick additive changes than attempt a complex rebase
