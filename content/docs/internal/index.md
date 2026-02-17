---
numericId: E779
title: Internal
description: Project documentation, style guides, and roadmap
entityType: internal
sidebar:
  order: 0
  label: Overview
---

This section contains internal documentation for maintaining and contributing to the knowledge base.

## Getting Started

- [About This Wiki](/wiki/E755) - Comprehensive overview of how the wiki works, technical architecture, and content organization

## Automation and Tools

- [Automation Tools](/wiki/E757) - Complete reference for all scripts and CLI workflows
- [Content Database](/wiki/E759) - SQLite-based system for indexing and AI summaries

## Style Guides

- [Knowledge Base Style Guide](/wiki/E763) - Guidelines for risk and response pages (kb-2.0)
- [Model Style Guide](/wiki/E737) - Guidelines for analytical model pages
- [Mermaid Diagrams](/wiki/E735) - How to create diagrams

## Project Management

- [Enhancement Queue](/wiki/E761) - Track content enhancement progress across all page types
- [Project Roadmap](/wiki/E810) - Future work, infrastructure improvements, and tracking

## Technical Reports

- [Internal Reports](/wiki/E780) - Technical research and design decisions
  - [Causal Diagram Visualization](/wiki/E743) - Tools, literature, and best practices

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

See [Automation Tools](/wiki/E757) for complete command reference.
