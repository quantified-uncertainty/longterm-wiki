## 2026-02-15 | claude/extract-wiki-interventions-WpOs4 | Extract wiki proposals as structured data

**What was done:** Created two new data layers:
1. **Interventions** (broad categories): Extended `Intervention` schema with risk coverage matrix, ITN prioritization, funding data. Created `data/interventions.yaml` with 14 broad intervention categories. `InterventionCard`/`InterventionList` components.
2. **Proposals** (narrow, tactical): New `Proposal` data type for specific, speculative, actionable items extracted from wiki pages. Created `data/proposals.yaml` with 27 proposals across 6 domains (philanthropic, financial, governance, technical, biosecurity, field-building). Each has cost/EV estimates, honest concerns, feasibility, stance (collaborative/adversarial). `ProposalCard`/`ProposalList` components.

Post-review fixes: Fixed 13 incorrect wikiPageId E-codes in interventions.yaml (used numeric IDs instead of entity slugs). Added Intervention + Proposal to schema validator. Extracted shared badge color maps from 4 components into `badge-styles.ts`. Removed unused `client:load` prop and `fundingShare` destructure.

**Pages:** anthropic-pledge-enforcement, ea-shareholder-diversification-anthropic, whistleblower-protections, hardware-enabled-governance, evals-governance, openai-foundation-governance, blueprint-biosecurity, securedna, ea-biosecurity-scope, worldview-intervention-mapping, intervention-portfolio

**Issues encountered:**
- interventions.yaml had wikiPageId set to numeric E-codes (E174, E6, etc.) instead of entity slugs. Fixed.
- `replace_all` on `E6` also caught `E64`, creating `ai-control4`. Caught and fixed.

**Learnings/notes:**
- "Proposal" name chosen to distinguish from existing "Intervention" ontology. Proposals are narrow tactical actions (e.g., "Help founders transfer equity to DAFs") vs. broad categories (e.g., "Compute Governance").
- The E411 page (anthropic-pledge-enforcement) was the template: each proposal has name, description, cost estimate, EV estimate, honest concerns, stance, lead organizations.
- Proposals span 6 domains: philanthropic (7), financial (4), governance (7), technical (1), biosecurity (5), field-building (3).
- Schema validator (`validate-yaml-schema.ts`) previously only validated Entity, Resource, Publication. Now also validates Intervention (14) and Proposal (27).
