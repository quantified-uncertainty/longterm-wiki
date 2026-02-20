---
numericId: E726
title: "Common Writing Principles"
description: "Cross-cutting writing standards that apply to all content types. Covers epistemic honesty, language neutrality, and analytical tone."
entityType: internal
sidebar:
  order: 9
readerImportance: 73.5
researchImportance: 71
quality: 0
llmSummary: "Shared writing principles referenced by all domain-specific style guides. Three pillars: epistemic honesty (hedge uncertain claims, use ranges, source confidence levels), language neutrality (avoid insider jargon, describe things by what they are), and analytical tone (present tradeoffs rather than prescribe). Includes concrete word substitution tables and anti-patterns."
ratings:
  novelty: 3
  rigor: 5
  actionability: 7
  completeness: 6
lastEdited: "2026-02-17"
evergreen: true
update_frequency: 90
---
import {EntityLink} from '@components/wiki';

# Common Writing Principles

These principles apply to **all content types** across the wiki. Domain-specific style guides (risk, response, models, ATM) build on these foundations. When scoring pages, the **objectivity** rating dimension measures adherence to these principles.

---

## 1. Epistemic Honesty

The wiki makes many quantitative claims that are uncertain. Present them honestly.

### Ranges Over Point Estimates

Always use ranges for uncertain quantities. A single number implies false precision.

| Bad | Good | Why |
|-----|------|-----|
| The cost is \$500K | Est. cost: \$300K-1M | Acknowledges real uncertainty |
| P(success) = 30% | P(success): 15-40% | Point estimates imply calibration we don't have |
| Impact: \$50M | Est. impact: \$20-100M (very rough) | Wide ranges are more honest |

### Label Uncertainty Explicitly

Use hedging language proportional to actual uncertainty:

- **High confidence** (sourced data): "According to IPS, 36% of deceased pledgers met the 50% threshold"
- **Moderate confidence** (reasonable inference): "This suggests roughly \$25-70B in capital is at stake"
- **Low confidence** (rough estimate): "A portfolio might cost on the order of \$2-8M"
- **Speculation**: "It's plausible that backfire risk could make this net negative"

### Words and Phrases

| Avoid | Prefer | Why |
|-------|--------|-----|
| True cost / Realistic EV | Est. cost / Est. EV | Don't claim access to ground truth |
| This will... | This could... / This might... | Uncertain outcomes need uncertain language |
| The impact is X | The estimated impact is roughly X | Distinguish estimates from facts |
| Clearly / Obviously | Arguably / Plausibly | Let readers judge for themselves |
| It's well-known that | [Cite the source] | "Well-known" is an appeal to authority |

### Structural Patterns

- **Pair optimistic calculations with critical analysis.** If you show a naive calculation (e.g., "even a 1pp shift is worth \$250M"), immediately explain why the naive math is probably wrong (selection bias, hidden costs, backfire risk, etc.).
- **Include "Key Uncertainties" sections** on analysis pages. Name the 3-5 things you're most unsure about and explain how they'd change conclusions.
- **Show deflators explicitly.** When presenting cost-effectiveness estimates, show both the naive calculation and the deflated version with a table explaining each adjustment.
- **No false precision.** Use "≈\$1M" not "\$1,234,567" when the number is a rough estimate. Round to the level of actual knowledge.

---

## 2. Language Neutrality

The wiki should be readable by someone with no prior exposure to the effective altruism community. Avoid insider language that creates in-group/out-group framing.

### The Core Rule

**Describe things by what they are, not which community they belong to.**

| Avoid | Prefer | Why |
|-------|--------|-----|
| EA money / EA capital | Philanthropic capital directed to high-impact causes | Descriptive, not tribal |
| EA organizations | Name the actual orgs (GiveWell, Open Phil, Longview) | More precise and accessible |
| EA community | Effective altruism community (first use); effective giving community | Spell it out; don't assume familiarity |
| non-EA charities | Mainstream charities; or describe them specifically | Don't define things by negation |
| EA-aligned | Focused on high-impact causes; or describe the specific alignment | "Aligned" implies loyalty, not quality |
| EA causes | High-impact causes; or name the cause areas (global health, AI safety, biosecurity) | The causes stand on their own merits |

### When "EA" Is Fine

- **As a proper noun** referring to the movement: "effective altruism" (spelled out on first use)
- **In entity names**: "EA Forum", "Centre for Effective Altruism"
- **In direct quotes**
- **On pages specifically about the EA movement** (e.g., the field-building section)

### Avoid Defining by Negation

