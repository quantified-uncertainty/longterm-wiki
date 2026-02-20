---
numericId: E721
title: "AI Transition Model Style Guide"
description: "Style guide for AI Transition Model factor, scenario, and parameter pages"
sidebar:
  order: 12
entityType: internal
quality: 32
readerImportance: 39
researchImportance: 61.5
lastEdited: "2026-02-17"
update_frequency: 90
evergreen: true
llmSummary: "Internal style guide documenting YAML-first architecture for AI Transition Model pages, specifying that ratings and metadata live in YAML while MDX contains only custom prose. Provides validation workflows and anti-patterns for maintaining consistency across factor, parameter, and scenario entities."
ratings:
  novelty: 0.5
  rigor: 4
  actionability: 5
  completeness: 6
---
# AI Transition Model Style Guide

The AI Transition Model (ATM) is a structured framework for understanding AI development trajectories. ATM pages differ from regular knowledge base content—they follow a specific schema and use YAML as the source of truth.

**Prerequisite**: All ATM pages must follow the [Common Writing Principles](/wiki/E726) — epistemic honesty, language neutrality, and analytical tone. The **objectivity** rating dimension measures this.

## Page Type Detection

ATM pages are detected by URL: `/ai-transition-model/**/*.mdx`

## Key Difference from Knowledge Base

**YAML is the source of truth** for ATM pages:

| Data | Source | NOT in MDX |
|------|--------|------------|
| Ratings (changeability, xriskImpact) | `parameter-graph.yaml` | Never duplicate |
| Descriptions | `entities/ai-transition-model.yaml` | Reference only |
| Scope (includes/excludes) | YAML | Reference only |
| Key debates | YAML | Reference only |
| Related content | YAML | Reference only |

**MDX files should be minimal:**

```yaml
---
title: "Factor Name"
sidebar:
  order: 1
---
import {TransitionModelContent} from '@components/wiki';

## Overview

[Custom prose content - the ONLY substantial content in MDX]

---

<TransitionModelContent slug="factor-slug" />
```

## Entity Types

### Factors (ai-transition-model-factor)

Top-level drivers of AI trajectories:
- AI Capabilities
- AI Safety
- Human Control
- Societal Response
- Transition Turbulence

### Sub-items (ai-transition-model-subitem)

Components within factors:
- Compute, Algorithms, Adoption (under Capabilities)
- Alignment Robustness, Safety Culture (under Safety)

### Parameters (ai-transition-model-parameter)

Measurable variables:
- Racing Intensity
- Interpretability Coverage
- Safety-Capability Gap

### Scenarios (ai-transition-model-scenario)

Possible outcomes:
- Gradual AI Takeover
- Rapid AI Takeover
- Lock-in scenarios

### Metrics (ai-transition-model-metric)

Quantitative indicators tracked over time.

---

## Required YAML Fields

For all ATM entities in `src/data/entities/ai-transition-model.yaml`:

```yaml
- id: tmc-factor-name
  name: "Factor Name"
  type: ai-transition-model-factor
  description: "Brief description"
  parentFactor: tmc-parent  # if sub-item
  ratings:
    changeability: 60  # How modifiable (0-100)
    xriskImpact: 75    # Impact on x-risk (0-100)
    uncertainty: 50    # How uncertain (0-100)
  scope:
    includes:
      - "What this factor covers"
    excludes:
      - "What it doesn't cover"
  keyDebates:
    - question: "Is X true?"
      positions:
        - view: "Yes because..."
          proponents: ["Lab A"]
        - view: "No because..."
          proponents: ["Researcher B"]
```

---

## Cause-Effect Diagrams

ATM pages should have cause-effect diagrams showing relationships:

```yaml
causeEffectGraph:
  title: "What Drives This Factor?"
  primaryNodeId: factor-id
  nodes:
    - id: upstream-1
      label: "Upstream Driver"
      type: leaf
    - id: factor-id
      label: "This Factor"
      type: effect
  edges:
    - source: upstream-1
      target: factor-id
      strength: strong
```

See the [Cause-Effect Diagrams](/wiki/E758) page for detailed guidance.

---

## Claude Code Workflows

### Creating a New ATM Entity

```bash
# 1. Add to YAML first
# Edit src/data/entities/ai-transition-model.yaml

# 2. Rebuild data
npm run build:data

# 3. Create minimal MDX if needed
# Most content comes from YAML via TransitionModelContent component
```

### Adding a Cause-Effect Diagram

```
Task({
  subagent_type: 'general-purpose',
  prompt: `Add a cause-effect diagram to ATM entity [ENTITY_ID].

  1. Read /wiki/E758 (Cause-Effect Diagrams) for schema
  2. Read /wiki/E721 (AI Transition Model Style Guide)
  3. Identify upstream drivers and downstream effects
  4. Add causeEffectGraph to the entity in ai-transition-model.yaml

  Structure:
  - Upstream drivers as leaf nodes
  - Sub-components as intermediate nodes (with entityRef)
  - Critical questions as leaf nodes with effect: mixed
  - The factor itself as effect node`
})
```

### Updating Ratings

```bash
# Ratings live in YAML, not MDX
# Edit src/data/entities/ai-transition-model.yaml
# Then rebuild:
npm run build:data
```

---

## Quality Criteria

ATM pages are evaluated differently:

| Aspect | Criteria |
|--------|----------|
| Completeness | All YAML fields populated |
| Diagram | Has cause-effect graph with 5+ nodes |
| Debates | Key debates documented with positions |
| Links | Related entities connected |
| Ratings | All ratings have justification |

---

## Anti-Patterns

1. **Duplicating YAML in MDX** - Let TransitionModelContent render it
2. **Ratings without justification** - Every rating needs explanation
3. **Orphan entities** - Every entity should have relationships
4. **Missing scope** - Always define what's included/excluded
5. **No cause-effect diagram** - Every factor should have one

---

## Validation

```bash
# Validate ATM entities
npm run crux -- validate data

# Validate all diagrams and cause-effect graphs
npm run validate
```
