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
  'sync-facts': {
    script: 'wiki-server/sync-facts.ts',
    description: 'Sync KB facts from packages/factbase/data/ to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-entities': {
    script: 'wiki-server/sync-entities.ts',
    description: 'Sync data/entities/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-session': {
    script: 'wiki-server/sync-session.ts',
    description: 'Sync a single session YAML file to wiki-server',
    passthrough: [],
    positional: true,
  },
  'sync-sessions': {
    script: 'wiki-server/sync-sessions.ts',
    description: 'Sync all .claude/sessions/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-benchmarks': {
    script: 'wiki-server/sync-benchmarks.ts',
    description: 'Sync benchmark definitions + results to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-auto-update-runs': {
    script: 'wiki-server/sync-auto-update-runs.ts',
    description: 'Sync data/auto-update/runs/*.yaml to wiki-server',
    passthrough: ['dryRun', 'dry-run'],
  },
  'sync-assessments': {
    script: 'wiki-server/sync-assessments.ts',
    description: 'Sync page assessments (quality, importance, ratings) to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-entity-events': {
    script: 'wiki-server/sync-entity-events.ts',
    description: 'Sync data/entity-events/*.yaml (org timelines) to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-entity-assessments': {
    script: 'wiki-server/sync-entity-assessments.ts',
    description: 'Sync data/entity-assessments/*.yaml (org Quick Assessment tables) to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-coverage-scans': {
    script: 'wiki-server/sync-coverage-scans.ts',
    description: 'Compute entity coverage scores and sync to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'sync-scanner-results': {
    script: 'wiki-server/sync-scanner-results.ts',
    description: 'Run full TableBase scan and persist results to wiki-server',
    passthrough: ['dryRun', 'dry-run', 'batchSize', 'batch-size'],
  },
  'snapshot-resources': {
    script: 'wiki-server/snapshot-resources.ts',
    description: 'Export PG resources to data/resources-snapshot.json',
    passthrough: ['dryRun', 'dry-run'],
  },
  'snapshot-policy-stakeholders': {
    script: 'wiki-server/snapshot-policy-stakeholders.ts',
    description: 'Export PG policy stakeholders to data/policy-stakeholders-snapshot.json (QUA-960)',
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
  crux sys wiki-server sync                      Sync all pages
  crux sys wiki-server sync --dry-run            Preview page sync
  crux sys wiki-server sync --batch-size=25      Use smaller batches
  crux sys wiki-server sync-entities             Sync all entities
  crux sys wiki-server sync-entities --dry-run   Preview entity sync
  crux sys wiki-server sync-benchmarks             Sync benchmarks + results
  crux sys wiki-server sync-benchmarks --dry-run   Preview benchmark sync
  crux sys wiki-server sync-session .claude/sessions/2026-02-21_my-branch.yaml
  crux sys wiki-server sync-sessions           Sync all session logs
  crux sys wiki-server sync-auto-update-runs   Sync all auto-update runs
  crux sys wiki-server sync-entity-events      Sync org timelines from data/entity-events/
  crux sys wiki-server snapshot-resources      Export PG resources to snapshot JSON
  crux sys wiki-server snapshot-policy-stakeholders  Export PG policy stakeholders to snapshot JSON
`;
}