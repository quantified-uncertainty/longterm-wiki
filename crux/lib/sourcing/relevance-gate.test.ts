/**
 * Tests for the pre-LLM relevance gate (QUA-426).
 *
 * Covers:
 * - Subject extraction per record type
 * - Content normalization (case, unicode, whitespace)
 * - Short-content bypass
 * - Short-subject bypass
 * - Missing-anchor pass-through
 * - Positive / negative match cases
 * - The env-flag helper
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  extractSubjects,
  normalizeForMatch,
  runRelevanceGate,
  isRelevanceGateEnabled,
} from './relevance-gate.ts';
import type { RecordItemData } from './orchestrator-types.ts';

function personnel(
  person: string | null,
  org: string | null,
  entityDisplayName: string | null = null,
): RecordItemData {
  return {
    kind: 'record',
    recordType: 'personnel',
    recordId: 'p_test',
    fields: { person, org, role: 'CEO' },
    entityId: 'e_test',
    displayName: `${person ?? 'x'} at ${org ?? 'x'}`,
    entityDisplayName,
  };
}

function grant(
  grantee: string | null,
  funder: string | null,
  name: string | null,
): RecordItemData {
  return {
    kind: 'record',
    recordType: 'grant',
    recordId: 'g_test',
    fields: { grantee, funder, name, amount: 1000000, date: null },
    entityId: 'e_test',
    displayName: name,
    entityDisplayName: funder,
  };
}

describe('normalizeForMatch', () => {
  it('lowercases and trims whitespace', () => {
    expect(normalizeForMatch('  Anthropic Inc.  ')).toBe('anthropic inc.');
  });

  it('collapses multiple whitespace runs', () => {
    expect(normalizeForMatch('foo   bar\n\tbaz')).toBe('foo bar baz');
  });

  it('does NOT strip diacritics (keeps CJK/accented matches faithful)', () => {
    // Stripping would make "Lê Viết Quốc" match "Le Viet Quoc" — a false positive
    // when the source is a different person with the ASCII name.
    expect(normalizeForMatch('Lê Viết Quốc')).toBe('lê viết quốc');
  });

  it('applies NFC normalization so composed and decomposed forms collide', () => {
    // "é" can be represented as U+00E9 or as U+0065 + U+0301.
    const composed = '\u00e9clair'; // é
    const decomposed = 'e\u0301clair'; // e + ◌́
    expect(normalizeForMatch(composed)).toBe(normalizeForMatch(decomposed));
  });
});

describe('extractSubjects — personnel', () => {
  it('returns person + org when both are resolvable', () => {
    const s = extractSubjects(personnel('Amanda Askell', 'Anthropic'));
    expect(s).toEqual(['Amanda Askell', 'Anthropic']);
  });

  it('drops the `(unknown)` sentinel', () => {
    const s = extractSubjects(personnel('(unknown)', 'Anthropic'));
    expect(s).toEqual(['Anthropic']);
  });

  it('drops stableId-shaped values that leaked through name resolution', () => {
    const s = extractSubjects(personnel('sid_1LcLlMGLbw', 'Anthropic'));
    expect(s).toEqual(['Anthropic']);
  });

  it('returns empty list when nothing is resolvable', () => {
    const s = extractSubjects(personnel(null, null));
    expect(s).toEqual([]);
  });
});

describe('extractSubjects — grants', () => {
  it('returns grantee + funder + grant title', () => {
    const s = extractSubjects(
      grant('Alice Researcher', 'Open Philanthropy', 'AI safety evals'),
    );
    expect(s).toContain('Alice Researcher');
    expect(s).toContain('Open Philanthropy');
    expect(s).toContain('AI safety evals');
  });
});

describe('extractSubjects — record types without an extractor', () => {
  it('returns an empty list for division', () => {
    const data: RecordItemData = {
      kind: 'record',
      recordType: 'division',
      recordId: 'd_test',
      fields: { name: 'Frontier Research', type: 'research', status: 'active' },
      entityId: 'e_test',
    };
    expect(extractSubjects(data)).toEqual([]);
  });
});

describe('runRelevanceGate — pass-through cases', () => {
  const longContent = 'a'.repeat(2000);

  it('passes when the source content is too short to decide', () => {
    const short = 'Short page with just one line.';
    const result = runRelevanceGate(personnel('Amanda Askell', 'Anthropic'), short);
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/short_content/);
  });

  it('passes when no subject can be extracted', () => {
    const result = runRelevanceGate(personnel(null, null), longContent);
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('no_subject_extracted');
  });

  it('passes when all subjects are too short to substring-match', () => {
    const data = personnel('J', 'Wu');
    const result = runRelevanceGate(data, longContent);
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/no_matchable_subject/);
  });
});

describe('runRelevanceGate — positive matches', () => {
  it('passes when the person name appears in content', () => {
    const content = `${'filler '.repeat(200)} Amanda Askell is the Character Lead at Anthropic. ${'more '.repeat(100)}`;
    const result = runRelevanceGate(personnel('Amanda Askell', 'Anthropic'), content);
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/matched:Amanda Askell/);
  });

  it('passes when only the org anchor is present (common-name fallback)', () => {
    // Homepage-style content: mentions Anthropic a lot but not Amanda.
    // This is the CASE THE TICKET CALLS OUT, but here Anthropic is still
    // a valid anchor so we pass. Subject-specificity is the LLM's job —
    // the gate only asks "is there any reason to even run it?"
    const content = `${'Anthropic builds safer AI systems. '.repeat(50)}`;
    const result = runRelevanceGate(personnel('Amanda Askell', 'Anthropic'), content);
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/matched:Anthropic/);
  });

  it('is case-insensitive', () => {
    const content = `${'x '.repeat(300)} amanda ASKELL is the character lead. ${'y '.repeat(100)}`;
    const result = runRelevanceGate(personnel('Amanda Askell', 'Anthropic'), content);
    expect(result.passed).toBe(true);
  });
});

describe('runRelevanceGate — negative matches (the noise cases we want to kill)', () => {
  it('fires when neither person nor org appears in long content', () => {
    const content = `${'Content about something entirely different. '.repeat(100)}`;
    const result = runRelevanceGate(personnel('Amanda Askell', 'Anthropic'), content);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/no_subject_match/);
    expect(result.subjects).toEqual(['Amanda Askell', 'Anthropic']);
  });

  it('fires on grant with no grantee/funder/title mentions', () => {
    const content = `${'An article about climate change. '.repeat(100)}`;
    const result = runRelevanceGate(
      grant('Alice Researcher', 'Open Philanthropy', 'AI evals project'),
      content,
    );
    expect(result.passed).toBe(false);
  });
});

describe('isRelevanceGateEnabled', () => {
  afterEach(() => {
    delete process.env.RELEVANCE_GATE_ENABLED;
  });

  it('returns false by default', () => {
    expect(isRelevanceGateEnabled()).toBe(false);
  });

  it('returns true when explicitly set to "true"', () => {
    process.env.RELEVANCE_GATE_ENABLED = 'true';
    expect(isRelevanceGateEnabled()).toBe(true);
  });

  it('returns true when set to "1"', () => {
    process.env.RELEVANCE_GATE_ENABLED = '1';
    expect(isRelevanceGateEnabled()).toBe(true);
  });

  it('returns false for other truthy-ish values', () => {
    process.env.RELEVANCE_GATE_ENABLED = 'yes';
    expect(isRelevanceGateEnabled()).toBe(false);
  });
});
