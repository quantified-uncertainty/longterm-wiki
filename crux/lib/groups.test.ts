import { describe, it, expect } from 'vitest';
import { GROUPS, buildShortcutMap, buildDomainToGroupMap, checkGroupDomainCollisions, resolveGroupRouting } from './groups.ts';

describe('GROUPS', () => {
  it('every group has a shortcut', () => {
    for (const [name, def] of Object.entries(GROUPS)) {
      expect(def.shortcut, `group '${name}' missing shortcut`).toBeTruthy();
    }
  });

  it('shortcuts are unique', () => {
    const shortcuts = Object.values(GROUPS).map((g) => g.shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('no shortcut collides with a group full name', () => {
    const fullNames = new Set(Object.keys(GROUPS));
    for (const [name, def] of Object.entries(GROUPS)) {
      if (def.shortcut !== name) {
        expect(fullNames.has(def.shortcut), `shortcut '${def.shortcut}' collides with group name`).toBe(false);
      }
    }
  });

  it('no domain appears in more than one group', () => {
    const seen = new Map<string, string>();
    for (const [groupName, def] of Object.entries(GROUPS)) {
      for (const domain of def.domains) {
        const prev = seen.get(domain);
        expect(prev, `domain '${domain}' in both '${prev}' and '${groupName}'`).toBeUndefined();
        seen.set(domain, groupName);
      }
    }
  });

  it('flattened domains are a subset of group domains', () => {
    for (const [name, def] of Object.entries(GROUPS)) {
      for (const flat of def.flattened ?? []) {
        expect(def.domains, `flattened '${flat}' not in group '${name}' domains`).toContain(flat);
      }
    }
  });

  it('every group has at least one domain', () => {
    for (const [name, def] of Object.entries(GROUPS)) {
      expect(def.domains.length, `group '${name}' has empty domains`).toBeGreaterThan(0);
    }
  });
});

describe('buildShortcutMap', () => {
  const map = buildShortcutMap();

  it('maps shortcuts to group names', () => {
    expect(map['w']).toBe('wiki');
    expect(map['fb']).toBe('factbase');
    expect(map['tb']).toBe('tablebase');
    expect(map['gh']).toBe('gh');
    expect(map['sys']).toBe('system');
  });

  it('maps full names to group names', () => {
    expect(map['wiki']).toBe('wiki');
    expect(map['factbase']).toBe('factbase');
    expect(map['tablebase']).toBe('tablebase');
    expect(map['system']).toBe('system');
  });
});

describe('buildDomainToGroupMap', () => {
  const map = buildDomainToGroupMap();

  it('maps wiki domains correctly', () => {
    expect(map['content']).toBe('wiki');
    expect(map['fix']).toBe('wiki');
    expect(map['validate']).toBe('wiki');
    expect(map['citations']).toBe('wiki');
  });

  it('maps factbase domains correctly', () => {
    expect(map['factbase']).toBe('factbase');
  });

  it('maps tablebase domains correctly', () => {
    expect(map['tablebase']).toBe('tablebase');
    expect(map['people']).toBe('tablebase');
    expect(map['ids']).toBe('tablebase');
  });

  it('maps gh domains correctly', () => {
    expect(map['issues']).toBe('gh');
    expect(map['pr']).toBe('gh');
    expect(map['ci']).toBe('gh');
  });

  it('maps system domains correctly', () => {
    expect(map['agents']).toBe('system');
    expect(map['health']).toBe('system');
    expect(map['jobs']).toBe('system');
  });

  it('does not include cross-cutting domains', () => {
    expect(map['query']).toBeUndefined();
    expect(map['context']).toBeUndefined();
  });
});

describe('checkGroupDomainCollisions', () => {
  it('returns empty for safe domain keys', () => {
    expect(checkGroupDomainCollisions(['validate', 'content', 'fix'])).toEqual([]);
  });

  it('allows domain keys that match their own group name', () => {
    // 'factbase' domain is inside the 'factbase' group — safe
    expect(checkGroupDomainCollisions(['factbase', 'tablebase', 'validate'])).toEqual([]);
  });

  it('detects collision with shortcut from outside the group', () => {
    // 'w' is not a domain inside the wiki group — dangerous
    const result = checkGroupDomainCollisions(['validate', 'w']);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("'w'");
  });

  it('detects collision with group name from outside the group', () => {
    // A hypothetical 'wiki' domain that is NOT in the wiki group
    const result = checkGroupDomainCollisions(['wiki']);
    expect(result.length).toBe(1);
    expect(result[0]).toContain('wiki');
  });

  it('detects multiple collisions', () => {
    const result = checkGroupDomainCollisions(['w', 'fb', 'validate']);
    expect(result.length).toBe(2);
  });
});

describe('resolveGroupRouting', () => {
  const shortcuts = buildShortcutMap();
  // Mock: content has 'improve' and 'create'; factbase has 'show' and 'list'
  const mockHasCommand = (domain: string, cmd: string) => {
    const cmds: Record<string, string[]> = {
      content: ['improve', 'create', 'grade'],
      factbase: ['show', 'list', 'source-check'],
      tablebase: ['scan', 'gaps', 'backfill-grantee-ids'],
      issues: ['search', 'start', 'done'],
    };
    return cmds[domain]?.includes(cmd) ?? false;
  };

  it('returns null for non-group first arg', () => {
    expect(resolveGroupRouting(['validate', 'gate'], shortcuts, mockHasCommand)).toBeNull();
    expect(resolveGroupRouting(['query', 'search'], shortcuts, mockHasCommand)).toBeNull();
  });

  it('routes group + domain + command', () => {
    const r = resolveGroupRouting(['w', 'validate', 'gate'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'wiki', domain: 'validate', command: 'gate', argsStart: 3 });
  });

  it('routes group + domain (no command)', () => {
    const r = resolveGroupRouting(['w', 'validate'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'wiki', domain: 'validate', command: null, argsStart: 3 });
  });

  it('routes flattened command', () => {
    const r = resolveGroupRouting(['w', 'improve', 'far-ai'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'wiki', domain: 'content', command: 'improve', argsStart: 2 });
  });

  it('routes shortcut + flattened', () => {
    const r = resolveGroupRouting(['fb', 'show', 'anthropic'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'factbase', domain: 'factbase', command: 'show', argsStart: 2 });
  });

  it('routes full group name', () => {
    const r = resolveGroupRouting(['wiki', 'fix', 'escaping'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'wiki', domain: 'fix', command: 'escaping', argsStart: 3 });
  });

  it('explicit domain wins over flattened command', () => {
    // 'content' is both a domain in wiki AND could be a flattened command name
    // Domain should take priority
    const r = resolveGroupRouting(['w', 'content', 'improve'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'wiki', domain: 'content', command: 'improve', argsStart: 3 });
  });

  it('returns group help for bare group', () => {
    const r = resolveGroupRouting(['w'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'wiki', domain: null, command: null, argsStart: 1 });
  });

  it('returns group help for group + flag', () => {
    const r = resolveGroupRouting(['w', '--help'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'wiki', domain: null, command: null, argsStart: 1 });
  });

  it('returns unknownArg for unrecognized subdomain', () => {
    const r = resolveGroupRouting(['w', 'bogus'], shortcuts, mockHasCommand);
    expect(r?.unknownArg).toBe('bogus');
    expect(r?.domain).toBeNull();
  });

  it('handles factbase group name collision correctly', () => {
    // 'factbase' is both a group name and a domain within that group
    const r = resolveGroupRouting(['factbase', 'show', 'anthropic'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'factbase', domain: 'factbase', command: 'show', argsStart: 2 });
  });

  it('routes tb + consolidated command', () => {
    const r = resolveGroupRouting(['tb', 'backfill-grantee-ids'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'tablebase', domain: 'tablebase', command: 'backfill-grantee-ids', argsStart: 2 });
  });

  it('routes gh + explicit domain', () => {
    const r = resolveGroupRouting(['gh', 'pr', 'create'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'gh', domain: 'pr', command: 'create', argsStart: 3 });
  });

  it('routes gh + flattened issues command', () => {
    const r = resolveGroupRouting(['gh', 'search', 'topic'], shortcuts, mockHasCommand);
    expect(r).toEqual({ groupName: 'gh', domain: 'issues', command: 'search', argsStart: 2 });
  });
});
