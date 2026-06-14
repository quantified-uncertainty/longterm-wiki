/**
 * Command Group Definitions
 *
 * Groups organize the flat domain namespace into discoverable categories
 * based on which data layer they operate on.
 *
 * Each group has:
 *   - shortcut: short prefix (e.g. 'w' for wiki)
 *   - domains: mapping of domain names to their keys in the flat domains object
 *   - flattened: domains whose commands are promoted to group level
 *     (e.g. `crux w improve X` dispatches to content.improve)
 *   - description: shown in help output
 */

export interface GroupDef {
  shortcut: string;
  description: string;
  /** Domain names that belong to this group (key = domain name used in CLI) */
  domains: string[];
  /**
   * Domains whose commands are promoted to the group level.
   * For example, if 'content' is flattened into 'wiki', then
   * `crux w improve X` resolves to content.commands.improve(X).
   * Priority: explicit domain name > flattened command name.
   */
  flattened?: string[];
}

export const GROUPS: Record<string, GroupDef> = {
  wiki: {
    shortcut: 'w',
    description: 'Wiki content — MDX pages, validation, fixes, citations',
    domains: [
      'content',
      'fix',
      'validate',
      'citations',
      'footnotes',
      'generate',
      'visual',
      'enrich',
      'importance',
      'updates',
      'auto-update',
      'analyze',
      'pages',
      'resources',
      'check-links',
      'qa-sweep',
      'qa-checks',
      'evals',
      'research',
      'grokipedia',
      'auto-verify-stakeholders',
      'extract-structured-data',
      'verify-consistency',
      'sourcing-wiki-pages',
    ],
    flattened: ['content'],
  },
  factbase: {
    shortcut: 'fb',
    description: 'FactBase — structured facts with temporal data & provenance',
    domains: [
      'factbase',
      'wikidata-enrich',
      'import-990',
    ],
    flattened: ['factbase'],
  },
  tablebase: {
    shortcut: 'tb',
    description: 'TableBase — PG entities, people, orgs, grants, imports',
    domains: [
      'tablebase',
      'matrix',
      'entity',
      'ids',
      'people',
      'orgs',
      'research-areas',
      'verify',
      'verify-orchestrate',
      'sourcing-recheck',
      'sourcing-retro-scan-subjects',
      'sourcing-cleanup-orphans',
      'migrate-citations',
      'legislation',
      'bluesky',
      'races',
      'political',
      'benchmarks',
      'flagship-curate',
      // Domains with multiple subcommands — list them so `tb <domain> <sub>`
      // dispatches to the subcommand rather than the domain default. Flat
      // dash-form aliases (`import-divisions-sync`, etc.) still resolve via
      // the flattened path.
      'import-grants',
      'import-scorecards',
      'import-divisions',
      'import-funding-programs',
      'data-sources',
      'website-sources',
      'improve-entity',
      'improve-entity-suite',
      'benchmark',
      'benchmark-suite',
      'pipeline-regression-check',
    ],
    flattened: ['tablebase'],
  },
  gh: {
    shortcut: 'gh',
    description: 'GitHub — issues, PRs, CI, epics, releases',
    domains: [
      'issues',
      'pr',
      'ci',
      'epic',
      'release',
      'review',
      'pr-patrol',
      'branches',
      'deploy-tasks',
    ],
    flattened: ['issues'],
  },
  system: {
    shortcut: 'sys',
    description: 'System — agents, jobs, sessions, health, audits',
    domains: [
      'agents',
      'agent-checklist',
      'agent-session-events',
      'review-phase',
      'jobs',
      'sessions',
      'edit-log',
      'health',
      'health-monitor',
      'audits',
      'maintain',
      'wiki-server',
      'quality',
      'agent-reset',
      'agent-end',
      'cost',
      'usage-patterns',
      'session-finalize',
      'docs',
      'dispatch',
    ],
  },
  linear: {
    shortcut: 'linear',
    description: 'Linear — issues, workflow states, agent session tracking',
    domains: ['linear'],
    flattened: ['linear'],
  },
  ws: {
    shortcut: 'ws',
    description: 'Workspace — agent slots, sentinels, tmux, doctors (lw/ root)',
    domains: ['agent-workspace'],
    flattened: ['agent-workspace'],
  },
};

/** Build a lookup from shortcut → group name (e.g. 'w' → 'wiki') */
export function buildShortcutMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, def] of Object.entries(GROUPS)) {
    map[def.shortcut] = name;
    map[name] = name; // full name also works
  }
  return map;
}

/** Build a lookup from domain name → group name */
export function buildDomainToGroupMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [groupName, def] of Object.entries(GROUPS)) {
    for (const domain of def.domains) {
      map[domain] = groupName;
    }
  }
  return map;
}

/**
 * Validate that no domain key unsafely collides with a group name/shortcut.
 *
 * Safe collision: a domain key matching its own group's full name (e.g. the
 * 'factbase' domain in the 'factbase' group). Group routing handles this
 * correctly because flattened lookup finds the domain's commands.
 *
 * Unsafe collision: a domain key matching a shortcut it doesn't belong to
 * (e.g. a domain called 'w' would shadow the wiki group shortcut).
 */
export interface GroupRouteResult {
  groupName: string;
  domain: string | null;
  command: string | null;
  argsStart: number;
  unknownArg?: string;
}

/**
 * Resolve group routing from positional args.
 *
 * @param positional - Raw positional args from the CLI
 * @param shortcutMap - Map from group name/shortcut → group name
 * @param domainHasCommand - Callback to check if a domain has a specific command
 *   (decouples routing from the actual domains object)
 * @returns Routing result or null if p0 is not a group
 */
export function resolveGroupRouting(
  positional: string[],
  shortcutMap: Record<string, string>,
  domainHasCommand: (domain: string, command: string) => boolean,
): GroupRouteResult | null {
  const p0 = positional[0];
  const p1 = positional[1];
  const p2 = positional[2];

  if (!p0 || !shortcutMap[p0]) return null;

  const groupName = shortcutMap[p0];
  const group = GROUPS[groupName];

  // crux w --help (no p1 or p1 is a flag)
  if (!p1 || p1.startsWith('-')) {
    return { groupName, domain: null, command: null, argsStart: 1 };
  }

  // Check if p1 is a known domain in this group
  if (group.domains.includes(p1)) {
    return { groupName, domain: p1, command: p2 || null, argsStart: 3 };
  }

  // Check flattened domains: p1 might be a command name in a flattened domain
  if (group.flattened) {
    for (const flatDomain of group.flattened) {
      if (domainHasCommand(flatDomain, p1)) {
        return { groupName, domain: flatDomain, command: p1, argsStart: 2 };
      }
    }
  }

  // p1 is not a recognized domain or flattened command in this group
  return { groupName, domain: null, command: null, argsStart: 1, unknownArg: p1 };
}

export function checkGroupDomainCollisions(domainKeys: string[]): string[] {
  const shortcutMap = buildShortcutMap();
  const domainToGroup = buildDomainToGroupMap();
  const collisions: string[] = [];
  for (const key of domainKeys) {
    const matchedGroup = shortcutMap[key];
    if (!matchedGroup) continue;

    // Safe: domain is inside the group it matches (e.g. 'factbase' domain in 'factbase' group)
    if (domainToGroup[key] === matchedGroup) continue;

    collisions.push(`domain '${key}' collides with group '${matchedGroup}' (name or shortcut)`);
  }
  return collisions;
}
