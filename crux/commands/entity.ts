/**
 * Entity Command Handlers
 *
 * Tools for managing entity IDs and references.
 *
 * Usage:
 *   crux entity rename <old-id> <new-id>           # Preview rename
 *   crux entity rename <old-id> <new-id> --apply   # Apply rename
 */

import type { CommandResult } from '../lib/cli.ts';
import { runRename } from '../entity/entity-rename.ts';

interface CommandOptions {
  apply?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  ci?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// rename command
// ---------------------------------------------------------------------------

async function renameCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const [oldId, newId] = positional;

  if (!oldId || !newId) {
    return {
      exitCode: 1,
      output: `Usage: crux entity rename <old-id> <new-id> [--apply] [--verbose]

  Safely renames entity IDs across all MDX and YAML files.
  Uses word-boundary matching so "E6" never matches "E64".

Options:
  --apply     Write changes to disk (default: dry-run preview)
  --verbose   Show each matching line and its replacement
  --dry-run   Alias for preview (default behaviour)

Examples:
  crux entity rename E6 ai-control           # Preview
  crux entity rename E6 ai-control --apply   # Apply
  crux entity rename old-slug new-slug --apply --verbose`,
    };
  }

  const apply = Boolean(options.apply) && !Boolean(options.dryRun);
  const verbose = Boolean(options.verbose);

  return runRename(oldId, newId, { apply, verbose });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  rename: renameCommand,
};

export function getHelp(): string {
  return `
Entity Domain — Entity ID management tools

Commands:
  rename <old-id> <new-id>   Safely rename an entity ID across all files

Options:
  --apply       Write changes to disk (default: dry-run preview)
  --verbose     Show each matching line and its replacement
  --dry-run     Preview mode (default)

Why "rename" instead of find-replace:
  Plain string replace of "E6" also matches "E64", "E60", etc.
  This command uses word-boundary regex (\\b) to match only exact IDs.

Examples:
  crux entity rename E6 ai-control              Preview changes
  crux entity rename E6 ai-control --apply      Apply changes
  crux entity rename old-slug new-slug --apply  Rename a slug
`;
}
