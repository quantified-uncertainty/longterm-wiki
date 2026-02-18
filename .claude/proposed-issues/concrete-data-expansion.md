# Expand concrete shareable data tables to other high-value pages

## Context

The Anthropic stakeholder table is the wiki's most-shared content because it provides named individuals + specific percentages + dollar amounts in a single screenshottable table. We should systematically identify and create similar content for other high-value topics.

## Candidate pages for concrete data tables

### High priority (existing pages that could add shareable tables)

1. **OpenAI stakeholders** — Who owns what after the restructuring? Foundation 26% ($130B), Microsoft 49%, employee equity. No consolidated table exists.

2. **AI safety funder ranking** — Table of top funders with: name, 2024-2025 giving, lifetime giving, % to AI safety, primary vehicle. Data exists scattered across Moskovitz, Tallinn, Coefficient Giving pages but not consolidated.

3. **AI lab employee compensation** — Base salary ranges, equity packages, matching programs across Anthropic/OpenAI/DeepMind/xAI. Highly shareable for recruiting/career decisions.

4. **Frontier AI lab comparison** — Already exists at `frontier-ai-comparison.mdx` but could be more focused on the most screenshot-worthy metrics.

5. **AI safety org budgets** — Annual budgets, headcounts, cost-per-researcher for MIRI, ARC, METR, CAIS, Redwood, etc. Would be very useful for funders.

### Medium priority

6. **Anthropic co-founder net worth estimates** — Individual wealth estimates from equity (currently missing as individual data points)

7. **EA capital flow summary** — Where the money goes: Coefficient Giving grants by cause area, SFF distributions, etc.

8. **AI governance policy tracker** — Specific bills, executive orders, international agreements with status/dates

### Approach for each

For each candidate:
1. Identify data sources (existing wiki pages, public filings, news reports)
2. Create the consolidated table on a dedicated page
3. Add a condensed version on the parent topic page
4. Set high `update_frequency` to ensure freshness
5. Eventually migrate to the datasets infrastructure (see datasets-infrastructure issue)

## Process for continuous discovery

The auto-update and content improvement systems should look for opportunities to create shareable tables:
- When processing news about funding rounds, ownership changes, or organizational data
- When improving pages that contain prose descriptions of data that could be tabular
- Prompt templates should encourage creating concrete, specific tables over abstract analysis

## Success metric

More pages with screenshot-worthy tables that tell complete stories at a glance.
