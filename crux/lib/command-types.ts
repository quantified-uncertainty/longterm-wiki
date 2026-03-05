/**
 * Shared type for CLI command option bags.
 *
 * All command handlers receive options as a string-keyed record.
 * Command files can extend this with command-specific typed properties.
 *
 * @example
 *   interface MyCommandOptions extends CommandOptions {
 *     tier?: string;
 *     dryRun?: boolean;
 *   }
 */
export type CommandOptions = Record<string, unknown>;

// Re-export CommandResult from cli.ts for co-location
export type { CommandResult } from './cli.ts';
