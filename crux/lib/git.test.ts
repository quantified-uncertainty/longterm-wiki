import { describe, it, expect } from 'vitest';
import { isValidBranchName } from './git.ts';

describe('isValidBranchName', () => {
  it('accepts typical branch names', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('feature/add-login')).toBe(true);
    expect(isValidBranchName('claude/kind-jepsen')).toBe(true);
    expect(isValidBranchName('auto-update/2026-03-04')).toBe(true);
    expect(isValidBranchName('fix_underscore')).toBe(true);
    expect(isValidBranchName('v1.2.3')).toBe(true);
  });

  it('rejects empty and overly long names', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('a'.repeat(256))).toBe(false);
  });

  it('rejects names with shell-dangerous characters', () => {
    expect(isValidBranchName('branch; rm -rf /')).toBe(false);
    expect(isValidBranchName('branch$(whoami)')).toBe(false);
    expect(isValidBranchName('branch`id`')).toBe(false);
    expect(isValidBranchName('branch|cat')).toBe(false);
    expect(isValidBranchName('branch name with spaces')).toBe(false);
    expect(isValidBranchName("branch'quote")).toBe(false);
    expect(isValidBranchName('branch"quote')).toBe(false);
  });

  it('accepts names at the boundary length', () => {
    expect(isValidBranchName('a'.repeat(255))).toBe(true);
  });
});
