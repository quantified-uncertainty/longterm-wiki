# Structured datasets infrastructure for cross-page tabular data

## Context

The most-shared content on the wiki is the Anthropic stakeholder ownership table — concrete, named individuals with specific percentages and dollar amounts. This kind of tactical, tabular data needs to:

1. Live in a structured format (not hardcoded in MDX prose)
2. Be embeddable from multiple pages (e.g., show a condensed version on the main Anthropic page, full version on the stakeholders page)
3. Be version-controlled and auditable
4. Stay in sync when updated

Currently there's no infrastructure for this. The facts system is scalar-only (single values per entity per time period). Entities store metadata, not content tables. The ATM content model has structured YAML with tables but is specialized for one page type.

## Proposed approach: `data/datasets/` directory

Create a new data type parallel to facts and entities:

```
data/datasets/
  anthropic-stakeholders.yaml
  ai-lab-comparison.yaml
  ai-safety-funder-ranking.yaml
```

### Schema example

```yaml
id: anthropic-stakeholders
title: "Anthropic Stakeholder Ownership"
description: "Who owns Anthropic and how much"
asOf: "2026-02"
columns:
  - id: stakeholder
    label: "Stakeholder"
    type: string
  - id: category
    label: "Category"
    type: string
  - id: stake
    label: "Est. Stake"
    type: string
  - id: value
    label: "Value at $380B"
    type: currency
  - id: notes
    label: "Notes"
    type: string
rows:
  - stakeholder: "Dario Amodei"
    entityLink: dario-amodei
    category: "Co-founder, CEO"
    stake: "2-3%"
    value: "$7.6-11.4B"
    notes: "GWWC signatory; pledged 80%"
  # ... more rows
referencedBy:
  - page: anthropic
    variant: condensed  # show fewer columns
  - page: anthropic-stakeholders
    variant: full
```

### Components needed

- `<DatasetTable id="anthropic-stakeholders" />` — full table
- `<DatasetTable id="anthropic-stakeholders" variant="condensed" />` — fewer columns
- `<DatasetTable id="anthropic-stakeholders" filter="category=Co-founder" />` — filtered view

### Build pipeline integration

- Load datasets in `build-data.mjs`
- Include in `database.json`
- Validate schema (column types, required fields)
- Track `asOf` dates for staleness warnings

### Related

- Closes the cross-page data sharing gap identified in #149
- Would replace hardcoded tables in MDX that go stale across pages
- First datasets: anthropic-stakeholders, ai-lab-comparison, ai-safety-funder-ranking

## Implementation estimate

Medium-large effort: schema design, YAML loader, build pipeline integration, React component, 3-5 initial datasets.
