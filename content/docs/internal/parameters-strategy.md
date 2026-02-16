---
title: "Parameters Strategy"
description: "Strategy for AI transition model parameters"
pageType: "documentation"
importance: 38
researchImportance: 68.5
quality: 3
llmSummary: "Internal project management document providing implementation instructions for creating parameter pages in a knowledge base. Outlines workflow, templates, and batch assignments for parallel development work."
ratings:
  novelty: 0
  rigor: 0
  actionability: 0
  completeness: 0
---
# Key Parameters Implementation Strategy

This document outlines the strategy for creating new parameter pages in the knowledge base. It is designed to be given to multiple Claude Code instances working in parallel.

## Overview

**Goal**: Create parameter pages that frame important variables as continuous measures that can increase or decrease, rather than just as "risks" (negative outcomes).

**Benefits of Parameter Framing**:
- Symmetric analysis: Track both threats (decreasers) and supports (increasers)
- Causal clarity: Separate the variable from the directions it can move
- Action-oriented: Focus on maintaining/improving parameters
- Measurable: Continuous rather than binary

## Completed Work

The following infrastructure is already in place:

- [x] `parameter` entity type added to schema.ts
- [x] Gauge icon and fuchsia color in EntityTypeIcon.tsx
- [x] Parameter label in InfoBox.tsx
- [x] Sidebar entry in astro.config.mjs
- [x] 4 initial parameters created:
  - Societal Trust
  - Epistemic Capacity
  - Power Distribution
  - Human Agency

---

## Workflow for Creating a Parameter

### Step 1: Identify Source Material

Check if a related risk page exists that can be transformed:
```
src/content/docs/knowledge-base/risks/
```

Or create from scratch using the template below.

### Step 2: Create Entity Definition

Add to `src/data/entities.yaml`:

```yaml
- id: parameter-id-here
  type: parameter
  title: "Parameter Title"
  description: "Brief description of what this parameter measures and why it matters"
  customFields:
    - label: Direction
      value: "Higher is better" # or "Lower is better" or "Optimal range exists"
    - label: Current Trend
      value: "Declining/Improving/Stable/Mixed"
    - label: Key Measurement
      value: "How this is measured"
  tags:
    - relevant-tag-1
    - relevant-tag-2
```

### Step 3: Create MDX Page

Create file at `src/content/docs/knowledge-base/parameters/{parameter-id}.mdx`:

```mdx
---
title: "Parameter Title"
description: "One sentence describing the parameter. Currently [trend]: [key statistic]."
sidebar:
  order: [next number]
quality: 4
llmSummary: "2-3 sentence summary for AI context. Include key statistics and the main factors that increase/decrease this parameter."
lastEdited: "2025-12-28"
---
import {DataInfoBox, Mermaid, R} from '@components/wiki';

<DataInfoBox entityId="parameter-id-here" />

## Overview

[2-3 paragraphs explaining what this parameter measures and why it matters]

As a **key parameter**, [parameter name] can increase or decrease based on various factors—including AI development and deployment.

This parameter underpins:
- **Domain 1**: Why this matters here
- **Domain 2**: Why this matters here
- **Domain 3**: Why this matters here

---

## Current State Assessment

### Key Metrics

| Metric | Current Value | Historical Baseline | Trend |
|--------|--------------|---------------------|-------|
| Metric 1 | Value | Baseline | Direction |
| Metric 2 | Value | Baseline | Direction |

*Sources: <R id="resource-id">Source name</R>*

---

## What "Healthy [Parameter]" Looks Like

[Describe the optimal state - what would good look like?]

### Key Characteristics of Healthy [Parameter]

1. **Characteristic 1**: Description
2. **Characteristic 2**: Description
3. **Characteristic 3**: Description

---

## Factors That Decrease [Parameter] (Threats)

<Mermaid chart={`
flowchart TD
    AI[AI Systems] --> THREAT1[Threat 1]
    AI --> THREAT2[Threat 2]
    THREAT1 --> OUTCOME[Parameter Decreases]
    THREAT2 --> OUTCOME
    style AI fill:#e1f5fe
    style OUTCOME fill:#ffcdd2
