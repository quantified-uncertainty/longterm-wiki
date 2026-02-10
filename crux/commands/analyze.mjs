/**
 * Analyze Command Handlers
 *
 * Unified interface for analysis and reporting scripts.
 */

import { buildCommands } from '../lib/cli.mjs';

/**
 * Script definitions
 */
const SCRIPTS = {
  all: {
    script: 'analyze/analyze-all.mjs',
    description: 'Run all analysis checks (health report)',
    passthrough: ['json', 'brief'],
  },
  mentions: {
    script: 'validate/validate-unified.mjs',
    description: 'Find unlinked entity mentions',
    passthrough: ['ci'],
    extraArgs: ['--rules=entity-mentions'],
  },
  links: {
    script: 'analyze/analyze-link-coverage.mjs',
    description: 'Analyze cross-reference coverage',
    passthrough: ['json', 'orphans', 'topLinked', 'page'],
  },
  'entity-links': {
    script: 'analyze/analyze-entity-links.mjs',
    description: 'Analyze linking for a specific entity',
    passthrough: ['json', 'help'],
    positional: true,
  },
  quality: {
    script: 'validate/validate-quality.mjs',
    description: 'Content quality ratings',
    passthrough: ['ci'],
  },
  scan: {
    script: 'scan-content.mjs',
    description: 'Scan content for statistics',
    passthrough: ['stats'],
  },
};

export const commands = buildCommands(SCRIPTS, 'all');

/**
 * Get help text
 */
export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(12)} ${config.description}`)
    .join('\n');

  return `
Analyze Domain - Analysis and reporting

Commands:
${commandList}

Options:
  --json          JSON output
  --brief         Summary only (all)
  --verbose       Detailed output (mentions)
  --orphans       Show poorly-linked pages (links)
  --top-linked    Show most linked pages (links)
  --page=<id>     Analyze specific page (links)
  --stats         Show statistics (scan)

Examples:
  crux analyze                         Full health report
  crux analyze --brief                 Summary only
  crux analyze mentions --verbose      Detailed unlinked mentions
  crux analyze links --orphans         Find orphaned pages
  crux analyze links --top-linked      Find most linked pages
  crux analyze entity-links sam-altman Check linking for an entity
`;
}
