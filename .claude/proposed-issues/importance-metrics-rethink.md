# Rethink importance metrics to value concrete, shareable content

## Problem

The current `readerImportance` and `researchImportance` metrics systematically undervalue the wiki's most-shared content. The Anthropic stakeholder table — the single most screenshotted and shared piece of content — lives on a page with `readerImportance: 33`. Meanwhile abstract overview topics score 70+.

The scoring system rewards:
- Breadth of topic coverage
- Abstract, high-level conceptual importance
- Academic/research relevance

But the most valuable content (measured by actual sharing/engagement) is:
- Concrete numbers with named individuals
- Tactical data that tells a complete story in one table
- Low-hallucination-risk factual compilations
- Easily screenshottable summaries

## Proposed changes

### 1. Add a "shareability" or "tactical value" dimension

New frontmatter field (e.g., `tacticalValue` or `shareability`) that captures:
- How concrete/specific is the data?
- How self-contained is it (can someone understand it without reading the full page)?
- How frequently is it likely to be referenced/shared?

### 2. Factor tactical value into importance rankings

The auto-update system, content improvement prioritization, and maintenance sweeps should weight tactical value alongside reader/research importance when deciding what to update first.

### 3. Audit existing importance scores

Pages with high tactical value but low importance scores:
- `anthropic-investors` (readerImportance: 33) — stakeholder ownership tables
- `frontier-ai-comparison` — side-by-side lab metrics
- `dustin-moskovitz` — specific giving amounts by year
- `coefficient-giving` — grantee names with dollar amounts

Pages that may be over-scored relative to actual reader value:
- Abstract concept pages that get high scores but low sharing
- Theoretical framework pages with high research importance but low practical use

### 4. Consider "highlight tables" as a content type

Some pages' most valuable content is a single table. The importance system should recognize that a page containing one high-value table may matter more than a page with extensive prose on an abstract topic.

## Implementation

1. Add `tacticalValue` (0-100) to frontmatter schema
2. Score existing pages (could be automated based on: number of tables, presence of named entities + dollar amounts, etc.)
3. Update ranking algorithms to incorporate tactical value
4. Update auto-update prioritization to prefer refreshing high-tactical-value pages
