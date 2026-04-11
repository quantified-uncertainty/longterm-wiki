---
wikiId: E779
title: Internal
description: Project documentation, style guides, and roadmap
sidebar:
  order: 0
  label: Overview
---
import {EntityLink} from '@components/wiki';


This section contains internal documentation for maintaining and contributing to the knowledge base.

## Operations Hubs

Start here. Each hub gives you the dashboards, CLI commands, decision tables, and architecture deep-dives for one part of the wiki.

- <EntityLink id="E2166" name="research-discovery-hub">Research & Discovery</EntityLink> — finding new information (web search, news ingestion, context bundles)
- <EntityLink id="E2167" name="verification-sourcing-hub">Verification & Source-Checking</EntityLink> — keeping facts correct (citations, sourcing, hallucination risk)
- <EntityLink id="E2168" name="factbase-entities-hub">FactBase & Entities</EntityLink> — structured data layer (FactBase, TableBase, IDs, queries)
- <EntityLink id="E2169" name="content-pipelines-hub">Content Pipelines</EntityLink> — page creation, improvement, validation, auto-update

## Getting Started

- <EntityLink id="E755" name="about-this-wiki">About This Wiki</EntityLink> - Comprehensive overview of how the wiki works, technical architecture, and content organization

## Automation and Tools

- <EntityLink id="E757" name="automation-tools">Automation Tools</EntityLink> - Complete reference for all scripts and CLI workflows
- <EntityLink id="E759" name="content-database">Content Database</EntityLink> - Storage architecture (PostgreSQL, caching, YAML)

## Style Guides

- <EntityLink id="E763" name="knowledge-base">Knowledge Base Style Guide</EntityLink> - Guidelines for risk and response pages (kb-2.0)
- <EntityLink id="E737" name="models">Model Style Guide</EntityLink> - Guidelines for analytical model pages
- <EntityLink id="E735" name="mermaid-diagrams">Mermaid Diagrams</EntityLink> - How to create diagrams

## Project Management

- <EntityLink id="E832" name="project-roadmap">Project Roadmap</EntityLink> - Future work, infrastructure improvements, and tracking

## Technical Reports

- [Internal Reports](/internal/reports/) - Technical research and design decisions
  - <EntityLink id="E743" name="causal-diagram-visualization">Causal Diagram Visualization</EntityLink> - Tools, literature, and best practices

---

## Quick Commands

Most common operations:

```bash
pnpm dev                                  # Start dev server
pnpm build                               # Production build
pnpm crux w validate gate --fix          # CI-blocking validation gate
pnpm crux query search "topic"           # Full-text search
pnpm crux w improve <id> --tier=standard --apply  # Improve a page
pnpm crux fb show anthropic              # Show FactBase entity
```

See the operations hubs above for full command playbooks, or <EntityLink id="E757" name="automation-tools">Automation Tools</EntityLink> for the complete reference.