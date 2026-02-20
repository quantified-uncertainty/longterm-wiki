---
numericId: E779
title: Internal
description: Project documentation, style guides, and roadmap
sidebar:
  order: 0
  label: Overview
entityType: internal
evergreen: true
---
import {EntityLink} from '@components/wiki';


This section contains internal documentation for maintaining and contributing to the knowledge base.

## Getting Started

- <EntityLink id="about-this-wiki">About This Wiki</EntityLink> - Comprehensive overview of how the wiki works, technical architecture, and content organization

## Automation and Tools

- <EntityLink id="automation-tools">Automation Tools</EntityLink> - Complete reference for all scripts and CLI workflows
- <EntityLink id="content-database">Content Database</EntityLink> - SQLite-based system for indexing and AI summaries

## Style Guides

- <EntityLink id="knowledge-base">Knowledge Base Style Guide</EntityLink> - Guidelines for risk and response pages (kb-2.0)
- <EntityLink id="models">Model Style Guide</EntityLink> - Guidelines for analytical model pages
- <EntityLink id="mermaid-diagrams">Mermaid Diagrams</EntityLink> - How to create diagrams

## Project Management

- <EntityLink id="enhancement-queue">Enhancement Queue</EntityLink> - Track content enhancement progress across all page types
- <EntityLink id="project-roadmap">Project Roadmap</EntityLink> - Future work, infrastructure improvements, and tracking

## Technical Reports

- [Internal Reports](/internal/reports/) - Technical research and design decisions
  - <EntityLink id="causal-diagram-visualization">Causal Diagram Visualization</EntityLink> - Tools, literature, and best practices

---

## Quick Commands

Most common operations:

```bash
# Run all validators
npm run validate

# List pages needing improvement
node scripts/page-improver.mjs --list

# Rebuild data after editing entities.yaml
npm run build:data

# Start dev server
npm run dev
```

See <EntityLink id="automation-tools">Automation Tools</EntityLink> for complete command reference.
