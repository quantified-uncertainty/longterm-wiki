# Ontology Review

Deep analysis of an entity's ontological structure: what sub-entities should exist, what relationships are missing, and how statements should be organized. Produces a structured report with actionable recommendations.

**When to use:** When an entity has accumulated many statements (50+) and you suspect the information would be better served by splitting into sub-entities, or when you want to reason about how an entity fits into the broader knowledge graph.

**Argument:** Entity slug (e.g., `anthropic`, `openai`, `deepmind`). If no argument, ask the user which entity to review.

## Phase 1: Gather Context

Collect all relevant data about the entity. Run these in parallel where possible:

```bash
# Entity metadata and related entities
curl -s "http://localhost:3100/api/entities/$ENTITY_ID" | python3 -m json.tool

# All active statements for this entity
pnpm crux statements quality $ENTITY_ID

# Coverage gaps
pnpm crux statements gaps $ENTITY_ID

# Quick automated cluster analysis (cheap Sonnet call for initial signal)
pnpm crux statements ideate $ENTITY_ID --json
```

Also fetch:
- The entity's wiki page content (read the MDX file via `pnpm crux context for-page $ENTITY_ID`)
- Related entities' metadata (check each entity in `relatedEntries`)
- Statement counts for related entities (to understand relative coverage)

**Read all outputs carefully before proceeding.** The automated `ideate` gives you clusters — but you need to think deeper than pattern-matching.

## Phase 2: Ontological Reasoning

This is the core of the skill. Think carefully about these questions — spend real time reasoning, don't rush to conclusions.

### 2a. Entity Identity

For the parent entity, answer:
- What *is* this entity fundamentally? (An org? A research program? A product?)
- What information belongs *inherently* on this entity vs. being about something else?
- If a reader searches for this entity by name, what do they expect to find?

### 2b. Sub-Entity Candidates

For each potential sub-topic in the statements, evaluate:
- **Does this have its own identity?** Would someone search for it by name? Does it have its own Wikipedia page or equivalent?
- **Is it a thing or a category?** "Claude" is a thing. "Anthropic's financial history" is a category of facts *about* Anthropic — not its own entity.
- **Granularity test:** Is this too fine-grained (individual model versions like "Claude Sonnet 4.6") or too coarse ("AI safety research")?
- **The Wikipedia test:** Would this warrant its own Wikipedia article, or would it be a section within the parent article?

### 2c. Relationship Analysis

For the entity's existing `relatedEntries`:
- Are any relationships missing? (e.g., Anthropic → constitutional-ai exists as an entity but isn't in relatedEntries)
- Are relationship labels accurate? ("research" vs "product-of" vs "technique-of")
- Are there entities in the DB that *should* be related but aren't?

Search the entity database for potential missing relationships:
```bash
# Search for entities that might be related
pnpm crux query search "<parent entity name>"
pnpm crux query search "<key product/project names>"
```

### 2d. Statement Placement

For statements that seem misplaced:
- Which statements are clearly about a sub-entity rather than the parent?
- Which statements could belong to multiple entities? (These should stay on the parent or use the `includeChildren` roll-up query)
- Are there statements that reference entities that don't exist yet?

### 2e. Type System Assessment

Consider whether the current entity types serve this entity well:
- Is the entity's `entityType` correct?
- Do suggested sub-entities fit cleanly into existing canonical types (project, concept, policy, model, approach, etc.)?
- If not, note what type would be ideal — but don't invent new types; map to the closest existing one.

## Phase 3: Write the Report

Produce a structured report. Be specific — reference statement IDs, entity slugs, and concrete evidence.

### Report Format

```md
## Ontology Review: [Entity Name] ([entity-type])

### Summary
[2-3 sentence executive summary: is this entity well-organized? What's the main finding?]

### Current State
- Statements: [count] active
- Related entities: [list with types]
- Coverage score: [if available]
- Key gaps: [from gap analysis]

### Recommended Sub-Entities

For each recommended new entity:

#### [Suggested Title] (`suggested-slug`, [entity-type])
- **Identity:** [Why this is a distinct thing, not just a category]
- **Relationship:** [how it relates to parent — product-of, research-of, etc.]
- **Statements to move:** [count] (IDs: ...)
- **Priority:** High/Medium/Low
- **Notes:** [Any caveats, overlaps with existing entities]

### Relationship Fixes
- [Entity A] → [Entity B]: Add "[relationship-type]" (currently missing)
- [Entity C] → [Entity D]: Change "[old-rel]" to "[new-rel]"

### Statements to Reassign (to existing entities)
- Statement [ID]: "[text]" → move to [existing-entity] (currently about a different subject)

### Do NOT Split
[List topics that might look like candidates but should stay on the parent, with reasoning]

### Broader Observations
[Any insights about the knowledge graph structure, missing entity types, etc.]
```

## Phase 4: Execute (with approval)

Present the report to the user. Then, if they approve:

1. **Create new entities** — For each approved sub-entity:
   ```bash
   pnpm crux ids allocate <slug>
   ```
   Then sync via the API.

2. **Move statements** — Use the PATCH endpoint:
   ```bash
   # For each statement to move:
   curl -X PATCH "http://localhost:3100/api/statements/<ID>" \
     -H "Content-Type: application/json" \
     -d '{"subjectEntityId": "<new-entity-slug>"}'
   ```

3. **Fix relationships** — Update `relatedEntries` via entity sync.

4. **Verify** — After changes, re-run `pnpm crux statements quality <entity>` to confirm the parent entity's coverage still makes sense, and check the new entities have statements.

**Always ask before executing.** The report is the deliverable — execution is optional and requires explicit approval.

## Guardrails

- **Think, don't pattern-match.** The automated `ideate` command does pattern-matching. Your job is deeper reasoning about what *should* exist, not just what clusters appear in the data.
- **Conservative by default.** Fewer high-quality entity splits are better than many marginal ones. If you're unsure, recommend keeping it on the parent.
- **Don't split property groupings.** Financial data, market metrics, headcount — these are facts *about* the entity, not separate entities. Never suggest "anthropic-funding" as an entity.
- **The roll-up exists.** Remember that `?includeChildren=true` lets viewers see parent + child statements together. This reduces the cost of splitting — but don't split just because you can.
- **Don't create entities without pages.** An entity in the DB without a wiki page is an orphan. Note in the report which entities would need wiki pages created afterward.
- **Respect existing structure.** Check what entities already exist before suggesting new ones. The knowledge base already has 600+ entities — duplication is the bigger risk than under-splitting.
