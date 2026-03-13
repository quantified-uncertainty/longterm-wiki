/**
 * People Command Handlers — Dispatcher
 *
 * CLI tools for managing person entity data. This file delegates to
 * focused subcommand modules in `./people/`.
 *
 * Usage:
 *   crux people discover [--min-appearances=N] [--json]
 *   crux people create [--min-appearances=N]
 *   crux people link-resources [--apply] [--verbose]   Match resources/literature to person entities
 *   crux people enrich --source=wikidata --dry-run              Preview all enrichment
 *   crux people enrich --source=wikidata --apply                Write new facts to YAML
 *   crux people enrich --source=wikidata --entity=dario-amodei  Single entity
 *   crux people enrich --source=wikidata --dry-run --ci         JSON output
 *   crux people import-key-persons [--sync] [--dry-run] [--verbose]   Sync key-persons from YAML to PG
 *   crux people suggest-links [--apply] [--verbose]   Detect unlinked person mentions in MDX pages
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { discoverCommand } from './people/discover.ts';
import { createCommand } from './people/create.ts';
import { linkResourcesCommand } from './people/link-resources.ts';
import { enrichCommand } from './people/enrich.ts';
import { importKeyPersonsCommand } from './people/import-key-persons.ts';
import { suggestLinksCommand } from './people/suggest-links.ts';

// Re-export shared utilities that other files import from this module
export { normalizeName, buildAuthorLookup, matchAuthor } from './people/shared.ts';

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

export const commands: Record<
  string,
  (args: string[], options: BaseOptions) => Promise<CommandResult>
> = {
  discover: discoverCommand,
  create: createCommand,
  'link-resources': linkResourcesCommand,
  enrich: enrichCommand,
  'import-key-persons': importKeyPersonsCommand,
  'suggest-links': suggestLinksCommand,
  default: discoverCommand,
};

export function getHelp(): string {
  return `
\x1b[1mPeople\x1b[0m — Person entity discovery and data tools

\x1b[1mCommands:\x1b[0m
  discover             Find people across data sources who are not in people.yaml (default)
  create               Generate YAML entity stubs for discovered candidates
  link-resources       Match literature papers to person entities by author name
  enrich               Enrich person KB entities with data from external sources
  import-key-persons   Extract key-persons from KB YAML and sync to PG
  suggest-links        Detect unlinked person mentions in MDX pages

\x1b[1mDiscover/Create Options:\x1b[0m
  --min-appearances=N   Only show people in N+ data sources (default: 1 for discover, 2 for create)
  --json                JSON output
  --ci                  JSON output (alias for --json)

\x1b[1mLink-Resources Options:\x1b[0m
  --apply          Write results to data/people-resources.yaml
  --verbose        Show detailed output including unmatched authors

\x1b[1mEnrich Options:\x1b[0m
  --source=wikidata     Data source (currently only wikidata is supported)
  --dry-run             Preview what would be added without writing
  --apply               Actually write new facts to YAML files
  --entity=<slug>       Process a single entity (for testing)
  --limit=N             Limit number of entities to process
  --ci                  JSON output

\x1b[1mData Sources Scanned (discover):\x1b[0m
  1. data/experts.yaml — expert entries not in people.yaml
  2. data/organizations.yaml — keyPeople references
  3. data/entities/*.yaml — relatedEntries with type: person
  4. packages/kb/data/things/ — KB things with type: person
  5. data/literature.yaml — paper authors

\x1b[1mScoring:\x1b[0m
  expert = 5pts, kb-thing = 4pts, org-keyPeople = 4pts,
  entity-relatedEntries = 3pts, literature-author = 2pts

\x1b[1mEnrich Details:\x1b[0m
  Only adds facts that don't already exist — never overwrites.
  Requires high-confidence Wikidata matching (name + description relevance check).
  Currently extracts: born-year (P569), education (P69)

\x1b[1mOptions (import-key-persons):\x1b[0m
  --sync           Actually sync to wiki-server PG
  --dry-run        Preview sync without writing
  --verbose        Show per-org details

\x1b[1mExamples:\x1b[0m
  crux people discover                     # List all candidates
  crux people discover --min-appearances=2 # Only people in 2+ sources
  crux people discover --json              # JSON output
  crux people create                       # Generate YAML stubs (min 2 appearances)
  crux people create --min-appearances=1   # Include single-mention candidates
  crux people link-resources               # Preview matches (dry run)
  crux people link-resources --apply       # Generate people-resources.yaml
  crux people link-resources --verbose     # Show all match details
  crux people enrich --source=wikidata --dry-run
  crux people enrich --source=wikidata --apply
  crux people enrich --source=wikidata --entity=dario-amodei --dry-run
  crux people import-key-persons              # Preview extracted key-persons
  crux people import-key-persons --verbose    # Show per-org details
  crux people import-key-persons --sync       # Sync to wiki-server PG
  crux people import-key-persons --sync --dry-run   # Preview sync (no writes)
  crux people suggest-links                  # Preview unlinked person mentions
  crux people suggest-links --verbose        # Show all mentions (linked and unlinked)
  crux people suggest-links --apply          # Wrap first occurrence in EntityLink

\x1b[1mSuggest-Links Options:\x1b[0m
  --apply          Wrap the first unlinked occurrence of each person in EntityLink
  --verbose        Show all mentions including already-linked ones
`;
}
