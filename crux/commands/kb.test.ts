/**
 * Tests for the KB CLI command handlers.
 *
 * These tests verify the command functions produce correct output
 * by loading the real KB data directory.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commands, resolveEntityArg } from './kb.ts';
import { loadGraphFull } from '../lib/kb-loader.ts';
import {
  readEntityDocument,
  appendFact,
  appendRecord,
  writeEntityDocument,
  findEntityFilePath,
  generateRecordKey,
  pluralizeRecordType,
} from '../lib/kb-writer.ts';
import type { RawFactInput } from '../lib/kb-writer.ts';

// The tests load real data from packages/kb/data/ — no mocking needed.
// They are integration-style tests that exercise the full show/list/lookup flow.

describe('crux kb list', () => {
  it('lists all entities in table format', async () => {
    const result = await commands.list([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('organization');
    expect(result.output).toContain('mK9pX3rQ7n');
    expect(result.output).toContain('Total:');
  }, 30_000);

  it('filters by type', async () => {
    const result = await commands.list([], { type: 'person' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dario Amodei');
    expect(result.output).not.toContain('Anthropic'); // org not in person list
  }, 30_000);

  it('returns JSON in ci mode', async () => {
    const result = await commands.list([], { ci: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('id');
    expect(data[0]).toHaveProperty('name');
    expect(data[0]).toHaveProperty('factCount');
  }, 30_000);
});

describe('crux kb show', () => {
  it('shows entity details with facts and items', async () => {
    const result = await commands.show(['anthropic'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('mK9pX3rQ7n');
    expect(result.output).toContain('organization');
    expect(result.output).toContain('Facts');
    expect(result.output).toContain('Revenue');
    expect(result.output).toContain('Records');
    expect(result.output).toContain('funding-rounds');
    expect(result.output).toContain('key-persons');
  }, 30_000);

  it('formats financial values with proper units', async () => {
    const result = await commands.show(['anthropic'], {});
    expect(result.exitCode).toBe(0);
    // Revenue should show $XB format
    expect(result.output).toMatch(/\$\d+(\.\d)?B/);
  }, 30_000);

  it('resolves refs to names in facts', async () => {
    const result = await commands.show(['dario-amodei'], {});
    expect(result.exitCode).toBe(0);
    // Ref values show as "Name (entityId)"
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('mK9pX3rQ7n');
  }, 30_000);

  it('shows birth year without comma separator', async () => {
    const result = await commands.show(['dario-amodei'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('1983');
    expect(result.output).not.toContain('1,983');
  }, 30_000);

  it('resolves refs in key-people items', async () => {
    const result = await commands.show(['anthropic'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dario Amodei');
    expect(result.output).toContain('CEO');
  }, 30_000);

  it('returns error for non-existent entity', async () => {
    const result = await commands.show(['nonexistent-entity-xyz'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Entity not found');
  }, 30_000);

  it('shows usage when no entity specified', async () => {
    const result = await commands.show([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });
});

describe('crux kb lookup', () => {
  it('looks up a known stableId', async () => {
    const result = await commands.lookup(['mK9pX3rQ7n'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Anthropic');
  }, 30_000);

  it('returns error for unknown stableId', async () => {
    const result = await commands.lookup(['XXXXXXXXXX'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No entity found');
  }, 30_000);

  it('returns JSON in ci mode', async () => {
    const result = await commands.lookup(['zR4nW8xB2f'], { ci: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.name).toBe('Dario Amodei');
    expect(data.type).toBe('person');
  }, 30_000);

  it('shows usage when no stableId specified', async () => {
    const result = await commands.lookup([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });
});

// ── resolveEntityArg tests ──────────────────────────────────────────────

describe('resolveEntityArg', () => {
  let kb: Awaited<ReturnType<typeof loadGraphFull>>;

  beforeAll(async () => {
    kb = await loadGraphFull();
  }, 30_000);

  it('resolves by slug (filename)', () => {
    const entity = resolveEntityArg('anthropic', kb);
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('Anthropic');
  });

  it('resolves by stableId', () => {
    const entity = resolveEntityArg('mK9pX3rQ7n', kb);
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('Anthropic');
  });

  it('resolves by name (case-insensitive)', () => {
    const entity = resolveEntityArg('Dario Amodei', kb);
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('person');
  });

  it('returns undefined for non-existent entity', () => {
    const entity = resolveEntityArg('nonexistent-xyz-123', kb);
    expect(entity).toBeUndefined();
  });
});

// ── pluralizeRecordType tests ───────────────────────────────────────────

describe('pluralizeRecordType', () => {
  it('pluralizes regular names by appending s', () => {
    expect(pluralizeRecordType('funding-round')).toBe('funding-rounds');
    expect(pluralizeRecordType('investment')).toBe('investments');
    expect(pluralizeRecordType('grant')).toBe('grants');
    expect(pluralizeRecordType('product')).toBe('products');
  });

  it('handles consonant+y -> ies', () => {
    expect(pluralizeRecordType('career-history')).toBe('career-histories');
  });

  it('does not convert vowel+y to ies', () => {
    // "key" should become "keys", not "keies"
    expect(pluralizeRecordType('key')).toBe('keys');
  });
});

// ── kb-writer YAML round-trip tests ──────────────────────────────────────

describe('kb-writer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kb-writer-test-'));
    mkdirSync(join(tmpDir, 'things'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends a fact preserving comments', () => {
    const yamlContent = `thing:
  id: test-entity
  stableId: aB3cD4eF5g
  type: organization
  name: Test Org

# ── Existing facts ──
facts:
  - id: f_existing123
    property: revenue
    value: 1000000
    asOf: 2024-01
`;
    const filePath = join(tmpDir, 'things', 'test-entity.yaml');
    writeFileSync(filePath, yamlContent, 'utf-8');

    const doc = readEntityDocument(filePath);
    const factId = appendFact(doc, {
      property: 'headcount',
      value: 500,
      asOf: '2025-01',
      source: 'https://example.com',
    });
    writeEntityDocument(filePath, doc);

    const result = readFileSync(filePath, 'utf-8');

    // The comment should be preserved
    expect(result).toContain('# ── Existing facts ──');
    // The existing fact should still be there
    expect(result).toContain('f_existing123');
    // The new fact should be appended
    expect(result).toContain(factId);
    expect(result).toContain('headcount');
    expect(result).toContain('500');
    expect(result).toContain('2025-01');
    expect(result).toContain('https://example.com');
  });

  it('creates facts section if none exists', () => {
    const yamlContent = `thing:
  id: test-entity
  stableId: aB3cD4eF5g
  type: organization
  name: Test Org
`;
    const filePath = join(tmpDir, 'things', 'test-entity.yaml');
    writeFileSync(filePath, yamlContent, 'utf-8');

    const doc = readEntityDocument(filePath);
    const factId = appendFact(doc, {
      property: 'revenue',
      value: 1000000,
    });
    writeEntityDocument(filePath, doc);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('facts:');
    expect(result).toContain(factId);
    expect(result).toContain('revenue');
  });

  it('appends a record entry', () => {
    const yamlContent = `thing:
  id: test-entity
  stableId: aB3cD4eF5g
  type: organization
  name: Test Org

facts: []
`;
    const filePath = join(tmpDir, 'things', 'test-entity.yaml');
    writeFileSync(filePath, yamlContent, 'utf-8');

    const doc = readEntityDocument(filePath);
    appendRecord(doc, 'funding-rounds', 'i_testKey123', {
      amount: 2000000000,
      round: 'Series E',
    });
    writeEntityDocument(filePath, doc);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('records:');
    expect(result).toContain('funding-rounds:');
    expect(result).toContain('i_testKey123');
    expect(result).toContain('2000000000');
    expect(result).toContain('Series E');
  });

  it('appends to existing records section', () => {
    const yamlContent = `thing:
  id: test-entity
  stableId: aB3cD4eF5g
  type: organization
  name: Test Org

records:
  funding-rounds:
    i_existingKey:
      amount: 1000000
`;
    const filePath = join(tmpDir, 'things', 'test-entity.yaml');
    writeFileSync(filePath, yamlContent, 'utf-8');

    const doc = readEntityDocument(filePath);
    appendRecord(doc, 'funding-rounds', 'i_newKey12345', {
      amount: 5000000,
      round: 'Series B',
    });
    writeEntityDocument(filePath, doc);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('i_existingKey');
    expect(result).toContain('i_newKey12345');
    expect(result).toContain('5000000');
    expect(result).toContain('Series B');
  });

  it('findEntityFilePath finds single-file entities', () => {
    const filePath = join(tmpDir, 'things', 'my-entity.yaml');
    writeFileSync(filePath, 'thing:\n  id: my-entity\n', 'utf-8');

    const found = findEntityFilePath('my-entity', tmpDir);
    expect(found).toBe(filePath);
  });

  it('findEntityFilePath finds directory-based entities', () => {
    mkdirSync(join(tmpDir, 'things', 'my-entity'), { recursive: true });
    const filePath = join(tmpDir, 'things', 'my-entity', 'entity.yaml');
    writeFileSync(filePath, 'thing:\n  id: my-entity\n', 'utf-8');

    const found = findEntityFilePath('my-entity', tmpDir);
    expect(found).toBe(filePath);
  });

  it('findEntityFilePath returns null for non-existent entity', () => {
    const found = findEntityFilePath('nonexistent', tmpDir);
    expect(found).toBeNull();
  });

  it('preserves !ref and !date tags during round-trip', () => {
    const yamlContent = `thing:
  id: test-entity
  stableId: aB3cD4eF5g
  type: person
  name: Test Person

facts:
  - id: f_existing123
    property: employed-by
    value: !ref mK9pX3rQ7n:anthropic
  - id: f_existing456
    property: birth-year
    value: !date 1983
`;
    const filePath = join(tmpDir, 'things', 'test-entity.yaml');
    writeFileSync(filePath, yamlContent, 'utf-8');

    const doc = readEntityDocument(filePath);
    appendFact(doc, { property: 'headcount', value: 100 });
    writeEntityDocument(filePath, doc);

    const result = readFileSync(filePath, 'utf-8');
    // Custom tags should be preserved
    expect(result).toContain('!ref mK9pX3rQ7n:anthropic');
    expect(result).toContain('!date 1983');
  });

  it('generateRecordKey produces i_ prefix with 10-char ID', () => {
    const key = generateRecordKey();
    expect(key).toMatch(/^i_[a-zA-Z0-9]{10}$/);
  });
});

// ── add-fact command tests (integration with real data) ──────────────────

describe('crux kb add-fact', () => {
  it('shows usage when insufficient args', async () => {
    const result = await commands['add-fact'](['anthropic'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });

  it('returns error for non-existent entity', async () => {
    const result = await commands['add-fact'](['nonexistent-xyz', 'revenue', '100'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Entity not found');
  }, 30_000);

  it('returns error for non-existent property', async () => {
    const result = await commands['add-fact'](['anthropic', 'fake-property-xyz', '100'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Property not found');
  }, 30_000);

  it('returns error for invalid number value', async () => {
    const result = await commands['add-fact'](['anthropic', 'revenue', 'not-a-number'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Cannot parse');
  }, 30_000);
});

// ── add-record command tests (integration with real data) ────────────────

describe('crux kb add-record', () => {
  it('shows usage when insufficient args', async () => {
    const result = await commands['add-record'](['anthropic'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });

  it('returns error for non-existent entity', async () => {
    const result = await commands['add-record'](['nonexistent-xyz', 'funding-round'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Entity not found');
  }, 30_000);

  it('returns error for non-existent record schema', async () => {
    const result = await commands['add-record'](['anthropic', 'fake-record-xyz'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Record schema not found');
  }, 30_000);

  it('returns error for invalid key=value pair', async () => {
    const result = await commands['add-record'](['anthropic', 'funding-round', 'badformat'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid key=value');
  }, 30_000);

  it('returns error for unknown field names with list of valid fields', async () => {
    const result = await commands['add-record']([
      'anthropic', 'funding-round', 'amunt=2e9', 'naem=SeriesX'],
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown field');
    expect(result.output).toContain('"amunt"');
    expect(result.output).toContain('"naem"');
    // Should list valid fields so the user can fix the typo
    expect(result.output).toContain('Valid fields');
    expect(result.output).toContain('raised');
    expect(result.output).toContain('name');
  }, 30_000);
});
