import { describe, it, expect } from 'vitest';
import { GROUPS, buildShortcutMap, buildDomainToGroupMap, checkGroupDomainCollisions } from './groups.ts';

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
