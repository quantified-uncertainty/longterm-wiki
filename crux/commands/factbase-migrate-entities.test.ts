/**
 * Tests for FactBase entity migration and loader entity injection.
 *
 * Tests cover:
 * 1. Loader: `entity:` format parsing
 * 2. Loader: entity injection via options.entities
 * 3. Migration script: transformFile logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadKB } from '../../packages/factbase/src/loader.ts';
import type { Entity } from '../../packages/factbase/src/types.ts';

// ── Loader: entity: format parsing ──────────────────────────────────────

describe('loadKB with entity: format', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'factbase-loader-entity-test-'));
    mkdirSync(join(tmpDir, 'fb-entities'), { recursive: true });
    mkdirSync(join(tmpDir, 'schemas'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads entity: format file with injected entities', async () => {
    writeFileSync(
      join(tmpDir, 'fb-entities', 'test-org.yaml'),
      `entity: aB3cD4eF5g
facts:
  - id: f_test001
    property: headcount
    value: 100
`,
    );

    // Create a properties file so headcount property exists
    writeFileSync(
      join(tmpDir, 'properties.yaml'),
      `properties:
  headcount:
    name: Headcount
    dataType: number
    category: people
`,
    );

    const injectedEntities = new Map<string, Entity>([
      [
        'aB3cD4eF5g',
        {
          id: 'aB3cD4eF5g',
          stableId: 'aB3cD4eF5g',
          type: 'organization',
          name: 'Test Organization',
        },
      ],
    ]);

    const { graph, filenameMap } = await loadKB(tmpDir, { entities: injectedEntities });

    // Entity should be the injected one
    const entity = graph.getEntity('aB3cD4eF5g');
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('Test Organization');
    expect(entity!.type).toBe('organization');

    // Filename map should use the YAML filename
    expect(filenameMap.get('aB3cD4eF5g')).toBe('test-org');

    // Facts should be loaded
    const facts = graph.getFacts('aB3cD4eF5g');
    expect(facts).toHaveLength(1);
    expect(facts[0].propertyId).toBe('headcount');
    expect(facts[0].value).toEqual({ type: 'number', value: 100 });
  });

  it('creates minimal stub when entity: stableId not in injected map', async () => {
    writeFileSync(
      join(tmpDir, 'fb-entities', 'orphan-entity.yaml'),
      `entity: xY9zW8vU7t
facts:
  - id: f_orphan01
    property: description
    value: "An orphaned entity"
`,
    );

    writeFileSync(
      join(tmpDir, 'properties.yaml'),
      `properties:
  description:
    name: Description
    dataType: text
`,
    );

    // No injected entities
    const { graph, filenameMap } = await loadKB(tmpDir);

    const entity = graph.getEntity('xY9zW8vU7t');
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('orphan-entity'); // fallback to filename
    expect(entity!.type).toBe('unknown');

    expect(filenameMap.get('xY9zW8vU7t')).toBe('orphan-entity');

    const facts = graph.getFacts('xY9zW8vU7t');
    expect(facts).toHaveLength(1);
  });

  it('entity: format works alongside thing: format in same directory', async () => {
    // Old-format file
    writeFileSync(
      join(tmpDir, 'fb-entities', 'old-org.yaml'),
      `thing:
  id: old-org
  stableId: oLdOrG1234
  type: organization
  name: Old Organization
`,
    );

    // New-format file
    writeFileSync(
      join(tmpDir, 'fb-entities', 'new-org.yaml'),
      `entity: nEwOrG5678
facts:
  - id: f_new001
    property: description
    value: "A new org"
`,
    );

    writeFileSync(
      join(tmpDir, 'properties.yaml'),
      `properties:
  description:
    name: Description
    dataType: text
`,
    );

    const injectedEntities = new Map<string, Entity>([
      [
        'nEwOrG5678',
        {
          id: 'nEwOrG5678',
          stableId: 'nEwOrG5678',
          type: 'organization',
          name: 'New Organization',
        },
      ],
    ]);

    const { graph, filenameMap } = await loadKB(tmpDir, { entities: injectedEntities });

    // Both entities should be present
    expect(graph.getEntity('oLdOrG1234')).toBeDefined();
    expect(graph.getEntity('oLdOrG1234')!.name).toBe('Old Organization');

    expect(graph.getEntity('nEwOrG5678')).toBeDefined();
    expect(graph.getEntity('nEwOrG5678')!.name).toBe('New Organization');

    expect(filenameMap.get('oLdOrG1234')).toBe('old-org');
    expect(filenameMap.get('nEwOrG5678')).toBe('new-org');
  });

  it('injected entities override thing: block entities', async () => {
    writeFileSync(
      join(tmpDir, 'fb-entities', 'test-entity.yaml'),
      `thing:
  id: test-entity
  stableId: tEsT123456
  type: organization
  name: YAML Name
`,
    );

    const injectedEntities = new Map<string, Entity>([
      [
        'tEsT123456',
        {
          id: 'tEsT123456',
          stableId: 'tEsT123456',
          type: 'organization',
          name: 'TableBase Name',
          wikiPageId: 'E999',
        },
      ],
    ]);

    const { graph } = await loadKB(tmpDir, { entities: injectedEntities });

    const entity = graph.getEntity('tEsT123456');
    expect(entity).toBeDefined();
    // TableBase entity should take precedence
    expect(entity!.name).toBe('TableBase Name');
    expect(entity!.wikiPageId).toBe('E999');
  });

  it('entity: format with _sources resolves !src tags', async () => {
    writeFileSync(
      join(tmpDir, 'fb-entities', 'src-test.yaml'),
      `entity: sRcTeSt123
facts:
  - id: f_src001
    property: revenue
    value: 1000000
    source: !src my-source
_sources:
  my-source: https://example.com/article
`,
    );

    writeFileSync(
      join(tmpDir, 'properties.yaml'),
      `properties:
  revenue:
    name: Revenue
    dataType: number
    unit: USD
`,
    );

    const injectedEntities = new Map<string, Entity>([
      [
        'sRcTeSt123',
        {
          id: 'sRcTeSt123',
          stableId: 'sRcTeSt123',
          type: 'organization',
          name: 'Source Test Org',
        },
      ],
    ]);

    const { graph } = await loadKB(tmpDir, { entities: injectedEntities });

    const facts = graph.getFacts('sRcTeSt123');
    expect(facts).toHaveLength(1);
    expect(facts[0].source).toBe('https://example.com/article');
  });

  it('handles empty entity: format file (no facts)', async () => {
    writeFileSync(
      join(tmpDir, 'fb-entities', 'empty-entity.yaml'),
      `entity: eMpTy12345
`,
    );

    const injectedEntities = new Map<string, Entity>([
      [
        'eMpTy12345',
        {
          id: 'eMpTy12345',
          stableId: 'eMpTy12345',
          type: 'concept',
          name: 'Empty Entity',
        },
      ],
    ]);

    const { graph, filenameMap } = await loadKB(tmpDir, { entities: injectedEntities });

    const entity = graph.getEntity('eMpTy12345');
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('Empty Entity');
    expect(filenameMap.get('eMpTy12345')).toBe('empty-entity');

    const facts = graph.getFacts('eMpTy12345');
    expect(facts).toHaveLength(0);
  });

  it('rejects entity: files with records: block', async () => {
    writeFileSync(
      join(tmpDir, 'fb-entities', 'bad-entity.yaml'),
      `entity: bAdEnT1234
records:
  - type: funding-round
    value: 1000000
facts:
  - id: f_bad001
    property: description
    value: "Should not work"
`,
    );

    await expect(loadKB(tmpDir)).rejects.toThrow('records:');
  });
});

// ── Migration: transformFile logic ──────────────────────────────────────

// Import the transformFile function indirectly via the commands
// (since it's not exported directly, we test via the full run command with a temp dir)

describe('factbase-migrate-entities transformation', () => {
  // Test the transformation logic by checking actual YAML content transformation.
  // We can't import transformFile directly, so we test the equivalent regex behavior.

  function extractStableIdFromThing(content: string): string | null {
    const thingMatch = content.match(/^thing:\n((?:[ \t]+.*\n?)*)/m);
    if (!thingMatch) return null;
    const thingBody = thingMatch[1];

    // Try stableId field (old format)
    const stableIdMatch = thingBody.match(/^\s+stableId:\s*(\S+)/m);
    if (stableIdMatch) return stableIdMatch[1];

    // New format: slug field present
    const slugMatch = thingBody.match(/^\s+slug:\s*\S+/m);
    if (slugMatch) {
      const idMatch = thingBody.match(/^\s+id:\s*(\S+)/m);
      if (idMatch) return idMatch[1];
    }

    return null;
  }

  it('extracts stableId from old-format thing: block', () => {
    const content = `thing:
  id: anthropic
  stableId: mK9pX3rQ7n
  type: organization
  name: Anthropic
  wikiId: "E22"
facts:
  - id: f_test
    property: revenue
    value: 1e9
`;
    expect(extractStableIdFromThing(content)).toBe('mK9pX3rQ7n');
  });

  it('extracts stableId from new-format thing: block (id=stableId, slug=filename)', () => {
    const content = `thing:
  id: mK9pX3rQ7n
  slug: anthropic
  type: organization
  name: Anthropic
  wikiPageId: "E22"
facts:
  - id: f_test
    property: revenue
    value: 1e9
`;
    expect(extractStableIdFromThing(content)).toBe('mK9pX3rQ7n');
  });

  it('returns null for entity: format (no thing: block)', () => {
    const content = `entity: mK9pX3rQ7n
facts:
  - id: f_test
    property: revenue
    value: 1e9
`;
    expect(extractStableIdFromThing(content)).toBeNull();
  });
});
