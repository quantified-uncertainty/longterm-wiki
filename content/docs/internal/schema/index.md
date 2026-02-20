---
numericId: E781
title: Schema Documentation
description: "Complete reference for the data schema powering Longterm Wiki — entity types, relationships, data flow, and validation"
sidebar:
  label: Schema Overview
  order: 0
entityType: internal
evergreen: true
---

import {Mermaid, EntityLink} from '@components/wiki';

This wiki is backed by a typed data layer defined in `data/schema.ts` using [Zod](https://zod.dev). All YAML data files are validated against these schemas at build time. This section documents the full schema, how data flows through the system, and how entity types relate to each other.

## Architecture at a Glance

<Mermaid chart={`
flowchart TD
    subgraph DataLayer["Data Layer"]
        YAML["YAML files"]
        MDX["MDX pages"]
    end

    subgraph Schema["Validation"]
        Zod["Zod schemas"]
        Val["Integrity checks"]
    end

    subgraph Build["Build"]
        Script["build-data.mjs"]
        DB["database.json"]
    end

    subgraph App["Next.js App"]
        API["Data API"]
        Pages["Wiki pages"]
    end

    DataLayer --> Schema
    Schema --> Build
    Build --> App

    style DataLayer fill:#fff4e1
    style Schema fill:#cceeff
    style Build fill:#e1f5ff
    style App fill:#ccffcc
`} />

## Core Concepts

### Dual ID System

Every entity has two identifiers:

| ID Type | Example | Purpose |
|---------|---------|---------|
| **Slug** | `deceptive-alignment` | Human-readable, used in YAML |
| **Numeric** | `E42` | Stable canonical URL (`/wiki/E42/`), never changes |

Each entity stores its `numericId` directly in its source file (YAML `numericId:` field or MDX frontmatter). The build script derives `data/id-registry.json` as a build artifact.

### Entity Types (24 canonical + aliases)

Entities are the primary data objects. Each has a `type` field from a controlled vocabulary of **24 canonical types**, plus legacy aliases for backward compatibility. See <EntityLink id="entities">Entity Type Reference</EntityLink> for full details.

**Core groupings:**

| Group | Types | Purpose |
|-------|-------|---------|
| **Core Content** | risk, risk-factor, capability, concept, crux, argument, case-study | Main knowledge base entries |
| **Safety & Responses** | safety-agenda, approach, project, policy | What's being done about risks |
| **People & Orgs** | person, organization, funder | Who's involved |
| **Analysis** | model, parameter, metric, analysis, scenario | Analytical frameworks |
| **AI Transition Model** | ai-transition-model-\* (5 subtypes) | Structured transition modeling |
| **Other** | resource, historical, event, debate, table, diagram, insight, intelligence-paradigm | Everything else |

### Relationship System

Entities connect through `relatedEntries`, each specifying a **relationship type** (45 types) and optional **strength** (weak/moderate/strong). The build system computes **backlinks** automatically — if A→B exists, the B page shows A as a backlink.

### Content Architecture

Entity content can live in two places:
1. **MDX files** in `content/docs/` — traditional markdown pages
2. **YAML `content` field** — structured `ContentSection` objects with headings, body, mermaid diagrams, tables, and custom components

The build script merges both sources into the final database.

## Schema Sections

- **<EntityLink id="entities">Entity Type Reference</EntityLink>** — Every entity type with its fields, enums, and usage
- **<EntityLink id="diagrams">Diagrams</EntityLink>** — Visual ER diagrams, class diagrams, and relationship maps
- **[Fact Dashboard](/internal/facts/)** — Browse canonical facts by entity

## Validation

The schema is enforced at multiple levels:

```bash
# Run all validation checks
node tooling/crux.mjs validate

# Key validators:
# - Entity ID cross-references (relatedEntries must exist)
# - Expert/Organization references
# - Orphaned entity detection
# - MDX internal link integrity
# - Mermaid diagram syntax
# - Content consistency
```

## Quick Reference: Common Fields

Every entity shares these base fields:

```typescript
{
  id: string;              // Slug identifier
  type: EntityType;        // One of 24+ types
  title: string;           // Display name
  description?: string;    // 1-3 sentence summary
  aliases?: string[];      // Alternative names (for search)
  status?: 'stub' | 'draft' | 'published' | 'verified';
  lastUpdated?: string;    // "YYYY-MM" format
  tags?: string[];         // Standardized tags
  clusters?: ('ai-safety' | 'biorisks' | 'cyber' | 'epistemics' | 'governance' | 'community')[];
  relatedEntries?: RelatedEntry[];
  sources?: { title, url?, author?, date? }[];
  resources?: string[];    // Resource IDs from data/resources/
  content?: EntityContent; // Rich YAML-first content
  customFields?: { label, value }[];
}
```

See <EntityLink id="entities">Entity Type Reference</EntityLink> for type-specific fields like `severity`, `likelihood`, `orgType`, `positions`, etc.
