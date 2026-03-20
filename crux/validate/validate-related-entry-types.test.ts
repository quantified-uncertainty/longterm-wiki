import { describe, it, expect } from 'vitest';
import { findTypeMismatches, type TypeMismatch } from './validate-related-entry-types.ts';

describe('findTypeMismatches', () => {
  it('returns no mismatches when all types match', () => {
    const entities = [
      {
        id: 'anthropic',
        type: 'organization',
        _sourceFile: 'organizations.yaml',
        relatedEntries: [
          { id: 'dario-amodei', type: 'person' },
          { id: 'alignment', type: 'concept' },
        ],
      },
    ];
    const typeMap = new Map([
      ['anthropic', 'organization'],
      ['dario-amodei', 'person'],
      ['alignment', 'concept'],
    ]);

    const mismatches = findTypeMismatches(entities, typeMap);
    expect(mismatches).toHaveLength(0);
  });

  it('detects type mismatches', () => {
    const entities = [
      {
        id: 'some-policy',
        type: 'policy',
        _sourceFile: 'policies.yaml',
        relatedEntries: [
          { id: 'compute-governance', type: 'policy' }, // Wrong! Actually 'concept'
          { id: 'monitoring', type: 'policy' },          // Wrong! Actually 'approach'
        ],
      },
    ];
    const typeMap = new Map([
      ['some-policy', 'policy'],
      ['compute-governance', 'concept'],
      ['monitoring', 'approach'],
    ]);

    const mismatches = findTypeMismatches(entities, typeMap);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]).toMatchObject({
      sourceEntityId: 'some-policy',
      referencedEntityId: 'compute-governance',
      declaredType: 'policy',
      actualType: 'concept',
    });
    expect(mismatches[1]).toMatchObject({
      sourceEntityId: 'some-policy',
      referencedEntityId: 'monitoring',
      declaredType: 'policy',
      actualType: 'approach',
    });
  });

  it('skips entries without type field', () => {
    const entities = [
      {
        id: 'entity-a',
        type: 'concept',
        _sourceFile: 'concepts.yaml',
        relatedEntries: [
          { id: 'entity-b' }, // No type field — should be skipped
        ],
      },
    ];
    const typeMap = new Map([
      ['entity-a', 'concept'],
      ['entity-b', 'organization'],
    ]);

    const mismatches = findTypeMismatches(entities, typeMap);
    expect(mismatches).toHaveLength(0);
  });

  it('skips dangling references (entity not in typeMap)', () => {
    const entities = [
      {
        id: 'entity-a',
        type: 'concept',
        _sourceFile: 'concepts.yaml',
        relatedEntries: [
          { id: 'nonexistent-entity', type: 'organization' },
        ],
      },
    ];
    const typeMap = new Map([['entity-a', 'concept']]);

    const mismatches = findTypeMismatches(entities, typeMap);
    expect(mismatches).toHaveLength(0);
  });

  it('skips entities without relatedEntries', () => {
    const entities = [
      {
        id: 'entity-a',
        type: 'concept',
        _sourceFile: 'concepts.yaml',
      },
    ];
    const typeMap = new Map([['entity-a', 'concept']]);

    const mismatches = findTypeMismatches(entities, typeMap);
    expect(mismatches).toHaveLength(0);
  });

  it('reports correct source file', () => {
    const entities = [
      {
        id: 'entity-a',
        type: 'concept',
        _sourceFile: 'custom-file.yaml',
        relatedEntries: [
          { id: 'entity-b', type: 'organization' },
        ],
      },
    ];
    const typeMap = new Map([
      ['entity-a', 'concept'],
      ['entity-b', 'person'], // Mismatch: declared as organization, actually person
    ]);

    const mismatches = findTypeMismatches(entities, typeMap);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].sourceFile).toBe('custom-file.yaml');
  });
});
