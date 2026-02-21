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
  'sync-resources': {
    script: 'wiki-server/sync-resources.ts',
    description: 'Sync data/resources/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-entities': {
    script: 'wiki-server/sync-entities.ts',
    description: 'Sync data/entities/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-facts': {
    script: 'wiki-server/sync-facts.ts',
    description: 'Sync data/facts/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-session': {
    script: 'wiki-server/sync-session.ts',
    description: 'Sync a single session YAML file to wiki-server',
    passthrough: [],
    positional: true,
  },
  'sync-edit-logs': {
    script: 'wiki-server/sync-edit-logs.ts',
    description: 'Sync data/edit-logs/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-sessions': {
    script: 'wiki-server/sync-sessions.ts',
    description: 'Sync all .claude/sessions/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-auto-update-runs': {
    script: 'wiki-server/sync-auto-update-runs.ts',
    description: 'Sync data/auto-update/runs/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run'],
  },
};

export const commands = buildCommands(SCRIPTS, 'sync');

export function getHelp() {
  const maxLen = Math.max(...Object.keys(SCRIPTS).map((n) => n.length));
  const pad = maxLen + 2;
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(pad)} ${config.description}`)
    .join('\n');

  return `
Wiki Server Domain - Manage wiki-server data

Commands:
${commandList}

Options:
  --dry-run          Preview what would be synced without making changes
  --batch-size=N     Number of items per batch (default varies by sync type)

Environment:
  LONGTERMWIKI_SERVER_URL     Base URL of the wiki server
  LONGTERMWIKI_SERVER_API_KEY Bearer token for authentication

Examples:
  crux wiki-server sync                      Sync all pages
  crux wiki-server sync --dry-run            Preview page sync
  crux wiki-server sync --batch-size=25      Use smaller batches
  crux wiki-server sync-resources            Sync all resources
  crux wiki-server sync-entities             Sync all entities
  crux wiki-server sync-entities --dry-run   Preview entity sync
  crux wiki-server sync-facts                Sync all facts
  crux wiki-server sync-facts --dry-run      Preview fact sync
  crux wiki-server sync-session .claude/sessions/2026-02-21_my-branch.yaml
  crux wiki-server sync-edit-logs          Sync all edit logs
  crux wiki-server sync-sessions           Sync all session logs
  crux wiki-server sync-auto-update-runs   Sync all auto-update runs
`;
}
