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
  all: {
    script: 'validate/validate-all.ts',
    description: 'Run all validation checks',
    passthrough: ['ci', 'failFast', 'skip', 'fix'],
  },
  unified: {
    script: 'validate/validate-unified.ts',
    description: 'Run unified rule engine',
    passthrough: ['ci', 'rules', 'fix', 'list', 'errorsOnly', 'fixable'],
  },
  compile: {
    script: 'validate/validate-mdx-compile.ts',
    description: 'Check MDX compilation',
    passthrough: ['ci', 'quick'],
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
  'cross-links': {
    script: 'validate/validate-cross-links.ts',
    description: 'Check for missing cross-links between related pages',
    passthrough: ['ci', 'threshold', 'json'],
  },
  mermaid: {
    script: 'validate/validate-mermaid.ts',
    description: 'Validate Mermaid diagram syntax',
    passthrough: ['ci', 'render'],
  },
  style: {
    script: 'validate/validate-style-guide.ts',
    description: 'Check style guide compliance',
    passthrough: ['ci'],
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
  sidebar: {
    script: 'validate/validate-sidebar.ts',
    description: 'Sidebar configuration',
    passthrough: ['ci'],
  },
  orphans: {
    script: 'validate/validate-orphaned-files.ts',
    description: 'Find orphaned/temp files',
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
  'edit-logs': {
    script: 'validate/validate-edit-logs.ts',
    description: 'Edit log schema and integrity',
    passthrough: ['ci'],
  },
  'session-logs': {
    script: 'validate/validate-session-logs.ts',
    description: 'Session log format and required fields',
    passthrough: ['ci'],
  },
  financials: {
    script: 'validate/validate-financials.ts',
    description: 'Financial data staleness and consistency',
    passthrough: ['ci'],
  },
  gate: {
    script: 'validate/validate-gate.ts',
    description: 'CI-blocking checks (pre-push gate)',
    passthrough: ['ci', 'full', 'fix'],
  },
  'hallucination-risk': {
    script: 'validate/validate-hallucination-risk.ts',
    description: 'Hallucination risk assessment report',
    passthrough: ['ci', 'json', 'top'],
  },
};

export const commands = buildCommands(SCRIPTS, 'all');

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
  --skip=a,b      Skip specific checks (all only)
  --rules=a,b     Run specific rules (unified only)
  --quick         Fast mode (compile only)
  --list          List available rules (unified only)
  --fail-fast     Stop on first failure (all only)

Examples:
  crux validate                           Run all checks
  crux validate gate                      Run CI-blocking checks (pre-push)
  crux validate gate --full               Include full Next.js build
  crux validate compile --quick           Quick compile check
  crux validate unified --rules=dollar-signs,markdown-lists
  crux validate unified --fix             Auto-fix unified rule issues
  crux validate entity-links --fix        Convert markdown links to EntityLink
  crux validate all --skip=mermaid,style  Skip specific checks
`;
}
