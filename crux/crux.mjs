#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Crux Project CLI
 *
 * Unified command-line interface for project tools.
 *
 * Usage:
 *   crux <domain> <command> [options]
 *   crux <domain> [options]          # Runs default command
 *
 * Domains:
 *   validate    Run validation checks
 *   analyze     Analysis & reporting
 *   fix         Auto-fix operations
 *   content     Page management (improve, create, grade)
 *   generate    Content generation (yaml, summaries, diagrams)
 *   visual      Diagram, chart & model pipeline (create, review, audit, improve)
 *   resources   External resource management
 *   updates     Schedule-aware page update system
 *   auto-update News-driven automatic wiki updates
 *   check-links External URL health checking
 *   edit-log    View and query per-page edit history
 *   importance  Ranking-based importance scoring
 *   ci          GitHub CI status and monitoring
 *   maintain    Periodic maintenance and housekeeping
 *   review      Human review tracking and status
 *   citations   Citation verification and archival
 *   issues      Track Claude Code work on GitHub issues
 *   agent-checklist  Manage agent checklists (init, check, verify, status, complete)
 *   facts       Propose new canonical facts from wiki page content
 *   entity      Entity ID management (rename with safe word-boundary matching)
 *
 * Global Options:
 *   --ci        JSON output for CI pipelines
 *   --help      Show help
 *
 * Examples:
 *   crux validate                            Run all validation checks
 *   crux validate compile --quick            Quick MDX compilation check
 *   crux validate unified --rules=dollars    Run specific rules
 */

import { createLogger } from './lib/output.ts';
import { parseCliArgs as _parseCliArgs, kebabToCamel } from './lib/cli.ts';

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
import * as factsCommands from './commands/facts.ts';
import * as entityCommands from './commands/entity.ts';

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
  facts: factsCommands,
  entity: entityCommands,
};

/**
 * Parse command-line arguments using the shared parseCliArgs from cli.ts.
 * Extracts domain (first positional) and command (second positional),
 * then converts remaining named options to camelCase.
 */
function parseArgs() {
  const parsed = _parseCliArgs(process.argv.slice(2));
  const positional = parsed._positional;

  const domain = positional[0] || null;
  const command = positional[1] || null;

  // Convert kebab-case option keys to camelCase and build remaining args
  const options = {};
  const remaining = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '_positional') continue;
    options[kebabToCamel(key)] = value;
    // Reconstruct the raw arg for passing to subcommands
    if (value === true) {
      remaining.push(`--${key}`);
    } else {
      remaining.push(`--${key}=${value}`);
    }
  }
  // Pass extra positional args (beyond domain + command) as remaining
  for (const arg of positional.slice(2)) {
    remaining.push(arg);
  }

  return { domain, command, args: remaining, options };
}

/**
 * Show main help
 */
function showHelp() {
  console.log(`
${'\x1b[1m'}Crux Project CLI${'\x1b[0m'}

Unified command-line interface for project tools.

${'\x1b[1m'}Usage:${'\x1b[0m'}
  crux <domain> <command> [options]
  crux <domain> [options]          # Runs default command

${'\x1b[1m'}Domains:${'\x1b[0m'}
  validate    Run validation checks
  analyze     Analysis & reporting
  fix         Auto-fix operations
  content     Page management (improve, create, grade)
  generate    Content generation (yaml, summaries, diagrams)
  visual      Diagram, chart & model pipeline
  resources   External resource management
  updates     Schedule-aware page update system
  auto-update News-driven automatic wiki updates
  check-links External URL health checking
  edit-log    View and query per-page edit history
  importance  Ranking-based importance scoring
  ci          GitHub CI status and monitoring
  maintain    Periodic maintenance and housekeeping
  review      Human review tracking and status
  citations   Citation verification and archival
  issues      Track Claude Code work on GitHub issues
  agent-checklist  Manage agent checklists
  entity      Entity ID management (safe rename)

${'\x1b[1m'}Global Options:${'\x1b[0m'}
  --ci        JSON output for CI pipelines
  --help      Show help

${'\x1b[1m'}Examples:${'\x1b[0m'}
  crux validate                       Run all validation checks
  crux validate compile --quick       Quick MDX compilation check
  crux validate unified --fix         Auto-fix unified rule issues

${'\x1b[1m'}Domain Help:${'\x1b[0m'}
  crux <domain> --help
`);
}

/**
 * Main entry point
 */
async function main() {
  const { domain, command, args, options } = parseArgs();
  const log = createLogger(options.ci);

  // Show help if requested or no domain specified
  if (options.help && !domain) {
    showHelp();
    process.exit(0);
  }

  if (!domain) {
    showHelp();
    process.exit(1);
  }

  // Check if domain exists
  const domainHandler = domains[domain];
  if (!domainHandler) {
    log.error(`Unknown domain: ${domain}`);
    log.dim(`Available domains: ${Object.keys(domains).join(', ')}`);
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
  // Use explicit command, or 'default' if defined, or fall back to 'check'
  let commandName = command;
  let commandHandler;

  if (commandName) {
    commandHandler = domainHandler.commands?.[commandName];
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