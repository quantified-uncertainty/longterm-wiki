import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getGitHubToken, MissingTokenError, isMissingTokenError } from './github.ts';

describe('getGitHubToken', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('throws MissingTokenError when GITHUB_TOKEN is undefined', () => {
    delete process.env.GITHUB_TOKEN;
    expect(() => getGitHubToken()).toThrow(MissingTokenError);
  });

  it('throws MissingTokenError when GITHUB_TOKEN is the empty string', () => {
    process.env.GITHUB_TOKEN = '';
    expect(() => getGitHubToken()).toThrow(MissingTokenError);
  });

  it('throws MissingTokenError when GITHUB_TOKEN is whitespace-only', () => {
    // Regression: whitespace-only values used to pass the truthy check and
    // reach the GitHub API verbatim, producing a transient-looking 401 instead
    // of immediate permanent-fault classification. See QUA-482 minor review.
    process.env.GITHUB_TOKEN = '   ';
    let caught: unknown;
    try {
      getGitHubToken();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingTokenError);
    expect(isMissingTokenError(caught)).toBe(true);
  });

  it('throws MissingTokenError when GITHUB_TOKEN is tabs and newlines only', () => {
    process.env.GITHUB_TOKEN = '\t\n  \t';
    expect(() => getGitHubToken()).toThrow(MissingTokenError);
  });

  it('returns the token when GITHUB_TOKEN is a valid value', () => {
    process.env.GITHUB_TOKEN = 'ghp_abc123';
    expect(getGitHubToken()).toBe('ghp_abc123');
  });

  it('returns the trimmed token when GITHUB_TOKEN has surrounding whitespace', () => {
    process.env.GITHUB_TOKEN = '  ghp_abc123\n';
    expect(getGitHubToken()).toBe('ghp_abc123');
  });
});
