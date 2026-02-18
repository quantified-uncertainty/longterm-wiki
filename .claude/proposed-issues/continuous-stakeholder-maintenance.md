# Continuous maintenance system for high-value tactical data

## Problem

The stakeholder/ownership tables are the wiki's most-shared content, but they go stale quickly. Anthropic's valuation changed from $61.5B to $183B to $350B to $380B in less than a year. Investor stakes, employee counts, and funding rounds change frequently.

Currently, updates happen only when someone manually notices stale data. For the most-shared content, we need proactive freshness.

## Proposed approach

### 1. High-priority update tracking

Add a `highPriorityUpdate` flag or list to the auto-update system. Pages flagged as high-priority get:
- Checked for staleness more frequently
- Higher budget allocation for updates
- Alerts when key facts change (e.g., new funding round announced)

Initial high-priority pages:
- `anthropic-stakeholders` (ownership data)
- `anthropic-investors` (EA capital analysis)
- `anthropic` (main company page)
- `frontier-ai-comparison` (lab comparison metrics)
- `openai` (competitor data)

### 2. Staleness detection for tabular data

For pages with tables containing dates or "as of" markers:
- Parse table cells for dates
- Flag tables where the most recent date is >30 days old
- Include in validation output: "3 high-priority tables are stale"

### 3. Auto-update integration

When the auto-update system finds news about:
- Funding rounds → update stakeholder tables
- Valuation changes → update all pages referencing that valuation
- Key hires/departures → update stakeholder and people pages
- Revenue announcements → update financial comparison tables

### 4. Cross-page consistency checks

When a key metric changes (e.g., Anthropic valuation), verify all pages referencing that metric are updated. Currently facts handle this for scalar values, but tables with hardcoded numbers need manual checking.

The datasets infrastructure (see datasets-infrastructure issue) would solve this long-term by having one canonical data source. In the interim, validation rules could flag inconsistencies.

### 5. Weekly freshness report

Add to `pnpm crux validate`:
```
High-priority staleness report:
  anthropic-stakeholders: Last updated 3 days ago ✓
  frontier-ai-comparison: Last updated 45 days ago ⚠️ STALE
  openai: Last updated 12 days ago ✓
```

## Implementation

- Short term: Add `update_frequency` scoring to prioritize auto-updates
- Medium term: Staleness detection for tables with dates
- Long term: Datasets infrastructure with automatic cross-page sync
