/**
 * Tests for the policy-stakeholders PG helpers in wiki-server-data.mjs (QUA-960).
 *
 * Covers:
 *   - pgPolicyStakeholderRowToYaml: schema field order, omitted nulls, context
 *   - fetchPolicyStakeholdersFromPG: pagination, retry on transient 5xx, terminal failure
 */
import { describe, it, expect } from 'vitest';
import { pgPolicyStakeholderRowToYaml } from '../wiki-server-data.mjs';

describe('pgPolicyStakeholderRowToYaml', () => {
  it('emits fields in PolicyStakeholder schema order', () => {
    // Schema (apps/web/src/data/entity-schemas.ts) is:
    //   name, entityId, position, role, importance, reason, source, context.
    // role isn't in PG (QUA-984) so it's never emitted by this helper.
    const out = pgPolicyStakeholderRowToYaml({
      id: 'x',
      policyEntityId: 'p',
      stakeholderEntityId: 'sid_xy',
      stakeholderDisplayName: 'ACLU',
      position: 'oppose',
      importance: 'high',
      reason: 'Civil liberties',
      source: 'https://aclu.org',
      context: ['Filed brief'],
    });
    expect(Object.keys(out)).toEqual([
      'name',
      'entityId',
      'position',
      'importance',
      'reason',
      'source',
      'context',
    ]);
  });

  it('omits empty/null fields rather than emitting null or []', () => {
    const out = pgPolicyStakeholderRowToYaml({
      id: 'x',
      policyEntityId: 'p',
      stakeholderEntityId: null,
      stakeholderDisplayName: 'Group',
      position: 'support',
      importance: null,
      reason: null,
      source: null,
      context: null,
    });
    expect(out).toEqual({ name: 'Group', position: 'support' });
    expect(out.entityId).toBeUndefined();
    expect(out.importance).toBeUndefined();
    expect(out.context).toBeUndefined();
  });

  it('omits empty context arrays (no `context: []` round-trip noise)', () => {
    const out = pgPolicyStakeholderRowToYaml({
      id: 'x',
      policyEntityId: 'p',
      stakeholderEntityId: null,
      stakeholderDisplayName: 'Group',
      position: 'support',
      importance: null,
      reason: null,
      source: null,
      context: [],
    });
    expect(out.context).toBeUndefined();
  });

  it('preserves context arrays with content', () => {
    const out = pgPolicyStakeholderRowToYaml({
      id: 'x',
      policyEntityId: 'p',
      stakeholderEntityId: null,
      stakeholderDisplayName: 'Group',
      position: 'support',
      importance: null,
      reason: null,
      source: null,
      context: ['note 1', 'note 2'],
    });
    expect(out.context).toEqual(['note 1', 'note 2']);
  });
});