`} />

### Threat Category 1

| Threat | Mechanism | Evidence |
|--------|-----------|----------|
| Specific threat | How it works | Data/citation |

### Threat Category 2

[Similar structure]

---

## Factors That Increase [Parameter] (Supports)

### Technical Approaches

| Approach | Mechanism | Status |
|----------|-----------|--------|
| Approach 1 | How it helps | Current adoption |

### Policy Interventions

| Intervention | Mechanism | Status |
|--------------|-----------|--------|
| Policy 1 | How it helps | Implementation status |

### Institutional Approaches

[Similar structure]

---

## Why This Parameter Matters

### Consequences of Low [Parameter]

| Domain | Impact | Severity |
|--------|--------|----------|
| Domain 1 | What happens | Critical/High/Medium |

### [Parameter] and Existential Risk

[How does this parameter connect to x-risk?]

---

## Trajectory and Scenarios

### Projected Trajectory

| Timeframe | Key Developments | Parameter Impact |
|-----------|-----------------|------------------|
| 2025-2026 | Development | Impact |
| 2027-2030 | Development | Impact |

### Scenario Analysis

| Scenario | Probability | Outcome |
|----------|-------------|---------|
| Optimistic | 20-30% | Description |
| Baseline | 40-50% | Description |
| Pessimistic | 20-30% | Description |

---

## Key Debates

### Debate 1

**View A:**
- Point 1
- Point 2

**View B:**
- Point 1
- Point 2

## Sources & Key Research

### Category 1
- <R id="resource-id">Source name</R>

```

### Step 4: Validate

```bash
npm run build:data
npm run validate
npm run dev  # Check the page renders
```

---

## Implementation Batches

Each batch should be worked on by a separate Claude Code instance. Complete one batch before starting dependencies.

### Batch 1: Technical Safety Parameters

**Priority**: High (foundational for understanding AI risk)

**Dependencies**: None

| Parameter | Source Material | Direction | Key Metric |
|-----------|----------------|-----------|------------|
| Alignment Robustness | `risks/accident/` pages | Higher is better | Behavioral reliability under distribution shift |
| Safety-Capability Gap | New (from capabilities vs safety debate) | Lower is better | Months/years capabilities lead safety |
| Interpretability Coverage | `interpretability-sufficient.mdx` debate | Higher is better | % of model behavior explainable |

**Todo List**:
- [ ] Create `alignment-robustness` entity in entities.yaml
- [ ] Create `alignment-robustness.mdx` page
- [ ] Create `safety-capability-gap` entity in entities.yaml
- [ ] Create `safety-capability-gap.mdx` page
- [ ] Create `interpretability-coverage` entity in entities.yaml
- [ ] Create `interpretability-coverage.mdx` page
- [ ] Run `npm run build:data && npm run validate`
- [ ] Test pages render correctly

---

### Batch 2: Governance Parameters

**Priority**: High (policy-relevant)

**Dependencies**: None

| Parameter | Source Material | Direction | Key Metric |
|-----------|----------------|-----------|------------|
| International Coordination | `governance/international/` pages | Higher is better | Treaty participation, shared standards |
| Regulatory Capacity | `governance/legislation/` pages | Higher is better | Technical expertise in agencies |
| Institutional Quality | `risks/structural/institutional-capture.mdx` | Higher is better | Independence, expertise retention |

**Todo List**:
- [ ] Create `international-coordination` entity in entities.yaml
- [ ] Create `international-coordination.mdx` page (draw from international-summits, international.mdx)
- [ ] Create `regulatory-capacity` entity in entities.yaml
- [ ] Create `regulatory-capacity.mdx` page
- [ ] Create `institutional-quality` entity in entities.yaml
- [ ] Create `institutional-quality.mdx` page (transform institutional-capture)
- [ ] Run `npm run build:data && npm run validate`

---

### Batch 3: Economic & Human Capital Parameters

**Priority**: High (affects broad population)

**Dependencies**: None

