/**
 * IDs Command Handlers
 *
 * Allocate and query numeric entity IDs from the wiki-server.
 *
 * Usage:
 *   crux ids allocate <slug> [--description="..."]   Allocate a numeric ID
 *   crux ids check <slug>                            Check if a slug has an ID
 *   crux ids list [--limit=50] [--offset=0]          List all allocated IDs
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  allocateId,
  getIdBySlug,
  listIds,
  isConfigured as isIdServerConfigured,
} from '../lib/wiki-server/ids.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';

interface CommandOptions extends BaseOptions {
  description?: string;
  limit?: string;
  offset?: string;
  ci?: boolean;
}

// ---------------------------------------------------------------------------
// allocate command
// ---------------------------------------------------------------------------

async function allocateCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const slug = args.find(a => !a.startsWith('--'));

  if (!slug) {
    return {
      exitCode: 1,
      output: `Usage: crux ids allocate <slug> [--description="..."]

  Allocate a numeric ID (E##) for the given slug from the wiki-server.
  Idempotent: returns existing ID if slug is already registered.

Examples:
  crux ids allocate anthropic
  crux ids allocate new-entity --description="A new entity"`,
    };
  }

  if (!isIdServerConfigured()) {
    return { exitCode: 1, output: 'Error: LONGTERMWIKI_SERVER_URL not configured' };
  }

  const available = await isServerAvailable();
  if (!available) {
    return { exitCode: 1, output: 'Error: Wiki server is not reachable' };
  }

  const result = await allocateId(slug, options.description);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  const { numericId, stableId, created, createdAt } = result.data;
  const verb = created ? 'Allocated new' : 'Found existing';

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data) };
  }

  const stableIdLine = stableId ? `\n  Stable ID: ${stableId}` : '';
  return {
    exitCode: 0,
    output: `${verb} ID: ${numericId} → ${slug}${stableIdLine}\n  Created: ${createdAt}`,
  };
}

// ---------------------------------------------------------------------------
// check command
// ---------------------------------------------------------------------------

async function checkCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const slug = args.find(a => !a.startsWith('--'));

  if (!slug) {
    return {
      exitCode: 1,
      output: `Usage: crux ids check <slug>

  Check if a slug has a numeric ID allocated on the server.

Examples:
  crux ids check anthropic
  crux ids check nonexistent-entity`,
    };
  }

  if (!isIdServerConfigured()) {
    return { exitCode: 1, output: 'Error: LONGTERMWIKI_SERVER_URL not configured' };
  }

  const result = await getIdBySlug(slug);

  if (!result.ok) {
    if (result.error === 'bad_request') {
      return { exitCode: 1, output: `No ID found for slug: ${slug}` };
    }
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data) };
  }

  const stableIdLine = result.data.stableId ? `\n  Stable ID: ${result.data.stableId}` : '';
  return {
    exitCode: 0,
    output: `${result.data.numericId} → ${slug}${stableIdLine}\n  Created: ${result.data.createdAt}`,
  };
}

// ---------------------------------------------------------------------------
// list command
// ---------------------------------------------------------------------------

async function listCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  if (!isIdServerConfigured()) {
    return { exitCode: 1, output: 'Error: LONGTERMWIKI_SERVER_URL not configured' };
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 50;
  const offset = options.offset ? parseInt(options.offset, 10) : 0;

  const result = await listIds(limit, offset);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data) };
  }

  const { ids, total } = result.data;
  const lines = [
    `Entity IDs (${offset + 1}–${offset + ids.length} of ${total}):`,
    '',
  ];

  for (const entry of ids) {
    const stableId = entry.stableId ?? '—';
    lines.push(`  ${entry.numericId.padEnd(8)} ${stableId.padEnd(12)} ${entry.slug}`);
  }

  if (offset + ids.length < total) {
    lines.push('');
    lines.push(`  ... use --offset=${offset + limit} to see more`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  allocate: allocateCommand,
  check: checkCommand,
  list: listCommand,
};

export function getHelp(): string {
  return `
IDs Domain — Entity ID allocation and lookup

Commands:
  allocate <slug>   Allocate a numeric ID (E##) for a slug from the wiki-server
  check <slug>      Check if a slug has an ID allocated
  list              List all allocated IDs

Options:
  --description="..."   Description when allocating (allocate only)
  --limit=N             Number of results (list only, default: 50)
  --offset=N            Pagination offset (list only, default: 0)
  --ci                  JSON output

Why use this:
  Entity numeric IDs (E42, E886, etc.) are allocated by the wiki-server
  using a PostgreSQL sequence to guarantee uniqueness. Never manually
  invent an ID — always allocate from the server. This prevents ID
  conflicts when multiple agents work concurrently.

  The validate gate also runs assign-ids.mjs automatically, but
  allocating early is better: it prevents the window where two agents
  might both create entities without IDs and get conflicting assignments.

Examples:
  crux ids allocate anthropic                    # Get or create ID
  crux ids allocate new-org --description="..."  # With description
  crux ids check anthropic                       # Look up existing ID
  crux ids list --limit=100                      # Browse all IDs
`;
}