"Non-EA founders" tells the reader nothing about who these people are. "Founders without documented connections to the effective giving community" is longer but actually informative. Or just say "the other 5 founders" if context makes it clear.

---

## 3. Analytical Over Prescriptive

The wiki analyzes; it doesn't advocate. Present tradeoffs and let the reader decide.

### Voice

| Avoid | Prefer | Why |
|-------|--------|-----|
| We recommend... | This analysis suggests... | Wiki doesn't make recommendations |
| The best approach is... | The approach with the highest estimated EV is... | Let readers weigh their own values |
| Organizations should... | Organizations considering this would need to... | Describe, don't prescribe |
| This is clearly the right move | This appears promising, though [caveats] | Acknowledge uncertainty and tradeoffs |

### Consider the Subject's Perspective

When writing about interventions that target real people or organizations:

- **Ask: how would the subject feel reading this?** If a page about "pressuring founders to donate" would read as hostile surveillance, reframe it.
- **Distinguish collaborative from adversarial interventions.** Tax planning help is collaborative; public shaming is adversarial. Name this distinction explicitly.
- **Acknowledge legitimate reasons for disagreement.** If someone chose a non-binding pledge deliberately, don't assume it was an oversight.

### Red-Team Your Own Conclusions

Analysis pages should include honest counter-arguments:
- What if the intervention backfires?
- What if selection bias makes the expected value near zero?
- What legitimate reasons might someone have for disagreeing?
- Are you writing from the conclusion backwards, or following the evidence?

---

## Anti-Patterns

### The "False Certainty" Trap
**Symptom**: Table headers say "True Cost" and "Realistic EV". Estimates presented as single numbers without ranges. No acknowledgment of uncertainty.

**Fix**: Add "Est." prefixes, use ranges, include a "Why These Numbers Might Be Wrong" section.

### The "Insider Language" Trap
**Symptom**: Page uses "EA" as an adjective throughout. Assumes reader knows what GiveWell, GWWC, and LTFF are. Defines outsiders as "non-EA."

**Fix**: Spell out abbreviations, name specific organizations, describe things by their properties not their community affiliation.

### The "Prescriptive Analysis" Trap
**Symptom**: Page framed as analysis but actually advocates for a specific position. Uses "we should" and "the right approach."

**Fix**: Reframe as "this analysis suggests" and present counterarguments with equal rigor.

### The "Self-Importance" Trap
**Symptom**: Page describes itself as the "canonical source," "definitive guide," "most comprehensive analysis," "investment-grade," or "rigorous" analysis. Uses superlatives about its own coverage ("most thoroughly documented," "first analysis to..."). Frontmatter descriptions or note blocks claim the page is uniquely authoritative.

**Why it matters**: Readers interpret these claims as the wiki asserting global authority—as if no better source exists anywhere. Even if intended to describe scope within the wiki, it reads as self-promotional marketing copy. It undermines the epistemic humility the wiki aims for.

**Fix**: Describe what the page covers, not how good it is. Let quality speak for itself.

| Avoid | Prefer | Why |
|-------|--------|-----|
| This is the canonical source for X | This page covers X | Readers judge canonicity, not authors |
| Rigorous analysis of X | Analysis of X | "Rigorous" is self-congratulatory |
| Investment-grade analysis | Valuation analysis | Financial marketing jargon |
| The most comprehensive analysis of X | An analysis of X covering... | Don't claim superlatives about yourself |
| This is the most thoroughly documented... | This is a well-documented... | Comparative claims about your own work |
| The definitive guide to X | An overview of X | Let readers decide if it's definitive |
| Encyclopedic resource | Structured resource | "Encyclopedic" implies completeness |

**Note**: Superlatives about *external* sources are fine when attributed ("FLI calls their index 'the most comprehensive'"). The issue is claiming superlatives about the wiki's own content.

### The "One-Sided Framing" Trap
**Symptom**: Lists benefits of an intervention without honest concerns. Doesn't red-team its own conclusions. Treats the intervention as obviously good.

**Fix**: Add "Honest concern" notes to each intervention. Include a section on why the whole premise might be wrong.

---

## Relationship to Scoring

These principles are measured by the **objectivity** rating dimension (0-10):

- **1-2**: Heavy insider jargon, false certainty, prescriptive advocacy throughout
- **3-4**: Some insider language; estimates without uncertainty ranges; one-sided framing
- **5-6**: Mostly neutral language; some uncertainty acknowledgment; mostly analytical
- **7+**: Fully accessible to outsiders; all estimates properly hedged with ranges and caveats; analytical throughout; honest counter-arguments included

See the <EntityLink id="rating-system">Rating System</EntityLink> for how objectivity fits into derived quality scores.
