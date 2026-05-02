/**
 * Unit tests for the scorecard → FactBase mirror (QUA-865).
 *
 * Tests run against a per-test tmp directory to exercise real file IO
 * without polluting the repo's fb-entities. Grades are injected as
 * test fixtures so no wiki-server is required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import {
  gradeToFact,
  buildFactsByEntity,
  buildSlugByStableId,
  renderScorecardGradesYaml,
  ensurePerEntityDir,
  writeScorecardGradesForEntity,
  removeManagedFile,
  findExistingManagedFiles,
  readManagedFile,
  syncScorecardFactsToYaml,
  SCORECARD_PREDICATE_BY_SOURCE,
  type ApiGrade,
  type MirrorFact,
} from '../factbase-mirror.ts';
import type { EntityWithType } from '../../research/entity-loader.ts';

// ── Fixtures ───────────────────────────────────────────────────────────

function makeGrade(overrides: Partial<ApiGrade> = {}): ApiGrade {
  // The structure mirrors the wiki-server API response. We only need the
  // fields the mirror reads — extra fields are fine but the explicit cast
  // here keeps type errors tight if the API shape changes.
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
    const sources = Object.keys(SCORECARD_PREDICATE_BY_SOURCE);
    for (const source of sources) {
      const fact = gradeToFact(makeGrade({ scorecardSource: source }));
      expect(fact, `source=${source}`).not.toBeNull();
      expect(fact!.property).toBe(SCORECARD_PREDICATE_BY_SOURCE[source]);
    }
  });

  it('returns null for an unknown scorecard source', () => {
    const fact = gradeToFact(makeGrade({ scorecardSource: 'made_up_source' }));
    expect(fact).toBeNull();
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
      // Two predicates, same date — should sort by predicate.
      makeGrade({ scorecardSource: 'saferai', scoreRaw: '34%', snapshotSourceUrl: 'https://safer-ai/' }),
      makeGrade({ scorecardSource: 'fli_index', scoreRaw: 'C+' }),
      // Same predicate, different dates — should sort by asOf.
      makeGrade({ scorecardSource: 'fli_index', scoreRaw: 'B', publishedAt: '2024-12-01', snapshotId: 'fli-2024' }),
    ];
    const out = buildFactsByEntity(grades);
    const facts = out.get('sid_anth')!;
    expect(facts.map(f => f.property)).toEqual(['fli-index-grade', 'fli-index-grade', 'saferai-grade']);
    // Within fli-index-grade, the older asOf comes first.
    expect(facts[0].asOf).toBe('2024-12-01');
    expect(facts[1].asOf).toBe('2025-12-02');
  });

  it('drops grades that fail gradeToFact (e.g. unknown source)', () => {
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
    const map = buildSlugByStableId([malformed]);
    expect(map.size).toBe(0);
  });
});

// ── renderScorecardGradesYaml ───────────────────────────────────────────

describe('renderScorecardGradesYaml', () => {
  const fact: MirrorFact = {
    id: 'f_abc1234567',
    property: 'fli-index-grade',
    value: 'C+',
    asOf: '2025-12-02',
    source: 'https://futureoflife.org/ai-safety-index-winter-2025/',
    notes: 'FLI AI Safety Index — December 2025',
  };

  it('emits a top-of-file warning header', () => {
    const out = renderScorecardGradesYaml([fact]);
    expect(out.startsWith('# Auto-generated')).toBe(true);
    expect(out).toContain('Do not edit by hand');
    expect(out).toContain('QUA-865');
  });

  it('round-trips through js-yaml without losing fields', () => {
    const out = renderScorecardGradesYaml([fact]);
    const parsed = yaml.load(out) as { facts: MirrorFact[] };
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0]).toEqual(fact);
  });

  it('preserves the {id, property, value, asOf, source, notes} key order in output', () => {
    const out = renderScorecardGradesYaml([fact]);
    const idIdx = out.indexOf('id:');
    const propIdx = out.indexOf('property:');
    const valIdx = out.indexOf('value:');
    const asOfIdx = out.indexOf('asOf:');
    const srcIdx = out.indexOf('source:');
    const notesIdx = out.indexOf('notes:');
    expect(idIdx).toBeGreaterThan(0);
    expect(propIdx).toBeGreaterThan(idIdx);
    expect(valIdx).toBeGreaterThan(propIdx);
    expect(asOfIdx).toBeGreaterThan(valIdx);
    expect(srcIdx).toBeGreaterThan(asOfIdx);
    expect(notesIdx).toBeGreaterThan(srcIdx);
  });

  it('produces byte-identical output for the same input', () => {
    expect(renderScorecardGradesYaml([fact])).toBe(renderScorecardGradesYaml([fact]));
  });

  it('does not wrap long source URLs', () => {
    const longUrl = 'https://example.com/' + 'x'.repeat(150);
    const out = renderScorecardGradesYaml([{ ...fact, source: longUrl }]);
    // The URL must appear on a single line.
    expect(out).toContain(longUrl);
  });
});

// ── Filesystem helpers ──────────────────────────────────────────────────

describe('ensurePerEntityDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('migrates a single-file entity to directory form', () => {
    const yamlPath = join(tmp, 'anthropic.yaml');
    writeFileSync(yamlPath, 'entity: sid_anth\nname: Anthropic\n', 'utf-8');

    const dir = ensurePerEntityDir('anthropic', tmp);

    expect(dir).toBe(join(tmp, 'anthropic'));
    expect(existsSync(yamlPath)).toBe(false);
    expect(existsSync(join(tmp, 'anthropic', 'entity.yaml'))).toBe(true);
    // Original content preserved exactly.
    expect(readFileSync(join(tmp, 'anthropic', 'entity.yaml'), 'utf-8'))
      .toBe('entity: sid_anth\nname: Anthropic\n');
  });

  it('is a no-op when the directory already exists', () => {
    const dir = join(tmp, 'anthropic');
    mkdirSync(dir);
    writeFileSync(join(dir, 'entity.yaml'), 'entity: sid_anth\n', 'utf-8');

    const out = ensurePerEntityDir('anthropic', tmp);

    expect(out).toBe(dir);
    expect(readFileSync(join(dir, 'entity.yaml'), 'utf-8')).toBe('entity: sid_anth\n');
  });

  it('returns null when neither file nor directory exists', () => {
    expect(ensurePerEntityDir('nonexistent', tmp)).toBeNull();
  });
});

describe('writeScorecardGradesForEntity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const fact: MirrorFact = {
    id: 'f_abc1234567',
    property: 'fli-index-grade',
    value: 'C+',
    asOf: '2025-12-02',
    source: 'https://futureoflife.org/ai-safety-index-winter-2025/',
    notes: 'FLI AI Safety Index — December 2025',
  };

  it('writes scorecard-grades.yaml when the entity exists in single-file form', () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');
    const path = writeScorecardGradesForEntity('anthropic', [fact], tmp);
    expect(path).toBe(join(tmp, 'anthropic', 'scorecard-grades.yaml'));
    expect(readManagedFile(path!)).toEqual([fact]);
    // The original entity yaml moved into the directory under the standard name.
    expect(existsSync(join(tmp, 'anthropic', 'entity.yaml'))).toBe(true);
    expect(existsSync(join(tmp, 'anthropic.yaml'))).toBe(false);
  });

  it('writes scorecard-grades.yaml when the entity already uses directory form', () => {
    mkdirSync(join(tmp, 'anthropic'));
    writeFileSync(join(tmp, 'anthropic', 'entity.yaml'), 'entity: sid_anth\n', 'utf-8');
    const path = writeScorecardGradesForEntity('anthropic', [fact], tmp);
    expect(path).toBe(join(tmp, 'anthropic', 'scorecard-grades.yaml'));
  });

  it('returns null when no fb-entity yaml exists for the slug', () => {
    expect(writeScorecardGradesForEntity('ghost', [fact], tmp)).toBeNull();
    expect(existsSync(join(tmp, 'ghost'))).toBe(false);
  });

  it('overwrites an existing scorecard-grades.yaml file', () => {
    mkdirSync(join(tmp, 'anthropic'));
    writeFileSync(join(tmp, 'anthropic', 'entity.yaml'), 'entity: sid_anth\n', 'utf-8');
    writeFileSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'), 'old content\n', 'utf-8');

    writeScorecardGradesForEntity('anthropic', [fact], tmp);

    const written = readFileSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'), 'utf-8');
    expect(written).not.toContain('old content');
    expect(written).toContain('fli-index-grade');
  });
});

describe('removeManagedFile + findExistingManagedFiles', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds every managed file across entity directories', () => {
    mkdirSync(join(tmp, 'a'));
    writeFileSync(join(tmp, 'a', 'entity.yaml'), '', 'utf-8');
    writeFileSync(join(tmp, 'a', 'scorecard-grades.yaml'), '', 'utf-8');
    mkdirSync(join(tmp, 'b'));
    writeFileSync(join(tmp, 'b', 'entity.yaml'), '', 'utf-8');
    // Skip — no managed file
    writeFileSync(join(tmp, 'c.yaml'), '', 'utf-8');

    const found = findExistingManagedFiles(tmp);
    expect(found).toEqual([join(tmp, 'a', 'scorecard-grades.yaml')]);
  });

  it('un-migrates back to single-file form when only entity.yaml is left after removal', () => {
    mkdirSync(join(tmp, 'a'));
    writeFileSync(join(tmp, 'a', 'entity.yaml'), 'entity: sid_a\n', 'utf-8');
    writeFileSync(join(tmp, 'a', 'scorecard-grades.yaml'), '', 'utf-8');

    const removed = removeManagedFile(join(tmp, 'a', 'scorecard-grades.yaml'));

    expect(removed).toBe(true);
    expect(existsSync(join(tmp, 'a'))).toBe(false);
    expect(existsSync(join(tmp, 'a.yaml'))).toBe(true);
    expect(readFileSync(join(tmp, 'a.yaml'), 'utf-8')).toBe('entity: sid_a\n');
  });

  it('keeps the directory form when other files remain after removal', () => {
    mkdirSync(join(tmp, 'a'));
    writeFileSync(join(tmp, 'a', 'entity.yaml'), 'entity: sid_a\n', 'utf-8');
    writeFileSync(join(tmp, 'a', 'extra.yaml'), 'facts: []\n', 'utf-8');
    writeFileSync(join(tmp, 'a', 'scorecard-grades.yaml'), '', 'utf-8');

    removeManagedFile(join(tmp, 'a', 'scorecard-grades.yaml'));

    expect(existsSync(join(tmp, 'a'))).toBe(true);
    expect(existsSync(join(tmp, 'a', 'entity.yaml'))).toBe(true);
    expect(existsSync(join(tmp, 'a', 'extra.yaml'))).toBe(true);
    expect(existsSync(join(tmp, 'a', 'scorecard-grades.yaml'))).toBe(false);
  });

  it('returns false when the file does not exist', () => {
    expect(removeManagedFile(join(tmp, 'a', 'scorecard-grades.yaml'))).toBe(false);
  });
});

// ── syncScorecardFactsToYaml ────────────────────────────────────────────

describe('syncScorecardFactsToYaml', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fb-mirror-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes scorecard yaml for each rated entity that has a fb-entity file', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');
    writeFileSync(join(tmp, 'openai.yaml'), 'entity: sid_oai\n', 'utf-8');

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
    expect(existsSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'))).toBe(true);
    expect(existsSync(join(tmp, 'openai', 'scorecard-grades.yaml'))).toBe(true);
  });

  it('skips entities whose stableId has no slug mapping', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');

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
    // anthropic is in entity catalog but no fb-entity yaml exists.
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    });
    expect(summary.entitiesSkippedNoFbYaml).toBe(1);
    expect(summary.entitiesWritten).toBe(0);
  });

  it('is idempotent — running twice produces byte-identical output', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');
    const opts = {
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    };
    await syncScorecardFactsToYaml(opts);
    const before = readFileSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'), 'utf-8');
    await syncScorecardFactsToYaml(opts);
    const after = readFileSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'), 'utf-8');
    expect(after).toBe(before);
  });

  it('removes stale managed files when an entity drops from the latest grades', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');
    // Run once to create the managed file.
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    });
    expect(existsSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'))).toBe(true);

    // Run again with empty grades — file should be removed.
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [],
    });

    expect(summary.removed).toBe(1);
    expect(existsSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'))).toBe(false);
    // And the entity should be folded back to single-file form because
    // entity.yaml is the only thing left in the dir.
    expect(existsSync(join(tmp, 'anthropic.yaml'))).toBe(true);
    expect(existsSync(join(tmp, 'anthropic'))).toBe(false);
  });

  it('overwrites a previous wave\'s grade when the predicate-source pair has new data', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');
    // First wave.
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth', scoreRaw: 'C+', publishedAt: '2024-12-01' })],
    });
    // Second wave (replaces the first because we filter on is_latest=true).
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth', scoreRaw: 'B-', publishedAt: '2025-12-02' })],
    });

    const facts = readManagedFile(join(tmp, 'anthropic', 'scorecard-grades.yaml'));
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('B-');
    expect(facts[0].asOf).toBe('2025-12-02');
  });

  it('--dry-run does not touch the filesystem', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
      dryRun: true,
    });
    expect(summary.entitiesWritten).toBe(1);
    // Original single-file entity must not have been migrated.
    expect(existsSync(join(tmp, 'anthropic.yaml'))).toBe(true);
    expect(existsSync(join(tmp, 'anthropic'))).toBe(false);
  });

  it('handles empty input gracefully', async () => {
    const summary = await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [],
      grades: [],
    });
    expect(summary.entitiesWritten).toBe(0);
    expect(summary.removed).toBe(0);
  });

  it('groups multiple sources for the same entity into one file', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\n', 'utf-8');
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
    const facts = readManagedFile(join(tmp, 'anthropic', 'scorecard-grades.yaml'));
    expect(facts).toHaveLength(2);
    expect(facts.map(f => f.property).sort()).toEqual(['fli-index-grade', 'saferai-grade']);
  });

  it('produces a valid YAML file the loader can parse', async () => {
    writeFileSync(join(tmp, 'anthropic.yaml'), 'entity: sid_anth\nname: Anthropic\n', 'utf-8');
    await syncScorecardFactsToYaml({
      fbEntitiesDir: tmp,
      entities: [makeEntity('anthropic', 'sid_anth')],
      grades: [makeGrade({ entityId: 'sid_anth' })],
    });
    // Sanity: js-yaml round-trip must be lossless on the produced file.
    const written = readFileSync(join(tmp, 'anthropic', 'scorecard-grades.yaml'), 'utf-8');
    const parsed = yaml.load(written) as { facts: MirrorFact[] };
    expect(parsed).toHaveProperty('facts');
    expect(Array.isArray(parsed.facts)).toBe(true);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0].property).toBe('fli-index-grade');
  });
});
