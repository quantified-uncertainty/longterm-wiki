## 2026-02-15 | claude/extract-wiki-interventions-WpOs4 | Extract wiki proposals as structured data

**What was done:** Created two new data layers:
1. **Interventions** (broad categories): Extended `Intervention` schema with risk coverage matrix, ITN prioritization, funding data. Created `data/interventions.yaml` with 14 broad intervention categories. `InterventionCard`/`InterventionList` components.
2. **Proposals** (narrow, tactical): New `Proposal` data type for specific, speculative, actionable items extracted from wiki pages. Created `data/proposals.yaml` with 27 proposals across 6 domains (philanthropic, financial, governance, technical, biosecurity, field-building). Each has cost/EV estimates, honest concerns, feasibility, stance (collaborative/adversarial). `ProposalCard`/`ProposalList` components.

**Pages:** anthropic-pledge-enforcement, ea-shareholder-diversification-anthropic, whistleblower-protections, hardware-enabled-governance, evals-governance, openai-foundation-governance, blueprint-biosecurity, securedna, ea-biosecurity-scope, worldview-intervention-mapping, intervention-portfolio

**Issues encountered:**
- None

**Learnings/notes:**
- "Proposal" name chosen to distinguish from existing "Intervention" ontology. Proposals are narrow tactical actions (e.g., "Help founders transfer equity to DAFs") vs. broad categories (e.g., "Compute Governance").
- The E411 page (anthropic-pledge-enforcement) was the template: each proposal has name, description, cost estimate, EV estimate, honest concerns, stance, lead organizations.
- Proposals span 6 domains: philanthropic (7), financial (4), governance (7), technical (1), biosecurity (5), field-building (3).
