---
title: Schema Documentation
description: Data schema documentation - entity types, relationships, validation, and visual diagrams
sidebar:
  label: Overview
  order: 0
---

Documentation for the data schema that powers this site. All entity and resource data is validated against Zod schemas at build time.

## Contents

- **[Diagrams](/internal/schema/diagrams/)** - Visual documentation of entity types, relationships, and data flow
- **Validation** - Run `npm run crux -- validate data` to check YAML files against the schema

## Quick Links

| Resource | Description |
|----------|-------------|
| `src/data/schema.ts` | Zod schema definitions (source of truth) |
| `src/data/entities/*.yaml` | Entity data files |
| `src/data/resources/*.yaml` | Resource/citation data |
| `scripts/validate/validate-yaml-schema.mjs` | Schema validator script |
| `scripts/generate-schema-diagrams.mjs` | Diagram generator |

## Regenerating Diagrams

```bash
# Generate all diagrams
npm run diagrams

# Schema-derived only (from Zod)
npm run diagrams:schema

# Data-derived only (from YAML)
npm run diagrams:data
```

Raw `.mmd` files are saved to `internal/` (gitignored) for use in external tools.
