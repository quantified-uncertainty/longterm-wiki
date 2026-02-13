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
 *   resources   External resource management
 *   insights    Insight quality management
 *   gaps        Insight gap analysis
 *   updates     Schedule-aware page update system
 *   edit-log    View and query per-page edit history
 *
 * Global Options:
 *   --ci        JSON output for CI pipelines
 *   --help      Show help
 *
 * Examples:
 *   crux validate                            Run all validation checks
 *   crux validate compile --quick            Quick MDX compilation check
 *   crux validate unified --rules=dollars    Run specific rules
 *   crux insights check                      Check insight quality
 *   crux gaps list                           Find pages needing insights
 */

import { parseArgs } from 'node:util';
import { createLogger } from './lib/output.ts';

// Domain handlers
import * as validateCommands from './commands/validate.ts';
import * as analyzeCommands from './commands/analyze.ts';
import * as fixCommands from './commands/fix.ts';
import * as contentCommands from './commands/content.ts';
import * as generateCommands from './commands/generate.ts';
import * as resourcesCommands from './commands/resources.ts';
import * as insightsCommands from './commands/insights.ts';
import * as gapsCommands from './commands/gaps.ts';
import * as updatesCommands from './commands/updates.ts';
import * as editLogCommands from './commands/edit-log.ts';

const domains = {
  validate: validateCommands,
  analyze: analyzeCommands,
  fix: fixCommands,
  content: contentCommands,
  generate: generateCommands,
  resources: resourcesCommands,
  insights: insightsCommands,
  gaps: gapsCommands,
  updates: updatesCommands,
  'edit-log': editLogCommands,
};

/**
 * Parse command-line arguments
 */
function parseCliArgs() {
  const args = process.argv.slice(2);

  // Extract domain and command
  let domain = null;
  let command = null;
  const remaining = [];

  for (const arg of args) {
    if (!arg.startsWith('-')) {
      if (!domain) {
        domain = arg;
      } else if (!command) {
        command = arg;
      } else {
        remaining.push(arg);
      }
    } else {
      remaining.push(arg);
    }
  }

  // Parse options from remaining args
  const options = {};
  for (const arg of remaining) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      // Convert kebab-case to camelCase
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      options[camelKey] = value === undefined ? true : value;
    }
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
  resources   External resource management
  insights    Insight quality management
  gaps        Insight gap analysis
  updates     Schedule-aware page update system
  edit-log    View and query per-page edit history

${'\x1b[1m'}Global Options:${'\x1b[0m'}
  --ci        JSON output for CI pipelines
  --help      Show help

${'\x1b[1m'}Examples:${'\x1b[0m'}
  crux validate                       Run all validation checks
  crux validate compile --quick       Quick MDX compilation check
  crux validate unified --fix         Auto-fix unified rule issues
  crux insights check                 Check insight quality
  crux gaps list --limit=10           Find pages needing insights

${'\x1b[1m'}Domain Help:${'\x1b[0m'}
  crux <domain> --help
`);
}

/**
 * Main entry point
 */
async function main() {
  const { domain, command, args, options } = parseCliArgs();
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
