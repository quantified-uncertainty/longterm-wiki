## 2026-02-18 | claude/resolve-issue-248-ZKWIC | Break up oversized crux files + review fixes

**What was done:** Further split two remaining oversized modules (grading/index.ts 488 lines, link-checker/checkers.ts 463 lines) into focused sub-modules. Then did a paranoid review and fixed all issues: new TS type error in processPage (Anthropic|null→Anthropic), shim over-exports, extractFrontmatter alias, Metrics inline type, contentFormat cast, stats empty guard, check-links.ts module error, and added 38 unit tests for getCheckStrategy.

**Model:** sonnet-4

**Duration:** ~45min

**Issues encountered:**
- `crux/tsconfig.json` is not checked by the gate's `tsc --noEmit` step (uses app tsconfig only) — 14+ pre-existing crux TypeScript errors are invisible to CI
- Extracting `processPage` from a closure to a top-level function introduced a new TS type error (`Anthropic|null` instead of `Anthropic`) — fixed
- checkers.ts shim was over-exporting 4 previously-private functions — fixed

**Learnings/notes:**
- When extracting closures to top-level functions, check that captured variable types (especially after `!` non-null assertions) are preserved in the new parameter signature
- The gate's `tsc --noEmit` targets `app/tsconfig.json`, not `crux/tsconfig.json` — crux TypeScript errors are silent in CI. A follow-up issue should add crux to the gate once the 14 pre-existing errors are cleaned up.
