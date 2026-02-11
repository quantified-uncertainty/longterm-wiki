/**
 * Generate Command Handlers
 *
 * Unified interface for content generation scripts.
 */

import { buildCommands } from '../lib/cli.ts';

/**
 * Script definitions
 */
const SCRIPTS = {
  yaml: {
    script: 'generate/generate-yaml.ts',
    description: 'Generate YAML from MDX files',
    passthrough: ['ci', 'verbose', 'dryRun'],
    positional: true,
  },
  summaries: {
    script: 'generate/generate-summaries.ts',
    description: 'Generate summaries with AI',
    passthrough: ['ci', 'type', 'batch', 'concurrency', 'model', 'resummary', 'id', 'dryRun', 'verbose'],
  },
  diagrams: {
    script: 'generate/generate-data-diagrams.ts',
    description: 'Generate diagrams from entity data',
    passthrough: ['ci', 'verbose'],
  },
  'schema-diagrams': {
    script: 'generate/generate-schema-diagrams.ts',
    description: 'Generate schema diagrams',
    passthrough: ['ci'],
  },
  'schema-docs': {
    script: 'generate/generate-schema-docs.ts',
    description: 'Generate documentation from schema',
    passthrough: ['ci'],
  },
  reports: {
    script: 'generate/generate-research-reports.ts',
    description: 'Generate research reports',
    passthrough: ['ci', 'topic', 'output', 'verbose'],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS);

/**
 * Get help text
 */
export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(16)} ${config.description}`)
    .join('\n');

  return `
Generate Domain - Content generation

Commands:
${commandList}

Options:
  --type=<t>         Entity type: articles, sources (summaries)
  --batch=<n>        Batch size (summaries)
  --concurrency=<n>  Parallel calls (summaries)
  --model=<m>        Model: haiku, sonnet, opus (summaries)
  --resummary        Re-summarize changed items (summaries)
  --id=<id>          Specific entity ID (summaries)
  --topic=<t>        Research topic (reports)
  --output=<path>    Output path (reports, yaml)
  --dry-run          Preview without changes
  --verbose          Detailed output

Examples:
  crux generate yaml content/docs/risks/
  crux generate summaries --batch 50 --model haiku
  crux generate diagrams
  crux generate schema-docs
  crux generate reports "AI governance gaps"
`;
}
