/**
 * Wiki Server Command Handlers
 *
 * Manage wiki-server data sync and operations.
 */

import { buildCommands } from '../lib/cli.ts';

const SCRIPTS = {
  sync: {
    script: 'wiki-server/sync-pages.ts',
    description: 'Sync wiki page content and metadata to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size', 'ci'],
  },
  'sync-session': {
    script: 'wiki-server/sync-session.ts',
    description: 'Sync a single session YAML file to wiki-server',
    passthrough: [],
    positional: true,
  },
};

export const commands = buildCommands(SCRIPTS, 'sync');

export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
Wiki Server Domain - Manage wiki-server data

Commands:
${commandList}

Options:
  --dry-run          Preview what would be synced without making changes
  --batch-size=N     Number of pages per batch (default: 50)

Environment:
  LONGTERMWIKI_SERVER_URL     Base URL of the wiki server
  LONGTERMWIKI_SERVER_API_KEY Bearer token for authentication

Examples:
  crux wiki-server sync                  Sync all pages
  crux wiki-server sync --dry-run        Preview sync
  crux wiki-server sync --batch-size=25  Use smaller batches
  crux wiki-server sync-session .claude/sessions/2026-02-21_my-branch.yaml
`;
}
