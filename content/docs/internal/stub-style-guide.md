---
numericId: E753
title: "Stub Pages Style Guide"
description: "Guidelines for minimal placeholder pages"
sidebar:
  order: 13
entityType: internal
quality: 19
readerImportance: 14
researchImportance: 9.5
lastEdited: "2026-02-17"
update_frequency: 90
evergreen: true
llmSummary: "Internal documentation providing guidelines for creating minimal placeholder pages (stubs) in the knowledge base, including when to use them, required formatting, and when to convert them to full pages. Covers basic content structure and validation procedures."
ratings:
  novelty: 0.5
  rigor: 2
  actionability: 3
  completeness: 4
---
# Stub Pages Style Guide

Stub pages are intentionally minimal placeholders. They mark topics that exist in the conceptual space but don't warrant full pages.

## When to Use Stubs

Use `pageType: stub` for:
- **Placeholders** - Topics to be expanded later
- **Brief profiles** - People, orgs that don't need full pages
- **Redirect pointers** - Topics covered elsewhere
- **Deprecated concepts** - Historical items kept for links

## Required Frontmatter

```yaml
---
title: "Topic Name"
description: "Brief explanation of what this is."
pageType: stub
seeAlso: "primary-page-slug"  # Optional: points to main coverage
---
```

## Minimal Content

Stubs should have:
1. One paragraph explaining what this is
2. Why it's a stub (placeholder, covered elsewhere, etc.)
3. Link to primary coverage if applicable

**Example:**
```markdown
---
title: "Narrow AI Safety"
pageType: stub
seeAlso: "ai-safety"
---

# Narrow AI Safety

Safety considerations for narrow (non-general) AI systems. This topic is intentionally minimal as the primary focus of LongtermWiki is transformative AI.

For comprehensive coverage, see [AI Safety](/knowledge-base/ai-safety/).
```

## When NOT to Use Stubs

Don't use stubs as an excuse for incomplete work. If a topic deserves coverage, write a real page. Stubs are for topics that **should** be minimal.

## Quality Rating

Stubs are **excluded from quality scoring**. They don't appear in quality reports or improvement queues.

## Converting Stubs to Full Pages

When ready to expand:

```
Task({
  subagent_type: 'general-purpose',
  prompt: `Convert stub at [PATH] to a full page.

  1. Determine appropriate page type (risk, response, model)
  2. Read the relevant style guide
  3. Research the topic
  4. Replace stub content with full structure
  5. Remove pageType: stub from frontmatter
  6. Add quality and importance ratings`
})
```

## Validation

Stubs are skipped by content validators. To list all stubs:

```bash
grep -r "pageType: stub" src/content/docs/ | wc -l
```
