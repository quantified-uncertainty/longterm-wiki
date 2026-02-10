---
title: Schema Documentation
description: "Complete reference for the data schema powering Longterm Wiki — entity types, relationships, data flow, and validation"
sidebar:
  label: Schema Overview
  order: 0
---

import {Mermaid} from '@components/wiki';

This wiki is backed by a typed data layer defined in `data/schema.ts` using [Zod](https://zod.dev). All YAML data files are validated against these schemas at build time. This section documents the full schema, how data flows through the system, and how entity types relate to each other.

## Architecture at a Glance

<Mermaid chart={`
flowchart LR
    subgraph DataLayer["📁 Data Layer (YAML)"]
        direction TB
        Entities["entities/*.yaml<br/><i>~25 files</i>"]
        Resources["resources/*.yaml"]
        Facts["facts/*.yaml"]
        Graphs["graphs/*.yaml"]
        Experts["experts.yaml"]
        Orgs["organizations.yaml"]
        Pubs["publications.yaml"]
        Other["estimates, cruxes,<br/>glossary, timeline"]
    end

    subgraph Schema["📐 Schema (Zod)"]
        direction TB
        ZodTypes["data/schema.ts<br/><i>834 lines, 20+ types</i>"]
        Validators["tooling/validate/<br/><i>integrity checks</i>"]
    end

    subgraph Build["🔧 Build Pipeline"]
        direction TB
        BuildScript["build-data.mjs"]
        DB["database.json"]
        IDReg["id-registry.json"]
        SearchIdx["search index"]
    end

    subgraph Frontend["🖥️ Next.js App"]
        direction TB
        DataAPI["data/index.ts<br/><i>getTypedEntityById()</i>"]
        Pages["wiki/[id]/page.tsx"]
        Components["InfoBox, Graph,<br/>EntityLink, etc."]
    end

    DataLayer --> Schema
    Schema --> Build
    Build --> Frontend
`} />

## Core Concepts

### Dual ID System

Every entity has two identifiers:

| ID Type | Example | Purpose |
|---------|---------|---------|
| **Slug** | `deceptive-alignment` | Human-readable, used in YAML |
| **Numeric** | `E42` | Stable canonical URL (`/wiki/E42/`), never changes |

The mapping lives in `data/id-registry.json` and is maintained automatically by the build script.

### Entity Types (24 canonical + aliases)

Entities are the primary data objects. Each has a `type` field from a controlled vocabulary of **24 canonical types**, plus legacy aliases for backward compatibility. See [Entity Type Reference](/internal/schema/entities) for full details.

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

- **[Entity Type Reference](/internal/schema/entities)** — Every entity type with its fields, enums, and usage
- **[Diagrams](/internal/schema/diagrams)** — Visual ER diagrams, class diagrams, and relationship maps
- **[Fact Dashboard](/internal/facts)** — Browse canonical facts by entity

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

See [Entity Type Reference](/internal/schema/entities) for type-specific fields like `severity`, `likelihood`, `orgType`, `positions`, etc.
