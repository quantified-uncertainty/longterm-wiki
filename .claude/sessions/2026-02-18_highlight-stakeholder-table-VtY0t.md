## 2026-02-18 | claude/highlight-stakeholder-table-VtY0t | Create dedicated Anthropic stakeholder page

**What was done:** Created a new dedicated `anthropic-stakeholders` page with the most shareable ownership tables (all stakeholders with stakes, values, EA alignment), added a condensed stakeholder summary to the top of the main Anthropic page, and wrote 4 proposed GitHub issues for broader system changes (datasets infrastructure, importance metrics rethink, concrete data expansion, continuous maintenance).

**Pages:** anthropic-stakeholders, anthropic

**Model:** opus-4-6

**Duration:** ~30min

**Issues encountered:**
- GitHub CLI not installed and token expired, so issues were written as markdown files in `.claude/proposed-issues/` instead of created directly

**Learnings/notes:**
- The facts system is scalar-only and cannot store tabular data — a new `data/datasets/` infrastructure is needed for cross-page table embedding
- The importance scoring system systematically undervalues tactical, concrete, shareable content (anthropic-investors has readerImportance: 33 despite being the most-shared content)
- The ATM content model has YAML-stored tables but is specialized and not general-purpose
- Issue #149 (closed) previously identified the cross-page data sharing gap
