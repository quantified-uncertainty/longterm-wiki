/**
 * Unit tests for the scorecard → FactBase mirror (QUA-865).
 *
 * Tests run against a per-test tmp directory holding a synthetic
 * single-file `<slug>.yaml`. Grades are injected as test fixtures so no
 * wiki-server is required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

import {
  gradeToFact,
  buildFactsByEntity,
  buildSlugByStableId,
  applyManagedFacts,
  readEntityDocument,
  writeEntityDocument,
  findEntityFile,
  writeManagedFactsToEntity,
  findEntitiesWithManagedFacts,
  syncScorecardFactsToYaml,
  formatWaveLabel,
  SCORECARD_PREDICATE_BY_SOURCE,
  MANAGED_PREDICATES,
  type ApiGrade,
  type MirrorFact,
} from '../factbase-mirror.ts';
import type { EntityWithType } from '../../research/entity-loader.ts';

// ── Fixtures ───────────────────────────────────────────────────────────

function makeGrade(overrides: Partial<ApiGrade> = {}): ApiGrade {
  const base: Record<string, unknown> = {
    id: 'snap1|sid_anth|overall',
    snapshotId: 'fli_index-winter-2025',
    entityId: 'sid_anth',
    entityDisplayName: 'Anthropic',
    entitySlug: null,
    dimensionSlug: 'overall',
    dimensionLabel: 'Overall',
    dimensionWeight: null,
    dimensionParentSlug: null,
    scoreNumeric: null,
    scoreLetter: 'C+',
    scoreRaw: 'C+',
    notes: null,
    sourceUrl: null,
    snapshotSourceUrl: 'https://futureoflife.org/ai-safety-index-winter-2025/',
    scorecardSource: 'fli_index',
    publishedAt: '2025-12-02',
    isLatest: true,
    syncedAt: '2025-12-02T00:00:00Z',
    sourcing: null,
  };
  return { ...base, ...overrides } as unknown as ApiGrade;
}

function makeEntity(slug: string, stableId: string): EntityWithType {
  return { id: slug, type: 'organization', stableId } as unknown as EntityWithType;
}

const MINIMAL_ENTITY_YAML = `entity: sid_anth
facts:
  - id: f_human0001
    property: revenue
    value: 1e+9
    asOf: '2025-01'
    source: https://example.com/revenue
`;

// ── gradeToFact ─────────────────────────────────────────────────────────

describe('gradeToFact', () => {
  it('maps an FLI grade to a fact with the expected predicate, source, and notes', () => {
    const fact = gradeToFact(makeGrade());
    expect(fact).not.toBeNull();
    expect(fact!.property).toBe('fli-index-grade');
    expect(fact!.value).toBe('C+');
    expect(fact!.asOf).toBe('2025-12-02');
    expect(fact!.source).toBe('https://futureoflife.org/ai-safety-index-winter-2025/');
    expect(fact!.notes).toBe('FLI AI Safety Index — December 2025');
    expect(fact!.id).toMatch(/^f_[a-zA-Z0-9]{10}$/);
  });

  it('prefers per-grade sourceUrl over the snapshot fallback', () => {
    const fact = gradeToFact(makeGrade({
      sourceUrl: 'https://futureoflife.org/ai-safety-index-winter-2025/anthropic',
    }));
    expect(fact!.source).toBe(
      'https://futureoflife.org/ai-safety-index-winter-2025/anthropic',
    );
  });

  it('returns the same id for the same (subject, predicate, value, asOf)', () => {
    const a = gradeToFact(makeGrade());
    const b = gradeToFact(makeGrade());
    expect(a!.id).toBe(b!.id);
  });

  it('returns a different id when the value changes', () => {
    const a = gradeToFact(makeGrade({ scoreRaw: 'C+' }));
    const b = gradeToFact(makeGrade({ scoreRaw: 'B' }));
    expect(a!.id).not.toBe(b!.id);
  });

  it('handles SaferAI percent values', () => {
    const fact = gradeToFact(makeGrade({
      scorecardSource: 'saferai',
      scoreRaw: '34%',
      snapshotSourceUrl: 'https://ratings.safer-ai.org/comparison/',
      publishedAt: '2025-10-01',
    }));
    expect(fact!.property).toBe('saferai-grade');
    expect(fact!.value).toBe('34%');
    expect(fact!.notes).toBe('SaferAI Ratings — October 2025');
  });

  it('handles every known scorecard source', () => {
    for (const source of Object.keys(SCORECARD_PREDICATE_BY_SOURCE)) {
      const fact = gradeToFact(makeGrade({ scorecardSource: source }));
      expect(fact, `source=${source}`).not.toBeNull();
      expect(fact!.property).toBe(SCORECARD_PREDICATE_BY_SOURCE[source]);
    }
  });

  it('returns null for an unknown scorecard source', () => {
    expect(gradeToFact(makeGrade({ scorecardSource: 'made_up_source' }))).toBeNull();
  });

  it('returns null when scorecardSource is null (left-join hole)', () => {
    expect(gradeToFact(makeGrade({ scorecardSource: null as unknown as string }))).toBeNull();
  });

  it('returns null when scorecardSource is empty string', () => {
    expect(gradeToFact(makeGrade({ scorecardSource: '' }))).toBeNull();
  });

  it('returns null when scoreRaw is empty', () => {
    expect(gradeToFact(makeGrade({ scoreRaw: '' }))).toBeNull();
  });

  it('returns null when both per-grade and snapshot source urls are missing', () => {
    expect(gradeToFact(makeGrade({
      sourceUrl: null,
      snapshotSourceUrl: null as unknown as string,
    }))).toBeNull();
  });

  it('returns null when publishedAt is missing', () => {
    expect(gradeToFact(makeGrade({
      publishedAt: null as unknown as string,
    }))).toBeNull();
  });

  it('falls back to year-only when asOf is just a year', () => {
    const fact = gradeToFact(makeGrade({ publishedAt: '2025' }));
    expect(fact!.notes).toBe('FLI AI Safety Index — 2025');
  });

  it('falls back to YYYY-MM when asOf has no day', () => {
    const fact = gradeToFact(makeGrade({ publishedAt: '2025-10' }));
    expect(fact!.notes).toBe('FLI AI Safety Index — October 2025');
  });
});

// ── buildFactsByEntity ──────────────────────────────────────────────────

describe('buildFactsByEntity', () => {
  it('groups grades by entity stableId', () => {
    const grades = [
      makeGrade({ entityId: 'sid_a', scoreRaw: 'A' }),
      makeGrade({ entityId: 'sid_b', scoreRaw: 'B' }),
      makeGrade({ entityId: 'sid_a', scorecardSource: 'saferai', scoreRaw: '50%', snapshotSourceUrl: 'https://safer-ai/' }),
    ];
    const out = buildFactsByEntity(grades);
    expect(out.size).toBe(2);
    expect(out.get('sid_a')!.length).toBe(2);
    expect(out.get('sid_b')!.length).toBe(1);
  });

  it('sorts each entity\'s facts by (predicate, asOf) for stable diffs', () => {
    const grades = [
      makeGrade({ scorecardSource: 'saferai', scoreRaw: '34%', snapshotSourceUrl: 'https://safer-ai/' }),
      makeGrade({ scorecardSource: 'fli_index', scoreRaw: 'C+' }),
      makeGrade({ scorecardSource: 'fli_index', scoreRaw: 'B', publishedAt: '2024-12-01', snapshotId: 'fli-2024' }),
    ];
    const facts = buildFactsByEntity(grades).get('sid_anth')!;
    expect(facts.map(f => f.property)).toEqual(['fli-index-grade', 'fli-index-grade', 'saferai-grade']);
    expect(facts[0].asOf).toBe('2024-12-01');
    expect(facts[1].asOf).toBe('2025-12-02');
  });

  it('drops grades that fail gradeToFact', () => {
    const grades = [
      makeGrade({ entityId: 'sid_a', scorecardSource: 'unknown_x' }),
      makeGrade({ entityId: 'sid_b' }),
    ];
    const out = buildFactsByEntity(grades);
    expect(out.has('sid_a')).toBe(false);
    expect(out.has('sid_b')).toBe(true);
  });

  it('returns an empty map for empty input', () => {
    expect(buildFactsByEntity([]).size).toBe(0);
  });
});

// ── buildSlugByStableId ─────────────────────────────────────────────────

describe('buildSlugByStableId', () => {
  it('maps stableIds to slugs', () => {
    const map = buildSlugByStableId([
      makeEntity('anthropic', 'sid_anth'),
      makeEntity('openai', 'sid_oai'),
    ]);
    expect(map.get('sid_anth')).toBe('anthropic');
    expect(map.get('sid_oai')).toBe('openai');
  });

  it('skips entities without a stableId field', () => {
    const map = buildSlugByStableId([
      makeEntity('anthropic', 'sid_anth'),
      { id: 'no-stable', type: 'organization' } as EntityWithType,
    ]);
    expect(map.size).toBe(1);
  });

  it('handles non-string stableId values defensively', () => {
    const malformed = { id: 'broken', type: 'organization', stableId: 42 } as unknown as EntityWithType;
    expect(buildSlugByStableId([malformed]).size).toBe(0);
  });
});

// ── MANAGED_PREDICATES ──────────────────────────────────────────────────

describe('MANAGED_PREDICATES', () => {
  it('contains exactly the five scorecard predicates', () => {
    expect([...MANAGED_PREDICATES].sort()).toEqual([
      'ailabwatch-grade',
      'fli-index-grade',
      'fmti-grade',
      'saferai-grade',
      'seoul-tracker-grade',
    ]);
  });

  it('matches every value in SCORECARD_PREDICATE_BY_SOURCE', () => {
    for (const pred of Object.values(SCORECARD_PREDICATE_BY_SOURCE)) {
      expect(MANAGED_PREDICATES.has(pred)).toBe(true);
    }
  });
});

// ── formatWaveLabel ─────────────────────────────────────────────────────

describe('formatWaveLabel', () => {
  it('formats full ISO dates with month name', () => {
    expect(formatWaveLabel('2025-12-02')).toBe('December 2025');
    expect(formatWaveLabel('2025-10-01')).toBe('October 2025');
  });

  it('formats year-month dates with month name', () => {
    expect(formatWaveLabel('2024-06')).toBe('June 2024');
  });

  it('formats year-only dates as just the year', () => {
    expect(formatWaveLabel('2025')).toBe('2025');
  });

  it('returns the raw asOf when the regex does not match', () => {
    expect(formatWaveLabel('not-a-date')).toBe('not-a-date');
    expect(formatWaveLabel('')).toBe('');
  });

  it('returns the raw asOf when the month is out of range', () => {
    expect(formatWaveLabel('2025-13-01')).toBe('2025-13-01');
    expect(formatWaveLabel('2025-00')).toBe('2025-00');
  });
});

// ── applyManagedFacts ───────────────────────────────────────────────────

describe('applyManagedFacts', () => {
  const fact: MirrorFact = {
    id: 'f_aaa1234567',
    property: 'fli-index-grade',
    value: 'C+',
    asOf: '2025-12-02',
    source: 'https://futureoflife.org/ai-safety-index-winter-2025/',
    notes: 'FLI AI Safety Index — December 2025',
  };

  it('appends fresh facts to a doc with no managed facts', () => {
    const doc = parseDocument(MINIMAL_ENTITY_YAML);
    const counts = applyManagedFacts(doc, [fact]);
    expect(counts.removed).toBe(0);
    expect(counts.appended).toBe(1);
    const out = doc.toString();
    expect(out).toContain('fli-index-grade');
    expect(out).toContain('C+');
    // Hand-curated revenue fact must still be present.
    expect(out).toContain('property: revenue');
  });

  it('removes pre-existing managed facts before appending', () => {
    const yaml = `entity: sid_anth
facts:
  - id: f_old1
    property: fli-index-grade
    value: 'D'
    asOf: '2024-12-01'
    source: https://old.example.com
    notes: stale
  - id: f_human
    property: revenue
    value: 1e+9
    asOf: '2025-01'
`;
    const doc = parseDocument(yaml);
    const counts = applyManagedFacts(doc, [fact]);
    expect(counts.removed).toBe(1);
    expect(counts.appended).toBe(1);
    const out = doc.toString();
    expect(out).not.toContain('f_old1');
    expect(out).not.toContain("'D'");
    expect(out).toContain('C+');
    expect(out).toContain('property: revenue');
  });

  it('removes ALL managed predicate facts, not just the same source', () => {
    const yaml = `entity: sid_anth
facts:
  - id: f_old_fli
    property: fli-index-grade
    value: 'D'
    asOf: '2024-12-01'
    source: https://old.example.com
  - id: f_old_saferai
    property: saferai-grade
    value: '20%'
    asOf: '2024-10-01'
    source: https://old.safer-ai/
  - id: f_human
    property: revenue
    value: 1e+9
`;
    const doc = parseDocument(yaml);
    const counts = applyManagedFacts(doc, []);
    expect(counts.removed).toBe(2);
    expect(counts.appended).toBe(0);
    const out = doc.toString();
    expect(out).not.toContain('fli-index-grade');
    expect(out).not.toContain('saferai-grade');
    expect(out).toContain('property: revenue');
  });

  it('preserves comments in the entity yaml', () => {
    const yaml = `# top-of-file comment
entity: sid_anth
# pre-facts comment
facts:
  - id: f_human
    property: revenue
    value: 1e+9
    # inline comment
    asOf: '2025-01'
`;
    const doc = parseDocument(yaml);
    applyManagedFacts(doc, [fact]);
    const out = doc.toString();
    expect(out).toContain('# top-of-file comment');
    expect(out).toContain('# pre-facts comment');
    expect(out).toContain('# inline comment');
  });

  it('creates a facts: sequence when missing', () => {
    const doc = parseDocument(`entity: sid_anth\n`);
    applyManagedFacts(doc, [fact]);
    expect(doc.toString()).toContain('facts:');
    expect(doc.toString()).toContain('fli-index-grade');
  });

  it('throws when the root is not a mapping', () => {
    const doc = parseDocument(`- just-a-list\n`);
    expect(() => applyManagedFacts(doc, [fact])).toThrow(/root is not a mapping/);
  });

  it('throws when facts is not a sequence', () => {
    const doc = parseDocument(`entity: sid_anth\nfacts: "not-a-seq"\n`);
    expect(() => applyManagedFacts(doc, [fact])).toThrow(/`facts` node is not a sequence/);
  });

  it('does not touch facts whose property is not in MANAGED_PREDICATES', () => {
    const yaml = `entity: sid_anth
facts:
  - id: f_a
    property: revenue
    value: 1e+9
  - id: f_b
    property: valuation
    value: 4e+10
  - id: f_c
    property: founded-by
    value: someone
`;
    const doc = parseDocument(yaml);
    const counts = applyManagedFacts(doc, []);
    expect(counts.removed).toBe(0);
    expect(counts.appended).toBe(0);
  });
});

// ── findEntityFile ──────────────────────────────────────────────────────

describe('findEntityFile', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns the path when the single-file form exists', () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    expect(findEntityFile('anthropic', tmp)).toBe(join(tmp, 'anthropic.yaml'));
  });

  it('returns null when no fb-entity yaml exists for the slug', () => {
    expect(findEntityFile('anthropic', tmp)).toBeNull();
  });
});

// ── writeManagedFactsToEntity ───────────────────────────────────────────

describe('writeManagedFactsToEntity', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const fact: MirrorFact = {
    id: 'f_aaa1234567',
    property: 'fli-index-grade',
    value: 'C+',
    asOf: '2025-12-02',
    source: 'https://futureoflife.org/ai-safety-index-winter-2025/',
    notes: 'FLI AI Safety Index — December 2025',
  };

  it('writes facts inline into the entity yaml', () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    const result = writeManagedFactsToEntity('anthropic', [fact], tmp);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(join(tmp, 'anthropic.yaml'));
    expect(result!.appended).toBe(1);
    const out = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    expect(out).toContain('fli-index-grade');
    expect(out).toContain('C+');
  });

  it('returns null when no fb-entity yaml exists', () => {
    expect(writeManagedFactsToEntity('ghost', [fact], tmp)).toBeNull();
  });

  it('preserves existing hand-curated facts', () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    writeManagedFactsToEntity('anthropic', [fact], tmp);
    const out = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    expect(out).toContain('property: revenue');
  });

  it('replaces stale managed facts on re-write', () => {
    const yaml = `entity: sid_anth
facts:
  - id: f_old
    property: fli-index-grade
    value: 'D'
    asOf: '2024-12-01'
    source: https://old.example.com
`;
    writeFileSync(join(tmp, 'anthropic.yaml'), yaml, 'utf-8');
    const result = writeManagedFactsToEntity('anthropic', [fact], tmp);
    expect(result!.removed).toBe(1);
    const out = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    expect(out).not.toContain('f_old');
    expect(out).toContain('C+');
  });
});

// ── findEntitiesWithManagedFacts ────────────────────────────────────────

describe('findEntitiesWithManagedFacts', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns slugs whose yaml mentions a managed predicate', () => {
    writeFileSync(join(tmp, 'has-managed.yaml'),
      `entity: sid_a\nfacts:\n  - id: f_x\n    property: fli-index-grade\n`, 'utf-8');
    writeFileSync(join(tmp, 'plain.yaml'),
      `entity: sid_b\nfacts:\n  - id: f_y\n    property: revenue\n`, 'utf-8');

    const found = findEntitiesWithManagedFacts(tmp);
    expect(found).toEqual(['has-managed']);
  });

  it('returns [] when fb-entities dir does not exist', () => {
    expect(findEntitiesWithManagedFacts(join(tmp, 'nonexistent'))).toEqual([]);
  });

  it('matches every managed predicate', () => {
    let i = 0;
    for (const pred of MANAGED_PREDICATES) {
      writeFileSync(join(tmp, `e${i}.yaml`),
        `entity: sid_${i}\nfacts:\n  - id: f_x\n    property: ${pred}\n`, 'utf-8');
      i++;
    }
    expect(findEntitiesWithManagedFacts(tmp).length).toBe(MANAGED_PREDICATES.size);
  });
});

// ── readEntityDocument / writeEntityDocument round-trip ────────────────

describe('readEntityDocument / writeEntityDocument', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('round-trips !ref and !date custom tags without error', () => {
    const yaml = `entity: sid_anth
facts:
  - id: f_a
    property: founded-by
    value: !ref sid_zR4nW8xB2f
  - id: f_b
    property: founded-date
    value: !date 2021
    asOf: '2021'
`;
    const path = join(tmp, 'anthropic.yaml');
    writeFileSync(path, yaml, 'utf-8');
    const doc = readEntityDocument(path);
    writeEntityDocument(path, doc);
    const out = readFileSync(path, 'utf-8');
    expect(out).toContain('!ref sid_zR4nW8xB2f');
    expect(out).toContain('!date 2021');
  });
});

// ── syncScorecardFactsToYaml ────────────────────────────────────────────

describe('syncScorecardFactsToYaml', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('writes scorecard yaml inline for each rated entity that has a fb-entity file', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    writeFileSync(join(tmp, 'openai.yaml'), `entity: sid_oai\n`, 'utf-8');

    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [
        makeEntity('anthropic', 'sid_anth'),
        makeEntity('openai', 'sid_oai'),
      ],
      grades: [
        makeGrade({ entityId: 'sid_anth', scoreRaw: 'C+' }),
        makeGrade({ entityId: 'sid_oai', scoreRaw: 'C+' }),
      ],
    });

    expect(summary.entitiesWithGrades).toBe(2);
    expect(summary.entitiesWritten).toBe(2);
    expect(summary.entitiesSkippedNoFbYaml).toBe(0);
    expect(summary.entitiesSkippedNoSlug).toBe(0);
    expect(readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8')).toContain('fli-index-grade');
    expect(readFileSync(join(tmp, 'openai.yaml'), 'utf-8')).toContain('fli-index-grade');
  });

  it('skips entities whose stableId has no slug mapping', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [
        makeGrade({ entityId: 'sid_anth' }),
        makeGrade({ entityId: 'sid_unknown', scoreRaw: 'A' }),
      ],
    });
    expect(summary.entitiesSkippedNoSlug).toBe(1);
    expect(summary.entitiesWritten).toBe(1);
  });

  it('skips entities that resolve to a slug but have no fb-entity yaml on disk', async () => {
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    });
    expect(summary.entitiesSkippedNoFbYaml).toBe(1);
    expect(summary.entitiesWritten).toBe(0);
  });

  it('is idempotent — running twice produces byte-identical output', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    const opts = {
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    };
    await syncScorecardFactsToYaml(opts);
    const before = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    await syncScorecardFactsToYaml(opts);
    const after = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    expect(after).toBe(before);
  });

  it('removes stale managed facts when an entity drops from latest grades', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    // First run — add managed facts.
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    });
    expect(readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8')).toContain('fli-index-grade');

    // Second run with no grades — managed facts must be cleaned up.
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [],
    });
    expect(summary.staleFactsRemoved).toBe(1);
    const out = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    expect(out).not.toContain('fli-index-grade');
    // Hand-curated facts preserved.
    expect(out).toContain('property: revenue');
  });

  it('overwrites a previous wave\'s grade when same predicate-source has new data', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth', scoreRaw: 'C+', publishedAt: '2024-12-01' })],
    });
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth', scoreRaw: 'B-', publishedAt: '2025-12-02' })],
    });
    const out = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    expect(out).not.toContain("'C+'");
    expect(out).toContain('B-');
    expect(out).toContain('2025-12-02');
  });

  it('--dry-run does not modify any files', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    const before = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
      dryRun: true,
    });
    expect(summary.entitiesWritten).toBe(1);
    expect(readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8')).toBe(before);
  });

  it('--dry-run still counts would-be stale removals', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    // Live run to add managed facts.
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    });
    const after = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');

    // Dry-run with no grades — should report 1 would-be removal but not write.
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [],
      dryRun: true,
    });
    expect(summary.staleFactsRemoved).toBe(1);
    // FS unchanged.
    expect(readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8')).toBe(after);
  });

  it('handles empty input gracefully', async () => {
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [],
      grades: [],
    });
    expect(summary.entitiesWritten).toBe(0);
    expect(summary.staleFactsRemoved).toBe(0);
  });

  it('groups multiple sources for the same entity into one yaml file', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [
        makeGrade({ entityId: 'sid_anth', scoreRaw: 'C+', scorecardSource: 'fli_index' }),
        makeGrade({
          entityId: 'sid_anth',
          scoreRaw: '34%',
          scorecardSource: 'saferai',
          publishedAt: '2025-10-01',
          snapshotSourceUrl: 'https://ratings.safer-ai.org/comparison/',
        }),
      ],
    });
    const out = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    expect(out).toContain('fli-index-grade');
    expect(out).toContain('saferai-grade');
  });

  it('does not touch entities without managed facts during stale cleanup', async () => {
    // anthropic has hand-curated facts but no scorecard grades; sync runs
    // with empty grades. The file should remain byte-identical because
    // findEntitiesWithManagedFacts skips files without a managed-predicate
    // substring.
    writeFileSync(join(tmp, 'anthropic.yaml'), MINIMAL_ENTITY_YAML, 'utf-8');
    const before = readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8');
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [],
    });
    expect(readFileSync(join(tmp, 'anthropic.yaml'), 'utf-8')).toBe(before);
  });
});
