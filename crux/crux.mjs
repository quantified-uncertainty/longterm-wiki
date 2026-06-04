#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Crux Project CLI
 *
 * Unified command-line interface for project tools.
 *
 * Usage:
 *   crux <group> <domain> <command> [options]   # Group routing (preferred)
 *   crux <group> <command> [options]             # Flattened group command
 *   crux <domain> <command> [options]            # Legacy flat routing (still works)
 *
 * Groups:
 *   w   / wiki       Wiki content (validate, fix, content, citations, ...)
 *   fb  / factbase   FactBase (show, list, verify, migrate, ...)
 *   tb  / tablebase  TableBase (scan, gaps, people, orgs, ids, imports, ...)
 *   gh              GitHub (issues, pr, ci, epic, release, ...)
 *   sys / system     System (agents, jobs, sessions, health, audits, ...)
 *
 * Cross-cutting (top-level):
 *   query       Query wiki-server DB
 *   context     Assemble research bundles
 *
 * Global Options:
 *   --ci        JSON output for CI pipelines
 *   --help      Show help
 *
 * Examples:
 *   crux w validate gate --fix          Wiki validation gate
 *   crux w improve far-ai --tier=deep   Improve a wiki page (flattened from content)
 *   crux fb show anthropic              Show FactBase entity
 *   crux tb people discover             Discover people (TableBase)
 *   crux gh issues start 42             Start working on issue #42
 *   crux validate gate --fix            Legacy flat syntax (still works)
 */

import { createLogger } from './lib/output.ts';
import { parseCliArgs as _parseCliArgs, kebabToCamel } from './lib/cli.ts';
import { GROUPS, buildShortcutMap, checkGroupDomainCollisions, resolveGroupRouting } from './lib/groups.ts';