| Parameter | Source Material | Direction | Key Metric |
|-----------|----------------|-----------|------------|
| Economic Stability | `risks/structural/economic-disruption.mdx` | Higher is better | Employment rates, inequality measures |
| Human Expertise Level | `risks/epistemic/learned-helplessness.mdx` | Higher is better | Skill retention, cognitive engagement |
| Human Oversight Quality | `responses/governance/` pages | Higher is better | Effective human review of AI decisions |

**Todo List**:
- [ ] Create `economic-stability` entity in entities.yaml
- [ ] Create `economic-stability.mdx` page (transform economic-disruption)
- [ ] Create `human-expertise-level` entity in entities.yaml
- [ ] Create `human-expertise-level.mdx` page
- [ ] Create `human-oversight-quality` entity in entities.yaml
- [ ] Create `human-oversight-quality.mdx` page
- [ ] Run `npm run build:data && npm run validate`

---

### Batch 4: Information Environment Parameters

**Priority**: Medium-High (relates to epistemic-capacity already created)

**Dependencies**: Batch 1 complete (for cross-linking)

| Parameter | Source Material | Direction | Key Metric |
|-----------|----------------|-----------|------------|
| Information Authenticity | `content-authentication.mdx` | Higher is better | % verifiable content |
| Reality Coherence | `risks/epistemic/reality-fragmentation.mdx` | Higher is better | Shared factual baseline across groups |
| Preference Authenticity | `risks/epistemic/preference-manipulation.mdx` | Higher is better | Degree preferences reflect genuine values |

**Todo List**:
- [ ] Create `information-authenticity` entity in entities.yaml
- [ ] Create `information-authenticity.mdx` page
- [ ] Create `reality-coherence` entity in entities.yaml
- [ ] Create `reality-coherence.mdx` page (transform reality-fragmentation)
- [ ] Create `preference-authenticity` entity in entities.yaml
- [ ] Create `preference-authenticity.mdx` page (transform preference-manipulation)
- [ ] Run `npm run build:data && npm run validate`

---

### Batch 5: Development Dynamics Parameters

**Priority**: Medium (strategic for AI governance)

**Dependencies**: None

| Parameter | Source Material | Direction | Key Metric |
|-----------|----------------|-----------|------------|
| Racing Intensity | `risks/structural/racing-dynamics.mdx` | Lower is better | Safety corners cut, timeline pressure |
| Safety Culture Strength | `responses/organizational-practices/` | Higher is better | Safety prioritization in labs |
| Coordination Level | Various governance pages | Higher is better | Industry cooperation on safety |

**Todo List**:
- [ ] Create `racing-intensity` entity in entities.yaml
- [ ] Create `racing-intensity.mdx` page (transform racing-dynamics, invert framing)
- [ ] Create `safety-culture-strength` entity in entities.yaml
- [ ] Create `safety-culture-strength.mdx` page
- [ ] Create `coordination-level` entity in entities.yaml
- [ ] Create `coordination-level.mdx` page
- [ ] Run `npm run build:data && npm run validate`

---

### Batch 6: Security & Resilience Parameters

**Priority**: Medium (important but more specialized)

**Dependencies**: None

| Parameter | Source Material | Direction | Key Metric |
|-----------|----------------|-----------|------------|
| Biosecurity Level | `risks/misuse/bioweapons.mdx` | Higher is better | Detection capability, response time |
| Cyber Defense Capacity | `risks/misuse/cyberweapons.mdx` | Higher is better | Defense vs offense balance |
| System Resilience | New | Higher is better | Ability to recover from AI failures |

**Todo List**:
- [ ] Create `biosecurity-level` entity in entities.yaml
- [ ] Create `biosecurity-level.mdx` page
- [ ] Create `cyber-defense-capacity` entity in entities.yaml
- [ ] Create `cyber-defense-capacity.mdx` page
- [ ] Create `system-resilience` entity in entities.yaml
- [ ] Create `system-resilience.mdx` page
- [ ] Run `npm run build:data && npm run validate`

---

### Batch 7: Structural & Long-term Parameters

**Priority**: Medium (important for long-term scenarios)

**Dependencies**: Batches 1-3 complete (for cross-linking)

