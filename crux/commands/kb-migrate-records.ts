/**
 * KB Records Migration — YAML → PG
 *
 * This command has been removed. Record infrastructure was stripped from the KB
 * package. Records data now lives in PostgreSQL and is managed directly by the
 * wiki-server.
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
    exitCode: 1,
    output: 'Records infrastructure has been removed from the KB package.\nRecords data now lives in PostgreSQL and is managed directly by the wiki-server.',
  };
}