// Domain handlers
import * as validateCommands from './commands/validate.ts';
import * as analyzeCommands from './commands/analyze.ts';
import * as fixCommands from './commands/fix.ts';
import * as contentCommands from './commands/content.ts';
import * as generateCommands from './commands/generate.ts';
import * as visualCommands from './commands/visual.ts';
import * as resourcesCommands from './commands/resources.ts';
import * as updatesCommands from './commands/updates.ts';
import * as checkLinksCommands from './commands/check-links.ts';
import * as editLogCommands from './commands/edit-log.ts';
import * as importanceCommands from './commands/importance.ts';
import * as ciCommands from './commands/ci.ts';
import * as maintainCommands from './commands/maintain.ts';
import * as autoUpdateCommands from './commands/auto-update.ts';
import * as reviewCommands from './commands/review.ts';
import * as citationsCommands from './commands/citations.ts';
import * as grokipediaCommands from './commands/grokipedia.ts';
import * as issuesCommands from './commands/issues.ts';
import * as agentChecklistCommands from './commands/agent-checklist.ts';
import * as reviewPhaseCommands from './commands/review-phase.ts';
import * as entityCommands from './commands/entity.ts';
import * as prCommands from './commands/pr.ts';
import * as wikiServerCommands from './commands/wiki-server.ts';
import * as queryCommands from './commands/query.ts';
import * as jobsCommands from './commands/jobs.ts';
import * as contextCommands from './commands/context.ts';
import * as enrichCommands from './commands/enrich.ts';
import * as enrichmentCommands from './commands/enrichment.ts';
import * as sessionsCommands from './commands/sessions.ts';
import * as researchCommands from './commands/research.ts';
import * as evalsCommands from './commands/evals.ts';
import * as healthCommands from './commands/health.ts';
import * as epicCommands from './commands/epic.ts';
import * as idsCommands from './commands/ids.ts';
import * as agentsCommands from './commands/agents.ts';
import * as agentSessionEventsCommands from './commands/agent-session-events.ts';
import * as auditsCommands from './commands/audits.ts';
import * as releaseCommands from './commands/release.ts';
import * as prPatrolCommands from './commands/pr-patrol.ts';
import * as healthMonitorCommands from './commands/health-monitor.ts';
import * as factbaseCommands from './commands/factbase.ts';
import * as factbaseImport990Commands from './commands/factbase-import-990.ts';
import * as footnotesCommands from './commands/footnotes.ts';
import * as agentWorkspaceCommands from './commands/agent-workspace.ts';
import * as importGrantsCommands from './commands/import-grants.ts';
import * as importScorecardsCommands from './commands/import-scorecards.ts';
import * as backfillGranteeIdsCommands from './commands/backfill-grantee-ids.ts';
import * as backfillProgramIdsCommands from './commands/backfill-program-ids.ts';
import * as importDivisionsCommands from './commands/import-divisions.ts';
import * as importFundingProgramsCommands from './commands/import-funding-programs.ts';
import * as importQuriPersonnelCommands from './commands/import-quri-personnel.ts';
import * as peopleCommands from './commands/people.ts';
import * as orgsCommands from './commands/orgs.ts';
import * as researchAreasCommands from './commands/research-areas.ts';
import * as autoVerifyStakeholdersCommands from './commands/legislation/auto-verify-stakeholders.ts';
import * as backfillStableIdsCommand from './commands/backfill-stable-ids.ts';
import * as backfillYamlStableIdsCommand from './commands/backfill-yaml-stable-ids.ts';
import * as backfillPrOutcomesCommands from './commands/backfill-pr-outcomes.ts';
import * as factbaseMigrateEntitiesCommands from './commands/factbase-migrate-entities.ts';
import * as verifyOrchestrateCommands from './commands/sourcing-orchestrate.ts';
import * as sourcingRecheckCommands from './commands/sourcing-recheck.ts';
import * as sourcingRetroScanSubjectsCommands from './commands/sourcing-retro-scan-subjects.ts';
import * as sourcingAuditUrlsCommands from './commands/sourcing-audit-urls.ts';
import * as sourcingBackfillHomepagesCommands from './commands/sourcing-backfill-homepages.ts';
import * as sourcingSampleCoverageCommands from './commands/sourcing-sample-coverage.ts';
import * as sourcingSuggestUrlsCommands from './commands/sourcing-suggest-urls.ts';
import * as sourcingApplySuggestionsCommands from './commands/sourcing-apply-suggestions.ts';
import * as sourcingCleanupOrphansCommands from './commands/sourcing-cleanup-orphans.ts';
import * as sourcingResolveContradictedCommands from './commands/sourcing-resolve-contradicted.ts';
import * as migrateCitationsCommands from './commands/migrate-citations.ts';
import * as verifyEntityCommands from './commands/verify-entity.ts';
import * as sourcingWikiPagesCommands from './commands/sourcing-wiki-pages.ts';
import * as qaSweepCommands from './commands/qa-sweep.ts';
import * as qaChecksCommands from './commands/qa-checks.ts';
import * as matrixCommands from './commands/matrix.ts';
import * as tablebaseCommands from './commands/tablebase.ts';
import * as improveEntityCommands from './commands/research-improve-entity.ts';
import * as improveEntitySuiteCommands from './commands/research-improve-entity-suite.ts';
import * as benchmarkCommands from './commands/research-benchmark.ts';
import * as benchmarkSuiteCommands from './commands/research-benchmark-suite.ts';
import * as pipelineRegressionCheckCommands from './commands/research-pipeline-regression-check.ts';
import * as pagesCommands from './commands/pages.ts';
import * as legislationCommands from './commands/legislation.ts';
import * as extractStructuredDataCommands from './commands/extract-structured-data.ts';
import * as verifyConsistencyCommands from './commands/verify-consistency.ts';
import * as wikidataEnrichCommands from './commands/wikidata-enrich.ts';
import * as dataQualityCommands from './commands/data-quality.ts';
import * as blueskyCommands from './commands/bluesky.ts';
import * as politicalRacesCommands from './commands/political-races.ts';
import * as politicalDataCommands from './commands/political-data.ts';
import * as scorecardsCommands from './commands/scorecards.ts';
import * as branchesCommands from './commands/branches.ts';
import * as deployTasksCommands from './commands/deploy-tasks.ts';
import * as agentResetCommands from './commands/agent-reset.ts';
import * as agentEndCommands from './commands/agent-end.ts';
import * as costCommands from './commands/cost.ts';
import * as benchmarksCommands from './commands/benchmarks.ts';
import * as usagePatternsCommands from './commands/usage-patterns.ts';
import * as entityResourcesCommands from './commands/entity-resources.ts';
import * as docsCommands from './commands/docs.ts';
import * as linearCommands from './commands/linear.ts';
import * as flagshipCurateCommands from './commands/flagship-curate.ts';
import * as sessionFinalizeCommands from './commands/session-finalize.ts';
import * as dispatchCommands from './commands/dispatch.ts';
import * as auditCommands from './commands/audit.ts';
import { primeAuditSessionId } from './lib/wiki-server/audit-context.ts';
import * as aiidCommands from './commands/ingest-aiid.ts';
import * as oecdAimCommands from './commands/ingest-oecd-aim.ts';
import * as migrationsCommands from './commands/migrations.ts';

