# Entity Deep Dive

Comprehensive review of a single entity: its wiki page, statements, relationships, and overall quality. Identifies issues and makes improvements.

**When to use:** When you want to bring an entity up to high quality — not just run the improve pipeline, but actually reason about whether the entity's information is complete, accurate, well-organized, and well-connected.

**Argument:** Entity slug (e.g., `anthropic`). Required.

## Phase 1: Assess Current State

Gather everything about this entity:

```bash
# Full context (page + entity + facts)
pnpm crux context for-page $ENTITY_ID

# Check the wiki page content
pnpm crux query search "$ENTITY_ID"
```

Read the wiki page MDX file if it exists. Read the entity's YAML definition if it exists.

Also check:
- What other entities reference this one? (backlinks)
- How does this entity's coverage compare to similar entities of the same type?

## Phase 2: Evaluate Quality Dimensions

For each dimension, rate the entity and identify specific issues:

### 2a. Completeness
- Does the entity have all the facts a knowledgeable reader would expect?
- Are there obvious gaps? (e.g., an organization missing founding date, headcount, key products)
- Compare to what you know about this topic — what's missing?

### 2b. Accuracy
- Do the statements look correct based on your knowledge?
- Are there statements that seem outdated or contradicted by more recent information?
- Are numeric values plausible? (funding amounts, dates, percentages)

### 2c. Organization
- Are statements well-categorized with appropriate properties?
- Are there statements that should be on a sub-entity instead? (Use `/ontology-review` for deep analysis)
- Is the wiki page well-structured with appropriate sections?

### 2d. Connections
- Does the entity have appropriate `relatedEntries`?
- Are there missing links to other entities that should exist?
- Do citations reference real, accessible sources?

### 2e. Recency
- When was this entity last updated?
- Are there important recent developments not captured?
- Are any statements stale (e.g., "as of 2024" when it's now 2026)?

## Phase 3: Make Improvements

Based on your assessment, take action in priority order:

1. **Fix factual errors** — Correct inaccurate information in the wiki page and KB facts
2. **Fill critical gaps** — Add missing KB facts to `packages/kb/data/things/`
3. **Fix relationships** — Update `relatedEntries` to add missing connections
4. **Update stale content** — Fix outdated information with current data
5. **Improve the wiki page** — If the MDX page is thin, run `pnpm crux content improve $ENTITY_ID --tier=standard --apply`

## Phase 4: Report

Summarize what you found and what you changed:

```md
## Entity Deep Dive: [Entity Name]

### Quality Assessment
| Dimension | Rating | Notes |
|-----------|--------|-------|
| Completeness | Good/Fair/Poor | ... |
| Accuracy | Good/Fair/Poor | ... |
| Organization | Good/Fair/Poor | ... |
| Connections | Good/Fair/Poor | ... |
| Recency | Good/Fair/Poor | ... |

### Changes Made
- [list of specific changes: statements added/retracted, relationships fixed, etc.]

### Remaining Issues
- [things that need human input or are out of scope]

### Recommendations
- [suggestions for future work on this entity]
```

## Guardrails

- **Read before writing.** Always assess the current state fully before making any changes.
- **Don't over-generate.** Running `improve` with a high budget can create mediocre statements. Better to run targeted improvements for specific gaps.
- **Verify claims.** If you're adding factual statements, make sure they're well-sourced. Don't add statements you're not confident about.
- **Respect existing quality.** Don't retract statements just because they're simple or short — only retract if they're actually wrong or fully superseded.
- **Log what you do.** Every change should be noted in the report so the user can review.
