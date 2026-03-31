/**
 * Validate Command Handlers
 *
 * Unified interface for all validation scripts.
 * Delegates to existing scripts via subprocess execution.
 */

import { buildCommands } from '../lib/cli.ts';

/**
 * Script definitions: maps command names to script paths and metadata
 */
const SCRIPTS = {
  daily: {
    script: 'validate/validate-daily.ts',
    description: 'Run daily validation suite (local + server checks with unified report)',
    passthrough: ['ci', 'localOnly'],
  },
  unified: {
    script: 'validate/validate-unified.ts',
    description: 'Run unified rule engine',
    passthrough: ['ci', 'rules', 'fix', 'list', 'errorsOnly', 'fixable'],
  },
  compile: {
    script: 'validate/validate-mdx-compile.ts',
    description: 'Check MDX compilation (smoke-test for rendering errors)',
    passthrough: ['ci', 'quick', 'file'],
  },
  links: {
    script: 'validate/validate-internal-links.ts',
    description: 'Check internal link resolution',
    passthrough: ['ci'],
  },
  'entity-links': {
    script: 'validate/validate-entity-links.ts',
    description: 'Check EntityLink usage and conversion candidates',
    passthrough: ['ci', 'fix'],
  },
  consistency: {
    script: 'validate/validate-consistency.ts',
    description: 'Cross-page consistency checks',
    passthrough: ['ci'],
  },
  data: {
    script: 'validate/validate-data.ts',
    description: 'Entity data integrity',
    passthrough: ['ci'],
  },
  refs: {
    script: 'validate/validate-component-refs.ts',
    description: 'EntityLink and DataInfoBox references',
    passthrough: ['ci'],
  },
  quality: {
    script: 'validate/validate-quality.ts',
    description: 'Content quality ratings (advisory)',
    passthrough: ['ci'],
  },
  schema: {
    script: 'validate/validate-yaml-schema.ts',
    description: 'YAML schema validation',
    passthrough: ['ci'],
  },
  financials: {
    script: 'validate/validate-financials.ts',
    description: 'Financial data staleness and consistency',
    passthrough: ['ci'],
  },
  'numeric-consistency': {
    script: 'validate/validate-numeric-consistency.ts',
    description: 'Cross-page numeric claim consistency checker — flag contradictory facts about the same entity',
    passthrough: ['ci', 'json', 'entity', 'top', 'limit'],
  },
  'drizzle-journal': {
    script: 'validate/validate-drizzle-journal.ts',
    description: 'Verify all migration SQL files are registered in Drizzle journal',
    passthrough: ['ci'],
  },
  gate: {
    script: 'validate/validate-gate.ts',
    description: 'CI-blocking checks (pre-push gate)',
    passthrough: ['ci', 'full', 'fix', 'fullGate', 'noTriage', 'noCache', 'scope'],
  },
  'hallucination-risk': {
    script: 'validate/validate-hallucination-risk.ts',
    description: 'Hallucination risk assessment report',
    passthrough: ['ci', 'json', 'top'],
  },
  'entity-refs': {
    script: 'validate/validate-entity-refs.ts',
    description: 'Check entity reference integrity across KB records',
    passthrough: ['ci', 'verbose', 'threshold'],
  },
  'yaml-entity-refs': {
    script: 'validate/validate-yaml-entity-refs.ts',
    description: 'Check YAML entity cross-references (relatedEntries, developer, affiliation)',
    passthrough: ['ci', 'verbose'],
  },
  'directory-pages': {
    script: 'validate/validate-directory-pages.ts',
    description: 'Audit directory page data for display issues',
    passthrough: ['ci', 'verbose', 'type'],
  },
  'cross-entity': {
    script: 'validate/cross-entity-consistency.ts',
    description: 'Cross-entity consistency (bidirectional refs, affiliation coherence)',
    passthrough: ['ci', 'verbose', 'type'],
  },
  'cross-check': {
    script: 'validate/cross-check-people.ts',
    description: 'Cross-check people roles between YAML entities and FactBase (advisory)',
    passthrough: ['ci', 'verbose'],
  },
  temporal: {
    script: 'validate/validate-temporal.ts',
    description: 'Temporal invariant validation (date validity, ordering, consistency)',
    passthrough: ['ci', 'verbose'],
  },
  'cross-base': {
    script: 'validate/validate-cross-base.ts',
    description: 'Cross-base consistency (WikiBase pages match TableBase entities, FactBase coverage)',
    passthrough: ['ci', 'verbose'],
  },
  'orphan-entities': {
    script: 'validate/validate-orphan-entities.ts',
    description: 'Detect PG entity records without YAML source (ghost entities)',
    passthrough: ['ci', 'fix'],
  },
  'soft-fks': {
    script: 'validate/validate-soft-fks.ts',
    description: 'Check that soft FK fields in PG tables resolve to entities (advisory, requires wiki-server)',
    passthrough: ['ci', 'verbose'],
  },
  'pg-temporal': {
    script: 'validate/validate-pg-temporal.ts',
    description: 'PG temporal consistency (startDate < endDate, date range validation)',
    passthrough: ['ci'],
  },
  'controlled-vocab': {
    script: 'validate/validate-controlled-vocab.ts',
    description: 'Validate controlled vocabulary fields (entityType, relationship, orgType, etc.)',
    passthrough: ['ci', 'verbose'],
  },
  'numeric-ranges': {
    script: 'validate/validate-numeric-ranges.ts',
    description: 'Validate low <= high for paired range columns (requires wiki-server)',
    passthrough: ['ci'],
  },
  'resource-refs': {
    script: 'validate/validate-resource-refs.ts',
    description: 'Validate resource authorEntityIds and publicationId references (advisory)',
    passthrough: ['ci', 'verbose'],
  },
  'display-names': {
    script: 'validate/validate-display-names.ts',
    description: 'Detect raw machine IDs in entity display fields (titles)',
    passthrough: ['ci'],
  },
  'display-formatting': {
    script: 'validate/validate-display-formatting.ts',
    description: 'Detect serialization bugs and unescaped MDX in entity data',
    passthrough: ['ci'],
  },
  'to-rdjsonl': {
    script: 'validate/to-rdjsonl.ts',
    description: 'Convert unified --ci JSON to Reviewdog rdjsonl (reads stdin)',
    passthrough: [],
  },
};