const domains = {
  validate: validateCommands,
  analyze: analyzeCommands,
  fix: fixCommands,
  content: contentCommands,
  generate: generateCommands,
  visual: visualCommands,
  resources: resourcesCommands,
  updates: updatesCommands,
  'auto-update': autoUpdateCommands,
  'check-links': checkLinksCommands,
  'edit-log': editLogCommands,
  importance: importanceCommands,
  ci: ciCommands,
  maintain: maintainCommands,
  review: reviewCommands,
  citations: citationsCommands,
  grokipedia: grokipediaCommands,
  issues: issuesCommands,
  'agent-checklist': agentChecklistCommands,
  'review-phase': reviewPhaseCommands,
  entity: entityCommands,
  'entity-resources': entityResourcesCommands,
  pr: prCommands,
  'wiki-server': wikiServerCommands,
  query: queryCommands,
  jobs: jobsCommands,
  context: contextCommands,
  enrich: enrichCommands,
  enrichment: enrichmentCommands,
  sessions: sessionsCommands,
  research: researchCommands,
  evals: evalsCommands,
  health: healthCommands,
  epic: epicCommands,
  ids: idsCommands,
  agents: agentsCommands,
  'agent-session-events': agentSessionEventsCommands,
  audits: auditsCommands,
  release: releaseCommands,
  'pr-patrol': prPatrolCommands,
  'health-monitor': healthMonitorCommands,
  factbase: factbaseCommands,
  kb: factbaseCommands, // deprecated alias
  'import-990': factbaseImport990Commands,
  footnotes: footnotesCommands,
  'agent-workspace': agentWorkspaceCommands,
  'import-grants': importGrantsCommands,
  'import-scorecards': importScorecardsCommands,
  'backfill-grantee-ids': backfillGranteeIdsCommands,
  'backfill-program-ids': backfillProgramIdsCommands,
  'import-divisions': importDivisionsCommands,
  'import-funding-programs': importFundingProgramsCommands,
  'import-quri-personnel': importQuriPersonnelCommands,
  people: peopleCommands,
  orgs: orgsCommands,
  'research-areas': researchAreasCommands,
  'auto-verify-stakeholders': autoVerifyStakeholdersCommands,
  'backfill-stable-ids': backfillStableIdsCommand,
  'backfill-yaml-stable-ids': backfillYamlStableIdsCommand,
  'backfill-pr-outcomes': backfillPrOutcomesCommands,
  'factbase-migrate-entities': factbaseMigrateEntitiesCommands,
  verify: verifyEntityCommands,
  'verify-orchestrate': verifyOrchestrateCommands,
  'sourcing-recheck': sourcingRecheckCommands,
  'sourcing-retro-scan-subjects': sourcingRetroScanSubjectsCommands,
  'sourcing-audit-urls': sourcingAuditUrlsCommands,
  'sourcing-backfill-homepages': sourcingBackfillHomepagesCommands,
  'sourcing-sample-coverage': sourcingSampleCoverageCommands,
  'sourcing-suggest-urls': sourcingSuggestUrlsCommands,
  'sourcing-apply-suggestions': sourcingApplySuggestionsCommands,
  'sourcing-cleanup-orphans': sourcingCleanupOrphansCommands,
  'sourcing-resolve-contradicted': sourcingResolveContradictedCommands,
  'migrate-citations': migrateCitationsCommands,
  'sourcing-wiki-pages': sourcingWikiPagesCommands,
  'qa-sweep': qaSweepCommands,
  'qa-checks': qaChecksCommands,
  matrix: matrixCommands,
  tablebase: tablebaseCommands,
  'improve-entity': improveEntityCommands,
  'improve-entity-suite': improveEntitySuiteCommands,
  benchmark: benchmarkCommands,
  'benchmark-suite': benchmarkSuiteCommands,
  'pipeline-regression-check': pipelineRegressionCheckCommands,
  pages: pagesCommands,
  legislation: legislationCommands,
  'extract-structured-data': extractStructuredDataCommands,
  'verify-consistency': verifyConsistencyCommands,
  'wikidata-enrich': wikidataEnrichCommands,
  quality: dataQualityCommands,
  bluesky: blueskyCommands,
  races: politicalRacesCommands,
  political: politicalDataCommands,
  scorecards: scorecardsCommands,
  branches: branchesCommands,
  'deploy-tasks': deployTasksCommands,
  'agent-reset': agentResetCommands,
  'agent-end': agentEndCommands,
  cost: costCommands,
  benchmarks: benchmarksCommands,
  'usage-patterns': usagePatternsCommands,
  docs: docsCommands,
  linear: linearCommands,
  'flagship-curate': flagshipCurateCommands,
  'session-finalize': sessionFinalizeCommands,
  dispatch: dispatchCommands,
  audit: auditCommands,
  aiid: aiidCommands,
  'oecd-aim': oecdAimCommands,
  migrations: migrationsCommands,
};

