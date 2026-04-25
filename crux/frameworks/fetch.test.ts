import { describe, it, expect } from 'vitest';
import { classifyIngest } from './fetch.ts';

describe('classifyIngest', () => {
  it('treats a missing hash as fetch_failed', () => {
    expect(classifyIngest('abc', null, true)).toBe('fetch_failed');
  });

  it('treats a first-sight hash as new_version', () => {
    expect(classifyIngest(null, 'abc', false)).toBe('new_version');
  });

  it('treats a matching hash as unchanged', () => {
    expect(classifyIngest('abc', 'abc', true)).toBe('unchanged');
  });

  it('detects silent update when label is unchanged but hash differs', () => {
    expect(classifyIngest('abc', 'def', true)).toBe('silent_update_detected');
  });

  it('treats differing hash with differing label as new_version', () => {
    expect(classifyIngest('abc', 'def', false)).toBe('new_version');
  });
});
