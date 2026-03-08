/**
 * Statements Command Handlers
 *
 * Extract, verify, and review structured statements from wiki pages.
 * Statements are the successor to claims — richer structured data with
 * properties from the controlled vocabulary, typed values, and citations.
 *
 * Usage:
 *   crux statements list <entity-id>               List statements for an entity
 *   crux statements create <entity-id> --property=X Create a statement
 *   crux statements update <id> --property=X        Update a statement
 *   crux statements retract <id>                    Retract a statement
 *   crux statements properties                      List all properties
 *   crux statements draft <entity-id>               Generate ontology review draft
 *   crux statements apply-draft <entity-id>         Execute approved draft changes
 *   crux statements extract <page-id> [--apply]     Extract statements from a page (LLM)
 *   crux statements verify <page-id> [--apply]      Verify statements against cited sources
 *   crux statements quality <page-id>               Coverage and quality report
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  // --- CRUD commands ---
  list: {
    script: 'statements/list.ts',
    description: 'List statements for an entity',
    passthrough: ['property', 'active-only', 'json'],
    positional: true,
  },
  create: {
    script: 'statements/create-stmt.ts',
    description: 'Create a new statement',
    passthrough: ['property', 'value', 'value-text', 'value-entity', 'value-date', 'date', 'unit', 'text', 'variety', 'citation-url', 'note', 'json'],
    positional: true,
  },
  update: {
    script: 'statements/update-stmt.ts',
    description: 'Update an existing statement',
    passthrough: ['property', 'status', 'text', 'variety', 'date', 'note', 'reason', 'json'],
    positional: true,
  },
  retract: {
    script: 'statements/retract.ts',
    description: 'Retract one or all statements',
    passthrough: ['all', 'property', 'reason', 'confirm', 'json'],
    positional: true,
  },
  properties: {
    script: 'statements/properties-list.ts',
    description: 'List all property definitions with usage counts',
    passthrough: ['category', 'unused', 'json'],
    positional: false,
  },
  // --- Ontology workflow ---
  draft: {
    script: 'statements/draft.ts',
    description: 'Generate an ontology review draft (markdown) for an entity',
    passthrough: ['org-type', 'output'],
    positional: true,
  },
  'apply-draft': {
    script: 'statements/apply-draft.ts',
    description: 'Execute approved actions from an ontology draft',
    passthrough: ['dry-run', 'input'],
    positional: true,
  },
  // --- Analysis commands ---
  extract: {
    script: 'statements/extract.ts',
    description: 'Extract structured statements from a wiki page using LLM',
    passthrough: ['apply', 'model', 'dry-run'],
    positional: true,
  },
  verify: {
    script: 'statements/verify.ts',
    description: 'Verify statements against cited source text',
    passthrough: ['apply', 'model', 'fetch'],
    positional: true,
  },
  quality: {
    script: 'statements/quality.ts',
    description: 'Coverage and quality report for page statements',
    passthrough: ['json'],
    positional: true,
  },
  score: {
    script: 'statements/score.ts',
    description: 'Score statements for quality across 10 dimensions',
    passthrough: ['json', 'dry-run', 'llm', 'org-type'],
    positional: true,
  },
  gaps: {
    script: 'statements/gaps.ts',
    description: 'Coverage gap analysis — which categories need more statements',
    passthrough: ['json', 'org-type'],
    positional: true,
  },
  improve: {
    script: 'statements/improve.ts',
    description: 'Generate new statements to fill coverage gaps',
    passthrough: ['json', 'dry-run', 'org-type', 'category', 'no-research', 'min-score', 'budget', 'target-coverage', 'max-iterations', 'mode'],
    positional: true,
  },
  ideate: {
    script: 'statements/ideate.ts',
    description: 'Analyze statements and suggest sub-entity splits',
    passthrough: ['json', 'apply', 'min-cluster', 'budget'],
    positional: true,
  },
  'seed-properties': {
    script: 'statements/seed-properties.ts',
    description: 'Seed missing property definitions for coverage target categories',
    passthrough: ['dry-run'],
    positional: false,
  },
  audit: {
    script: 'statements/audit.ts',
    description: 'Detect duplicate and missing-qualifier conflicts in active statements',
    passthrough: ['fix', 'json'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'quality');

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(18)} ${config.description}`)
    .join('\n');

  return `
Statements Domain — CRUD, ontology review, and analysis for structured statements

CRUD Commands:
${commandList.split('\n').filter(l => /^\s+(list|create|update|retract|properties)\s/.test(l)).join('\n')}

Ontology Workflow:
${commandList.split('\n').filter(l => /^\s+(draft|apply-draft)\s/.test(l)).join('\n')}

Analysis Commands:
${commandList.split('\n').filter(l => /^\s+(extract|verify|quality|score|gaps|improve|ideate|seed-properties|audit)\s/.test(l)).join('\n')}

CRUD Examples:
  crux statements list anthropic                   List all statements
  crux statements list anthropic --property=revenue --active-only
  crux statements create anthropic --property=revenue --value=19000000000 --date=2026-03
  crux statements create anthropic --text="Quote text" --variety=attributed
  crux statements update 12345 --property=revenue   Assign/change property
  crux statements update 12345 --status=retracted --reason="duplicate"
  crux statements retract 12345 --reason="duplicate of #123"
  crux statements retract anthropic --all --confirm  Retract all for entity
  crux statements properties                        List all properties
  crux statements properties --category=financial    Filter by category
  crux statements properties --unused                Show unused properties

Ontology Workflow:
  crux statements draft anthropic                   Generate review draft
  crux statements draft anthropic --org-type=frontier-lab
  crux statements apply-draft anthropic             Execute approved changes
  crux statements apply-draft anthropic --dry-run   Preview without executing

Analysis Workflow:
  1. crux statements extract <page-id> --apply     Extract statements from page
  2. crux statements verify <page-id> --apply      Verify against cited sources
  3. crux statements score <page-id>               Score statement quality
  4. crux statements gaps <page-id>                Identify coverage gaps
  5. crux statements quality <page-id>             Review coverage and quality
  6. crux statements draft <entity-id>             Generate ontology review draft
  7. crux statements apply-draft <entity-id>       Execute approved changes

Claude Code Skills:
  /ontology-review <entity>    Deep ontological reasoning about entity structure
  /entity-deep-dive <entity>   Comprehensive entity quality review + fixes
  /knowledge-gap [area]        Identify missing topics and thin coverage areas
`;
}