| Parameter | Source Material | Direction | Key Metric |
|-----------|----------------|-----------|------------|
| Reversibility Options | `risks/structural/lock-in.mdx` | Higher is better | Ability to course-correct |
| Value Lock-in Risk | `risks/structural/lock-in.mdx` | Lower is better | Probability of permanent value capture |
| Privacy Level | New (from surveillance concerns) | Context-dependent | Data protection, surveillance limits |
| Democratic Participation | New | Higher is better | Public input into AI governance |

**Todo List**:
- [ ] Create `reversibility-options` entity in entities.yaml
- [ ] Create `reversibility-options.mdx` page
- [ ] Create `value-lock-in-risk` entity in entities.yaml
- [ ] Create `value-lock-in-risk.mdx` page (can share content with reversibility)
- [ ] Create `privacy-level` entity in entities.yaml
- [ ] Create `privacy-level.mdx` page
- [ ] Create `democratic-participation` entity in entities.yaml
- [ ] Create `democratic-participation.mdx` page
- [ ] Run `npm run build:data && npm run validate`

---

## CLI Commands for Each Instance

### Starting a Batch

```bash
# Navigate to project
cd /path/to/longtermwiki

# Ensure clean state
git pull
npm install
npm run build:data

# Start Claude Code
claude

# Give it this instruction:
"Work on Batch [N] from PARAMETERS_STRATEGY.md. Create the entity definitions and MDX pages for the parameters listed. Follow the template exactly. Run validation after each parameter."
```

### Validation Commands

```bash
# After each parameter
npm run build:data
npm run validate

# Check specific validators
npm run crux -- validate templates
npm run crux -- validate refs
npm run crux -- validate compile

# Test dev server
npm run dev
```

### Commit Strategy

After completing a batch:
```bash
git add src/data/entities.yaml
git add src/content/docs/knowledge-base/parameters/
git commit -m "Add [Batch N] parameters: [parameter1], [parameter2], [parameter3]"
```

---

## Quality Checklist for Each Parameter Page

Before marking a parameter complete, verify:

- [ ] Entity definition added to entities.yaml with correct type, tags, customFields
- [ ] MDX page has all required sections (Overview, Current State, Healthy State, Threats, Supports, Why It Matters, Trajectory, Related Pages)
- [ ] DataInfoBox component with correct entityId
- [ ] Backlinks component at bottom
- [ ] At least one Mermaid diagram
- [ ] At least 2 data tables
- [ ] Quality rating of 4 or higher
- [ ] llmSummary in frontmatter
- [ ] lastEdited date is current
- [ ] All `$` signs escaped as `\$` in content
- [ ] `npm run validate` passes
- [ ] Page renders correctly in dev server

---

## Transformation Rules for Risk → Parameter

When converting a risk page to a parameter:

### Frontmatter Changes

```yaml
# Risk version
title: "Trust Erosion"
description: "How AI systems may undermine..."

# Parameter version
title: "Societal Trust"
description: "Level of public confidence... Currently declining: [stat]."
```

### Section Restructure

| Risk Section | Parameter Section |
|--------------|-------------------|
| Overview (describes the risk) | Overview (describes the parameter) |
| Risk Assessment | Current State Assessment |
| How This Risk Manifests | Factors That Decrease (Threats) |
| (none) | What "Healthy [X]" Looks Like |
| (none) | Factors That Increase (Supports) |
| Responses That Address This | Related Interventions |

### Language Changes

| Risk Language | Parameter Language |
|---------------|-------------------|
| "Risk of X" | "Parameter X can vary between..." |
| "How AI threatens X" | "How AI affects X (both directions)" |
| "Preventing X" | "Maintaining/improving X" |
| "X erosion/collapse/failure" | "X level/capacity/strength" |

---

## Coordination Notes

- **Batch Order**: Batches 1-3 and 5-6 can run in parallel. Batch 4 and 7 have dependencies.
- **Conflicts**: Only entities.yaml might have merge conflicts. Communicate before committing.
- **Review**: Each batch should be reviewed before the dependent batches start.
- **Quality**: Aim for quality 4 minimum. Can be improved to 5 later with more research.