const shortcutMap = buildShortcutMap();

// Fail fast if a domain key collides with a group name/shortcut
const collisions = checkGroupDomainCollisions(Object.keys(domains));
if (collisions.length > 0) {
  throw new Error(`Group/domain collision detected:\n  ${collisions.join('\n  ')}`);
}

/**
 * Parse raw CLI arguments into positionals, options, and flags.
 * Does NOT interpret domain/command — that's done by the router in main().
 */
function parseArgs() {
  const parsed = _parseCliArgs(process.argv.slice(2));
  const positional = parsed._positional;

  const options = {};
  const flags = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '_positional') continue;
    options[kebabToCamel(key)] = value;
    if (value === true) {
      flags.push(`--${key}`);
    } else {
      flags.push(`--${key}=${value}`);
    }
  }

  return { positional, options, flags };
}

/**
 * Show main help — organized by group
 */
function showHelp() {
  const B = '\x1b[1m';
  const D = '\x1b[2m';
  const R = '\x1b[0m';

  console.log(`
${B}Crux Project CLI${R}

${B}Usage:${R}
  crux <group> <domain> <command> [options]   ${D}# Grouped${R}
  crux <group> <command> [options]             ${D}# Flattened (for common commands)${R}
  crux <domain> <command> [options]            ${D}# Legacy flat (still works)${R}

${B}Groups:${R}
  ${B}w${R}   ${D}(wiki)${R}       Wiki content — validate, fix, improve, citations, generate, ...
  ${B}fb${R}  ${D}(factbase)${R}   FactBase — structured facts with temporal data & provenance
  ${B}tb${R}  ${D}(tablebase)${R}  TableBase — PG entities, people, orgs, grants, imports, ...
  ${B}gh${R}               GitHub — issues, PRs, CI, epics, releases
  ${B}sys${R} ${D}(system)${R}     System — agents, jobs, sessions, health, audits, wiki-server

${B}Cross-cutting (top-level):${R}
  query       Query wiki-server DB (search, entity, facts, related, risk, stats)
  context     Assemble research bundles (for-page, for-issue, for-entity, for-topic)

${B}Examples:${R}
  crux w validate gate --fix          ${D}# Wiki validation gate${R}
  crux w improve far-ai --tier=deep   ${D}# Improve a wiki page${R}
  crux w fix escaping                 ${D}# Fix dollar sign escaping${R}
  crux fb show anthropic              ${D}# Show FactBase entity${R}
  crux tb people discover             ${D}# Discover people${R}
  crux tb ids allocate my-slug        ${D}# Allocate entity ID${R}
  crux gh issues start 42             ${D}# Start working on issue #42${R}
  crux linear start QUA-184           ${D}# Start a Linear issue (agent-session tracking)${R}
  crux linear done QUA-184 --pr=URL   ${D}# Close out a Linear issue${R}
  crux sys health check               ${D}# System health check${R}
  crux query search "topic"           ${D}# Full-text search${R}

  ${D}# Legacy flat syntax (still works):${R}
  crux validate gate --fix
  crux content improve far-ai

${B}Group Help:${R}
  crux <group> --help                 ${D}# e.g. crux w --help${R}

${B}Domain Help:${R}
  crux <domain> --help                ${D}# e.g. crux validate --help${R}

${B}Global Options:${R}
  --ci        JSON output for CI pipelines
  --help      Show help
`);
}

