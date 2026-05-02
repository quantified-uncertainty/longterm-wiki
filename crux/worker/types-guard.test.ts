import { describe, it, expect } from 'vitest';
import {
  assertConfiguredTypesAreRegistered,
  WorkerTypesGuardError,
} from './types-guard.ts';

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

  it('throws when registered list is empty but configured is not', () => {
    // Edge case: registry import failed or returned empty. Every configured
    // type is unknown.
    let caught: unknown;
    try {
      assertConfiguredTypesAreRegistered(['ping', 'foo'], []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkerTypesGuardError);
    expect((caught as WorkerTypesGuardError).unknown).toEqual(['ping', 'foo']);
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

  it('deduplicates the unknown list so the error message is clean', () => {
    let caught: unknown;
    try {
      assertConfiguredTypesAreRegistered(['foo', 'foo', 'bar'], ['ping']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkerTypesGuardError);
    expect((caught as WorkerTypesGuardError).unknown).toEqual(['foo', 'bar']);
  });

  it('does not throw on duplicate registered entries', () => {
    expect(() =>
      assertConfiguredTypesAreRegistered(['ping'], ['ping', 'ping', 'ping']),
    ).not.toThrow();
  });
});
