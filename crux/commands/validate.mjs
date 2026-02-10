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
    script: 'validate/validate-all.mjs',
    description: 'Run all validation checks',
    passthrough: ['ci', 'failFast', 'skip', 'fix'],
  },
  unified: {
    script: 'validate/validate-unified.mjs',
    description: 'Run unified rule engine',
    passthrough: ['ci', 'rules', 'fix', 'list', 'errorsOnly', 'fixable'],
  },
  compile: {
    script: 'validate/validate-mdx-compile.mjs',
    description: 'Check MDX compilation',
    passthrough: ['ci', 'quick'],
  },
  links: {
    script: 'validate/validate-internal-links.mjs',
    description: 'Check internal link resolution',
    passthrough: ['ci'],
  },
  'entity-links': {
    script: 'validate/validate-entity-links.mjs',
    description: 'Check EntityLink usage and conversion candidates',
    passthrough: ['ci', 'fix'],
  },
  'cross-links': {
    script: 'validate/validate-cross-links.mjs',
    description: 'Check for missing cross-links between related pages',
    passthrough: ['ci', 'threshold', 'json'],
  },
  mermaid: {
    script: 'validate/validate-mermaid.mjs',
    description: 'Validate Mermaid diagram syntax',
    passthrough: ['ci', 'render'],
  },
  style: {
    script: 'validate/validate-style-guide.mjs',
    description: 'Check style guide compliance',
    passthrough: ['ci'],
  },
  consistency: {
    script: 'validate/validate-consistency.mjs',
    description: 'Cross-page consistency checks',
    passthrough: ['ci'],
  },
  data: {
    script: 'validate/validate-data.mjs',
    description: 'Entity data integrity',
    passthrough: ['ci'],
  },
  refs: {
    script: 'validate/validate-component-refs.mjs',
    description: 'EntityLink and DataInfoBox references',
    passthrough: ['ci'],
  },
  sidebar: {
    script: 'validate/validate-sidebar.mjs',
    description: 'Sidebar configuration',
    passthrough: ['ci'],
  },
  orphans: {
    script: 'validate/validate-orphaned-files.mjs',
    description: 'Find orphaned/temp files',
    passthrough: ['ci'],
  },
  quality: {
    script: 'validate/validate-quality.mjs',
    description: 'Content quality ratings (advisory)',
    passthrough: ['ci'],
  },
  insights: {
    script: 'validate/validate-insights.mjs',
    description: 'Insight schema and ratings',
    passthrough: ['ci'],
  },
  schema: {
    script: 'validate/validate-yaml-schema.mjs',
    description: 'YAML schema validation',
    passthrough: ['ci'],
  },
  financials: {
    script: 'validate/validate-financials.mjs',
    description: 'Financial data staleness and consistency',
    passthrough: ['ci'],
  },
};

export const commands = buildCommands(SCRIPTS, 'all');

/**
 * List available rules (for unified engine)
 */
export async function listRules(args, options) {
  return commands.unified(args, { ...options, list: true });
}

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
  crux validate compile --quick           Quick compile check
  crux validate unified --rules=dollar-signs,markdown-lists
  crux validate unified --fix             Auto-fix unified rule issues
  crux validate entity-links --fix        Convert markdown links to EntityLink
  crux validate all --skip=mermaid,style  Skip specific checks
`;
}
