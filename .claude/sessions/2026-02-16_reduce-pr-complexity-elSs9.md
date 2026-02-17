## 2026-02-16 | claude/reduce-pr-complexity-elSs9 | Remove low-value validation rules and insights system

**What was done:** Audited last 20 PRs for unnecessary complexity. Removed 4 low-value validation rules (entity-mentions, mermaid-style, quality-source, human-attribution) and the entire insights data layer (18K lines YAML, 6 data files, CLI commands, components, internal page). Reduces rule count from 40 to 36 and eliminates an underused data subsystem.

**Pages:** insights

**PR:** #175

**Issues encountered:**
- None

**Learnings/notes:**
- The insights system was built end-to-end but only used on 1 page — classic over-engineering
- Most validation rules are genuinely useful; only 4 were clearly low-value
- structuralQualityRule was initially flagged for removal but is used in the grading pipeline, so it was kept
- The vitest `no-human-attribution.test.ts` already covers source code scanning, making the crux `human-attribution` rule redundant for source files
