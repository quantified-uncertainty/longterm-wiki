/**
 * Tests that bare stableId detection works correctly.
 * Source-check verdicts store entity IDs without the sid_ prefix.
 * The frontend must detect these and try the prefixed version.
 *
 * This is a CI-blocking test to prevent regression of the bug where
 * entity names showed as raw IDs (e.g. "fVMqY7vpMA" instead of "Bezos Earth Fund").
 */
import { describe, it, expect } from 'vitest';
import { isSid, isAnySid, SID_PREFIX, stripSid } from '../../../packages/id-utils/src/index.ts';

describe('bare stableId detection for sourcing entity resolution', () => {
  describe('isAnySid detects both formats', () => {
    it('detects sid_-prefixed IDs', () => {
      expect(isAnySid('sid_fVMqY7vpMA')).toBe(true);
      expect(isAnySid('sid_NPPTvNqRXA')).toBe(true);
      expect(isAnySid('sid_wHfFIBrPcA')).toBe(true);
    });

    it('detects bare 10-char IDs with uppercase letters', () => {
      expect(isAnySid('fVMqY7vpMA')).toBe(true);
      expect(isAnySid('NPPTvNqRXA')).toBe(true);
      expect(isAnySid('wHfFIBrPcA')).toBe(true);
      expect(isAnySid('ULjDXpSLCI')).toBe(true);
    });

    it('rejects non-stableId strings', () => {
      expect(isAnySid('hello-world')).toBe(false); // has hyphen
      expect(isAnySid('E1470')).toBe(false); // too short
      expect(isAnySid('my-entity-slug')).toBe(false); // not alphanumeric
      expect(isAnySid('')).toBe(false);
      expect(isAnySid(null)).toBe(false);
      expect(isAnySid(undefined)).toBe(false);
    });

    it('rejects 10-char strings without uppercase (not stableId format)', () => {
      expect(isAnySid('abcdefghij')).toBe(false); // all lowercase
      expect(isAnySid('1234567890')).toBe(false); // all digits
    });
  });

  describe('isSid only detects prefixed format', () => {
    it('detects sid_-prefixed IDs', () => {
      expect(isSid('sid_fVMqY7vpMA')).toBe(true);
    });

    it('rejects bare IDs', () => {
      expect(isSid('fVMqY7vpMA')).toBe(false);
    });
  });

  describe('sid_ prefix logic for entity resolution fallback', () => {
    it('can construct prefixed ID from bare ID', () => {
      const bareId = 'fVMqY7vpMA';
      expect(isSid(bareId)).toBe(false);
      expect(isAnySid(bareId)).toBe(true);

      // This is the fallback logic used in getTypedEntityByStableId and getEntityHref
      const prefixed = `${SID_PREFIX}${bareId}`;
      expect(prefixed).toBe('sid_fVMqY7vpMA');
      expect(isSid(prefixed)).toBe(true);
    });

    it('stripSid removes prefix correctly', () => {
      expect(stripSid('sid_fVMqY7vpMA')).toBe('fVMqY7vpMA');
      expect(stripSid('fVMqY7vpMA')).toBe('fVMqY7vpMA'); // no-op for bare IDs
    });

    it('real-world sourcing entity IDs are detected as bare stableIds', () => {
      // These are actual entity IDs found in production source_check_verdicts
      const productionEntityIds = [
        'fVMqY7vpMA', // Bezos Earth Fund
        'NPPTvNqRXA', // Foresight Institute
        'wHfFIBrPcA', // another org
        'ULjDXpSLCI', // from grants
      ];

      for (const id of productionEntityIds) {
        expect(isSid(id)).toBe(false); // not prefixed
        expect(isAnySid(id)).toBe(true); // detected as bare stableId
        expect(`${SID_PREFIX}${id}`).toMatch(/^sid_[A-Za-z0-9]{10}$/); // prefixed version is valid
      }
    });
  });
});
