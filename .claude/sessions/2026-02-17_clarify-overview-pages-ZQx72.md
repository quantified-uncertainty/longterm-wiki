## 2026-02-17 | claude/clarify-overview-pages-ZQx72 | Add (Overview) to overview page titles

**What was done:** Updated all 36 overview page titles to include "(Overview)" suffix, making it immediately clear to readers that these are overview/index pages rather than regular articles. For example, "Structural Risks" became "Structural Risks (Overview)".

**Pages:** structural-overview, accident-overview, misuse-overview, epistemic-overview, governance-overview, biosecurity-overview, alignment-policy-overview, alignment-evaluation-overview, alignment-deployment-overview, alignment-training-overview, alignment-interpretability-overview, alignment-theoretical-overview, epistemic-tools-approaches-overview, epistemic-tools-tools-overview, track-records-overview, labs-overview, safety-orgs-overview, funders-overview, epistemic-orgs-overview, government-orgs-overview, biosecurity-orgs-overview, venture-capital-overview, community-building-overview, factors-overview, factors-ai-capabilities-overview, factors-ai-ownership-overview, factors-ai-uses-overview, factors-civilizational-competence-overview, factors-misalignment-potential-overview, factors-misuse-potential-overview, factors-transition-turbulence-overview, outcomes-overview, scenarios-overview, scenarios-ai-takeover-overview, scenarios-human-catastrophe-overview, scenarios-long-term-lockin-overview

**Issues encountered:**
- None

**Learnings/notes:**
- Overview pages use `sidebar: label: Overview` but the page title itself had no "Overview" indicator
- 14 of the 36 overview pages are also entities (have `entityType` in frontmatter); the title change affects their entity display name too
