import { describe, it, expect } from 'vitest';
import { escapeMdx } from './docs.ts';

describe('escapeMdx', () => {
  it('escapes a literal backslash to a double backslash', () => {
    expect(escapeMdx('a\\b')).toBe('a\\\\b');
  });

  it('escapes a lone backslash', () => {
    expect(escapeMdx('\\')).toBe('\\\\');
  });

  it('escapes a dollar sign', () => {
    expect(escapeMdx('$5')).toBe('\\$5');
  });

  it('escapes a bare < followed by a lowercase letter', () => {
    expect(escapeMdx('<a')).toBe('\\<a');
  });

  it('escapes the backslash before the dollar so the result is not double-escaped wrongly', () => {
    // Input "\$" => backslash escaped first to "\\$", then $ escaped to "\\\$"
    expect(escapeMdx('\\$')).toBe('\\\\\\$');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeMdx('hello world')).toBe('hello world');
  });
});
