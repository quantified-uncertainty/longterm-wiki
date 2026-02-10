/**
 * Fix Command Handlers
 *
 * Unified interface for auto-fix operations.
 */

import { buildCommands } from '../lib/cli.ts';

/**
 * Script definitions
 */
const SCRIPTS = {
  all: {
    script: 'auto-fix.mjs',
    description: 'Run all auto-fixers',
    passthrough: ['dryRun'],
  },
  'entity-links': {
    script: 'validate/validate-entity-links.ts',
    description: 'Convert markdown links to EntityLink',
    passthrough: ['ci'],
    extraArgs: ['--fix'],
  },
  'cross-links': {
    script: 'fix/fix-cross-links.mjs',
    description: 'Add EntityLinks to plain text entity mentions',
    passthrough: ['apply', 'verbose', 'file'],
  },
  'broken-links': {
    script: 'fix-broken-links.mjs',
    description: 'Fix broken internal links',
    passthrough: ['dryRun'],
    extraArgs: ['--fix'],
  },
  markdown: {
    script: 'validate/validate-unified.ts',
    description: 'Fix markdown formatting (lists, bold labels)',
    passthrough: ['ci'],
    extraArgs: ['--rules=markdown-lists,consecutive-bold-labels', '--fix'],
  },
  escaping: {
    script: 'validate/validate-unified.ts',
    description: 'Fix escaping issues (dollars, comparisons, tildes)',
    passthrough: ['ci'],
    extraArgs: ['--rules=dollar-signs,comparison-operators,tilde-dollar', '--fix'],
  },
  dollars: {
    script: 'validate/validate-unified.ts',
    description: 'Escape dollar signs for LaTeX',
    passthrough: ['ci'],
    extraArgs: ['--rules=dollar-signs', '--fix'],
  },
  comparisons: {
    script: 'validate/validate-unified.ts',
    description: 'Escape comparison operators',
    passthrough: ['ci'],
    extraArgs: ['--rules=comparison-operators', '--fix'],
  },
  frontmatter: {
    script: 'validate/validate-unified.ts',
    description: 'Fix frontmatter issues (unquoted dates)',
    passthrough: ['ci'],
    extraArgs: ['--rules=frontmatter-schema', '--fix'],
  },
  imports: {
    script: 'fix/fix-component-imports.mjs',
    description: 'Add missing component imports to MDX files',
    passthrough: ['apply', 'verbose', 'file'],
  },
};

export const commands = buildCommands(SCRIPTS, 'all');

/**
 * Get help text
 */
export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
Fix Domain - Auto-fix operations

Commands:
${commandList}

Options:
  --dry-run       Preview changes without applying
  --ci            JSON output for CI pipelines

Examples:
  crux fix                          Run all auto-fixers
  crux fix --dry-run                Preview all fixes
  crux fix entity-links             Convert markdown links to EntityLink
  crux fix escaping                 Fix all escaping issues
  crux fix markdown                 Fix markdown formatting
  crux fix dollars                  Escape dollar signs only
`;
}