/**
 * Show help for a specific group
 */
function showGroupHelp(groupName) {
  const group = GROUPS[groupName];
  if (!group) return;

  const B = '\x1b[1m';
  const D = '\x1b[2m';
  const R = '\x1b[0m';

  const prefix = group.shortcut === groupName ? groupName : `${group.shortcut} (${groupName})`;

  let output = `\n${B}crux ${prefix}${R} — ${group.description}\n\n`;
  output += `${B}Usage:${R}\n`;
  output += `  crux ${group.shortcut} <domain> <command> [options]\n`;

  // Show flattened commands if any
  if (group.flattened?.length > 0) {
    output += `  crux ${group.shortcut} <command> [options]             ${D}# For commands from: ${group.flattened.join(', ')}${R}\n`;
  }
  output += '\n';

  // List domains in this group with their descriptions
  output += `${B}Domains:${R}\n`;
  const maxLen = Math.max(...group.domains.map(d => d.length));
  for (const domainName of group.domains) {
    const handler = domains[domainName];
    // Try to extract a one-liner from getHelp or fall back to the domain name
    let desc = '';
    if (handler?.getHelp) {
      const helpText = handler.getHelp();
      // Extract first meaningful line from help text
      const lines = helpText.split('\n').filter(l => l.trim() && !l.startsWith('Usage') && !l.startsWith('crux'));
      if (lines[0]) desc = lines[0].trim().replace(/^#+\s*/, '').replace(/^\*\*.*?\*\*\s*[-–—]\s*/, '');
    }
    output += `  ${domainName.padEnd(maxLen + 2)}${desc ? D + desc + R : ''}\n`;
  }

  // Show flattened commands
  if (group.flattened?.length > 0) {
    output += `\n${B}Shorthand commands${R} ${D}(from ${group.flattened.join(', ')}):${R}\n`;
    for (const flatDomain of group.flattened) {
      const handler = domains[flatDomain];
      if (handler?.commands) {
        for (const cmd of Object.keys(handler.commands)) {
          if (cmd === 'default') continue;
          output += `  crux ${group.shortcut} ${cmd}\n`;
        }
      }
    }
  }

  output += `\n${B}Domain help:${R}  crux ${group.shortcut} <domain> --help\n`;
  console.log(output);
}

/** Adapter: check if a domain has a specific command (used by group routing) */
function domainHasCommand(domainName, commandName) {
  return !!domains[domainName]?.commands?.[commandName];
}

/**
 * Main entry point
 */
async function main() {
  const { positional, options, flags } = parseArgs();
  const log = createLogger(options.ci);

  // Show help if no args
  if (positional.length === 0 && options.help) {
    showHelp();
    process.exit(0);
  }
  if (positional.length === 0) {
    showHelp();
    process.exit(1);
  }

  // --- Group routing ---
  const groupResult = resolveGroupRouting(positional, shortcutMap, domainHasCommand);

  let domain, command, args;

  if (groupResult) {
    // Group was matched
    const { groupName, unknownArg } = groupResult;

    // Group help: crux w --help
    if (!groupResult.domain && options.help) {
      showGroupHelp(groupName);
      process.exit(0);
    }

    // No domain resolved
    if (!groupResult.domain) {
      if (unknownArg) {
        const group = GROUPS[groupName];
        log.error(`Unknown domain or command in group '${groupName}': ${unknownArg}`);
        log.dim(`Available domains: ${group.domains.join(', ')}`);
        if (group.flattened) {
          for (const flatDomain of group.flattened) {
            const handler = domains[flatDomain];
            if (handler?.commands) {
              log.dim(`Shorthand commands: ${Object.keys(handler.commands).filter(c => c !== 'default').join(', ')}`);
            }
          }
        }
      } else {
        showGroupHelp(groupName);
      }
      process.exit(1);
    }

    domain = groupResult.domain;
    command = groupResult.command;
    args = [...positional.slice(groupResult.argsStart), ...flags];
  } else {
    // --- Legacy flat routing ---
    domain = positional[0];
    command = positional[1] || null;
    args = [...positional.slice(2), ...flags];
  }

  // Resolve domain handler
  const domainHandler = domains[domain];
  if (!domainHandler) {
    log.error(`Unknown domain: ${domain}`);
    log.dim(`Available domains: ${Object.keys(domains).join(', ')}`);
    log.dim(`Or use a group prefix: w, fb, tb, gh, sys`);
    process.exit(1);
  }

  // Show domain help if requested
  if (options.help) {
    if (domainHandler.getHelp) {
      console.log(domainHandler.getHelp());
    } else {
      console.log(`No help available for domain: ${domain}`);
    }
    process.exit(0);
  }

  // Determine which command to run
  let commandName = command;
  let commandHandler;

  if (commandName) {
    commandHandler = domainHandler.commands?.[commandName];
    if (!commandHandler && domainHandler.commands?.default) {
      // Unrecognized command name — treat it as a positional arg for 'default'
      commandHandler = domainHandler.commands.default;
      args = [commandName, ...args];
      commandName = 'default';
    }
  } else {
    // No command specified - try 'default', then 'check'
    commandHandler = domainHandler.commands?.default || domainHandler.commands?.check;
    commandName = domainHandler.commands?.default ? 'default' : 'check';
  }

  if (!commandHandler) {
    log.error(`Unknown command: ${commandName}`);
    if (domainHandler.commands) {
      log.dim(`Available commands: ${Object.keys(domainHandler.commands).join(', ')}`);
    }
    process.exit(1);
  }

  // Publish the current crux command so client.ts can stamp
  // X-Agent-Tool on every wiki-server request (QUA-442). Set before
  // the audit-session-id priming so both headers are ready by the
  // time the command issues its first request.
  if (!process.env.CRUX_COMMAND) {
    process.env.CRUX_COMMAND = `${domain} ${commandName}`.trim();
  }

  // Prime the X-Agent-Session-Id cache (best-effort, never blocks on
  // errors). Fire-and-forget into a bounded promise; individual
  // commands that hit the server right away will await the same
  // promise via the internal cache guard.
  primeAuditSessionId().catch(() => {});

  // Run the command
  try {
    const result = await commandHandler(args, options);

    if (result.output) {
      console.log(result.output);
    }

    process.exit(result.exitCode || 0);
  } catch (err) {
    log.error(`Error: ${err.message}`);
    if (!options.ci) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
