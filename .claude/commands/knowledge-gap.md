# Knowledge Gap Analysis

Identify what's missing from the knowledge base: topics without entities, entities without statements, thin coverage areas, and important relationships that don't exist yet.

**When to use:** Periodically (monthly), or when planning what content to create next. Produces a prioritized list of gaps with recommendations.

**Argument:** Optional focus area (e.g., `frontier-labs`, `safety-techniques`, `governance`, `models`). If no argument, do a broad scan.

## Phase 1: Survey Current Coverage

Gather quantitative data about what exists.

```bash
# Entity stats by type
curl -s "http://localhost:3100/api/entities/stats" | python3 -m json.tool

# Statement stats
curl -s "http://localhost:3100/api/statements/stats" | python3 -m json.tool

# Top entities by statement count (proxy for coverage depth)
curl -s "http://localhost:3100/api/statements?limit=5000" | python3 -c "
import sys, json
d = json.load(sys.stdin)
counts = {}
for s in d['statements']:
    eid = s.get('subjectEntityId', '?')
    if s.get('status') == 'active':
        counts[eid] = counts.get(eid, 0) + 1
for e, c in sorted(counts.items(), key=lambda x: -x[1])[:30]:
    print(f'  {e}: {c}')
print(f'Total entities with statements: {len(counts)}')
"

# List entity types and their counts
curl -s "http://localhost:3100/api/entities?limit=1000" | python3 -c "
import sys, json
d = json.load(sys.stdin)
types = {}
for e in d['entities']:
    t = e.get('entityType', '?')
    types[t] = types.get(t, 0) + 1
for t, c in sorted(types.items(), key=lambda x: -x[1]):
    print(f'  {t}: {c}')
"
```

Also check the wiki pages to see what content exists:
```bash
# Count content pages by subcategory
pnpm crux query search "" 2>&1 | head -5  # total count
```

## Phase 2: Identify Gaps

Think about the AI safety knowledge landscape systematically. Consider these dimensions:

### 2a. Entity Coverage Gaps

Using your knowledge of AI safety, identify important topics that should have entities but don't. Consider:

**Organizations:** Are all major AI labs represented? (Anthropic, OpenAI, DeepMind, Meta AI, Mistral, xAI, Cohere, etc.) What about policy orgs (CAIS, FHI, MIRI, ARC, Redwood)? Government bodies (AISI, NIST AI)?

**Models:** Are major model families represented? (GPT-4, Claude, Gemini, Llama, Mistral, etc.)

**Safety Techniques:** RLHF, Constitutional AI, DPO, debate, scalable oversight, interpretability methods — what's covered, what's missing?

**Risks:** Misalignment, deceptive alignment, power-seeking, bioweapons, cyber offense, persuasion/manipulation — which have entities?

**Policies:** EU AI Act, US executive orders, frontier model guidelines, voluntary commitments — what's tracked?

**Events:** Major incidents, conferences, pivotal moments in AI safety history.

Search for each topic you think should exist:
```bash
pnpm crux query search "<topic>"
```

### 2b. Statement Depth Gaps

For entities that DO exist, check which ones have thin coverage:
- Entities with 0 statements (have a wiki page but no structured data)
- Entities with <10 statements (probably need improvement runs)
- Entities with statements but poor coverage scores

### 2c. Relationship Gaps

Look for missing connections in the knowledge graph:
- Major partnerships/collaborations not tracked (e.g., OpenAI-Microsoft, Google-DeepMind)
- Research that should be linked to the org that produced it
- Policies that should be linked to the orgs they govern
- Risks that should be linked to the approaches that address them

### 2d. Recency Gaps

Check for important recent developments (last 6 months) that aren't reflected:
- New model releases
- New policies or regulations
- Major safety incidents
- Organizational changes (mergers, leadership changes, new labs)

## Phase 3: Write the Report

```
## Knowledge Gap Analysis — [DATE]

### Coverage Summary
- Total entities: [N] across [N] types
- Entities with statements: [N] / [N]
- Entities with 50+ statements: [list]
- Entities with 0 statements: [count]

### Critical Gaps (Priority 1)
[Important topics that are completely absent from the knowledge base]

For each:
- **Topic:** [name]
- **Why it matters:** [1 sentence]
- **Suggested entity type:** [type]
- **Suggested slug:** [slug]
- **Related existing entities:** [list]

### Depth Gaps (Priority 2)
[Entities that exist but are severely under-covered]

### Relationship Gaps (Priority 3)
[Missing connections between existing entities]

### Recency Gaps (Priority 4)
[Recent developments not yet captured]

### Recommendations
Prioritized action list:
1. [Most impactful gap to fill first]
2. ...
```

## Phase 4: Execute (with approval)

If the user approves, pick the highest-priority gaps and:

1. **Create missing entities:**
   ```bash
   pnpm crux ids allocate <slug>
   ```

2. **Generate initial statements:**
   ```bash
   pnpm crux statements improve <entity-id> --budget=5
   ```

3. **Create wiki pages:**
   ```bash
   pnpm crux content create "<Title>" --tier=standard
   ```

4. **Fix relationships:** Update `relatedEntries` via entity sync.

**Always present the report first and get approval before creating anything.**

## Guardrails

- **Use your AI safety knowledge.** You know this field — don't just look at what data is missing; reason about what data *should* exist for a comprehensive AI safety knowledge base.
- **Prioritize by importance, not ease.** A missing page on a major lab matters more than a missing page on a minor research paper.
- **Don't create empty entities.** Only suggest entities you're confident can be populated with 10+ meaningful statements.
- **Check before suggesting.** Always search the existing database before claiming something is missing — it might exist under a different name or slug.
- **Focus area matters.** If the user specified a focus area, limit your analysis to that domain rather than trying to cover everything.
