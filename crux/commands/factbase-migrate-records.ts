/**
 * KB Records Migration — YAML → PG (DEPRECATED)
 *
 * This command was used to migrate record data from YAML files to PostgreSQL.
 * The migration is complete — records are now served exclusively from PG.
 * Record-handling code has been removed from the KB/FactBase package.
 *
 * This file is kept as a stub to avoid breaking the command registry.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

interface MigrateOptions extends BaseOptions {
  dryRun?: boolean;
  'dry-run'?: boolean;
}

export async function run(
  _args: string[],
  _options: MigrateOptions,
): Promise<CommandResult> {
  return {
    exitCode: 0,
    output: [
      'KB Records Migration — DEPRECATED',
      '',
      'The YAML → PG record migration is complete. All record data (grants,',
      'funding rounds, investments, equity positions, personnel, divisions,',
      'funding programs) is now served exclusively from PostgreSQL.',
      '',
      'Record-handling code has been removed from the FactBase package.',
      'This command is no longer functional.',
    ].join('\n'),
  };
}