export const commands = buildCommands(SCRIPTS, 'gate');

/**
 * Get help text for validate domain
 */
export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
Validate Domain - Run validation checks

Commands:
${commandList}

Options:
  --ci            JSON output for CI pipelines
  --fix           Auto-fix issues (where supported)
  --rules=a,b     Run specific rules (unified only)
  --quick         Fast mode (compile only)
  --list          List available rules (unified only)
  --scope=content Content-only gate: skip build-data/tests/typechecks (gate only)

Examples:
  crux w validate                           Run CI-blocking gate checks
  crux w validate gate                      Run CI-blocking checks (with triage)
  crux w validate gate --full               Include full Next.js build
  crux w validate gate --no-triage          Skip LLM triage, run all checks
  crux w validate gate --no-cache           Force re-run even if stamp matches HEAD
  crux w validate gate --full-gate          Force all checks (implies --no-triage, --no-cache)
  crux w validate gate --scope=content      Content-only checks (~15s vs ~5min)
  crux w validate compile --quick           Quick compile check
  crux w validate unified --rules=dollar-signs,markdown-lists
  crux w validate unified --fix             Auto-fix unified rule issues
  crux w validate entity-links --fix        Convert markdown links to EntityLink
  crux w validate entity-refs              Check KB record entity references
  crux w validate entity-refs --threshold=90  Fail if link rate < 90%
  crux w validate daily                      Daily validation suite (local + server)
  crux w validate daily --local-only         Skip server-dependent checks
  crux w validate directory-pages            Audit directory page data quality
  crux w validate directory-pages --type=person  Check one entity type
`;
}
