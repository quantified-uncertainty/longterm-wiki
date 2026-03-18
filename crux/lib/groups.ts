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
      'evals',
      'research',
      'grokipedia',
    ],
    flattened: ['content'],
  },
  factbase: {
    shortcut: 'fb',
    description: 'FactBase — structured facts with temporal data & provenance',
    domains: [
      'factbase',
      'factbase-migrate-entities',
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
      'import-grants',
      'import-divisions',
      'import-funding-programs',
      'backfill-grantee-ids',
      'backfill-program-ids',
      'backfill-stable-ids',
      'backfill-yaml-stable-ids',
      'verify',
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
    ],
    flattened: ['issues'],
  },
  system: {
    shortcut: 'sys',
    description: 'System — agents, jobs, sessions, health, audits',
    domains: [
      'agents',
      'agent-checklist',
      'agent-workspace',
      'agent-session-events',
      'jobs',
      'sessions',
      'edit-log',
      'health',
      'audits',
      'maintain',
      'wiki-server',
    ],
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
