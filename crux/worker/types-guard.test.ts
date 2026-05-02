import { describe, it, expect } from 'vitest';
import {
  assertConfiguredTypesAreRegistered,
  WorkerTypesGuardError,
} from './types-guard.ts';
import { getRegisteredTypes } from '../lib/job-handlers/index.ts';

describe('assertConfiguredTypesAreRegistered', () => {
  it('passes when every configured type is registered', () => {
    expect(() =>
      assertConfiguredTypesAreRegistered(
        ['ping', 'page-improve'],
        ['ping', 'page-improve', 'page-create'],
      ),
    ).not.toThrow();
  });

  it('passes when configured list is empty (claim-any-type mode)', () => {
    expect(() => assertConfiguredTypesAreRegistered([], ['ping'])).not.toThrow();
    // Even with an empty registered list, empty configured = no validation.
    expect(() => assertConfiguredTypesAreRegistered([], [])).not.toThrow();
  });

  it('throws WorkerTypesGuardError when a single type is unregistered', () => {
    expect(() =>
      assertConfiguredTypesAreRegistered(['claim-verification'], ['claim-sourcing', 'ping']),
    ).toThrow(WorkerTypesGuardError);
  });

  it('throws when any one of several configured types is unregistered', () => {
    let caught: unknown;
    try {
      assertConfiguredTypesAreRegistered(
        ['ping', 'claim-verification', 'page-improve'],
        ['ping', 'page-improve', 'claim-sourcing'],
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkerTypesGuardError);
    const err = caught as WorkerTypesGuardError;
    expect(err.unknown).toEqual(['claim-verification']);
    expect(err.message).toContain('claim-verification');
    expect(err.message).toContain('values.yaml');
  });

  it('reports every unknown type, not just the first', () => {
    let caught: unknown;
    try {
      assertConfiguredTypesAreRegistered(['a', 'b', 'c'], ['ping']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkerTypesGuardError);
    const err = caught as WorkerTypesGuardError;
    expect(err.unknown).toEqual(['a', 'b', 'c']);
    expect(err.message).toContain('a, b, c');
  });

  it('does not throw on duplicate registered entries', () => {
    expect(() =>
      assertConfiguredTypesAreRegistered(['ping'], ['ping', 'ping', 'ping']),
    ).not.toThrow();
  });

  // QUA-1041 acceptance test: every type currently in
  // ops/k8s/apps/longterm-wiki-worker/values.yaml --types arg must have
  // a registered handler. This is the canary that catches a registry
  // rename that misses the k8s args (QUA-699 / QUA-1039 class of bug).
  // Update both lists together when adding/renaming types.
  it('every job type in the prod worker --types arg has a registered handler', () => {
    const prodWorkerTypes = [
      'claim-sourcing',
      'citation-verify',
      'resource-verify',
      'resource-enrich',
      'resource-ingest',
      'ping',
    ];
    expect(() =>
      assertConfiguredTypesAreRegistered(prodWorkerTypes, getRegisteredTypes()),
    ).not.toThrow();
  });
});
