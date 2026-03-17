---
name: PG-primary for new features with dedicated UI
description: Strongly prefer PG-primary tables over YAML entities when building new features with dedicated directory pages and structured data
type: feedback
---

Strongly prefer PG-primary tables (grants/investments/funding-rounds/benchmarks pattern) for new features with dedicated UI/directory pages.

**Why:** When asked to design a "political races" feature, I defaulted to the YAML entity pattern (data/entities/*.yaml) because most entity types use it. The user had to redirect me to the PG-primary pattern, which was clearly a better fit for structured relational data with numeric aggregation, many-to-many relationships, and its own directory page.

**How to apply:** When designing storage for a new data type, ask: does it have numeric fields to sort/aggregate? Many-to-many relationships? Its own directory page? If yes to any, use PG-primary tables following the grants/investments pattern — not YAML entities. YAML entities are for lightweight catalog entries (link targets, wiki page metadata). Added guidance to CLAUDE.md Entity Directory Pages section.
