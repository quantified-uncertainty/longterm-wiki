import { describe, it, expect } from 'vitest';
import { getActiveProviders, isProviderActiveForType } from './entity-type-routing.ts';

describe('entity-type-routing', () => {
  describe('getActiveProviders', () => {
    it('returns github for organization', () => {
      expect(getActiveProviders('organization')).toEqual(['github']);
    });

    it('returns semantic-scholar for person', () => {
      expect(getActiveProviders('person')).toEqual(['semantic-scholar']);
    });

    it('returns github for project', () => {
      expect(getActiveProviders('project')).toEqual(['github']);
    });

    it('returns github + semantic-scholar for ai-model', () => {
      expect(getActiveProviders('ai-model')).toEqual(['github', 'semantic-scholar']);
    });

    it('returns federal-register for policy', () => {
      expect(getActiveProviders('policy')).toEqual(['federal-register']);
    });

    it('returns semantic-scholar for concept', () => {
      expect(getActiveProviders('concept')).toEqual(['semantic-scholar']);
    });

    it('returns semantic-scholar for approach', () => {
      expect(getActiveProviders('approach')).toEqual(['semantic-scholar']);
    });

    it('returns github + semantic-scholar for benchmark', () => {
      expect(getActiveProviders('benchmark')).toEqual(['github', 'semantic-scholar']);
    });

    it('returns empty array for unknown entity type', () => {
      expect(getActiveProviders('risk')).toEqual([]);
    });

    it('returns empty array for undefined entity type', () => {
      expect(getActiveProviders(undefined)).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(getActiveProviders('')).toEqual([]);
    });
  });

  describe('isProviderActiveForType', () => {
    it('returns true for github + organization', () => {
      expect(isProviderActiveForType('github', 'organization')).toBe(true);
    });

    it('returns false for github + person', () => {
      expect(isProviderActiveForType('github', 'person')).toBe(false);
    });

    it('returns true for semantic-scholar + ai-model', () => {
      expect(isProviderActiveForType('semantic-scholar', 'ai-model')).toBe(true);
    });

    it('returns false for federal-register + organization', () => {
      expect(isProviderActiveForType('federal-register', 'organization')).toBe(false);
    });

    it('returns false for any provider when entityType is undefined', () => {
      expect(isProviderActiveForType('github', undefined)).toBe(false);
    });
  });
});
