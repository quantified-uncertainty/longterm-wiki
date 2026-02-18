## 2026-02-18 | claude/resolve-issue-251-XhJkg | Remove legacy pageTemplate frontmatter

**What was done:** Removed the legacy `pageTemplate` frontmatter field from 15 MDX files. This field was carried over from the Astro/Starlight era and is not used by the Next.js application.

**Pages:** table, cause-effect-demo, deployment-architectures-table, architecture-scenarios-table, reducing-hallucinations, safety-generalizability-table, accident-risks-table, safety-approaches-table, pre-tai-capital-deployment, ai-talent-market-dynamics, ai-megaproject-infrastructure, safety-spending-at-scale, eval-types-table, frontier-lab-cost-structure, planning-for-frontier-lab-scaling

**Model:** opus-4-6

**Duration:** ~10min

**Issues encountered:**
- None

**Learnings/notes:**
- The `pageTemplate` field is still referenced in crux grading code (`page-templates.ts`, `grade-by-template.ts`) but those paths handle missing values gracefully via null checks, so removal from MDX is safe without code changes.
