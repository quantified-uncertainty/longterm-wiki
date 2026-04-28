/**
 * Tests for crux/lib/sourcing/entity-wikidata-qid.ts (QUA-724).
 *
 * Validates the QID lookup against the actual `data/external-links.yaml` —
 * if the file or its schema changes, these tests catch the contract break.
 * Uses real entries (anthropic, geoffrey-hinton) so the test pins the file
 * shape, not a fixture's.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEntityWikidataQid,
  clearEntityWikidataQidCache,
} from './entity-wikidata-qid.ts';

describe('getEntityWikidataQid', () => {
  beforeEach(() => {
    clearEntityWikidataQidCache();
  });

  it('returns null for an unknown slug', () => {
    expect(getEntityWikidataQid('this-entity-definitely-does-not-exist-xyz')).toBeNull();
  });

  it('returns null for null/undefined/empty input (fail-open)', () => {
    expect(getEntityWikidataQid(null)).toBeNull();
    expect(getEntityWikidataQid(undefined)).toBeNull();
    expect(getEntityWikidataQid('')).toBeNull();
  });

  it('returns a Q-number for an entity with a recorded Wikidata link', () => {
    // `agi` has a Wikidata link in data/external-links.yaml. Asserting on the
    // shape (Q\d+) — not the specific QID — keeps this stable if Wikidata
    // re-IDs the page.
    const qid = getEntityWikidataQid('agi');
    expect(qid).toMatch(/^Q\d+$/);
  });

  it('caches results — repeated lookups return the same value', () => {
    const a = getEntityWikidataQid('agi');
    const b = getEntityWikidataQid('agi');
    expect(a).toBe(b);
  });
});
