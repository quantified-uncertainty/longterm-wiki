import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getGitHubToken,
  isMissingTokenError,
  MissingTokenError,
  MISSING_TOKEN_HELP_MESSAGE,
} from './github.ts';

// Use `vi.stubEnv()` instead of mutating `process.env` directly. stubEnv is
// scoped per-test and reset by `vi.unstubAllEnvs()`, so parallel workers
// reading GITHUB_TOKEN (e.g. enriched-scan.test.ts) don't race with this
// file's mutations.
describe('getGitHubToken', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws MissingTokenError when GITHUB_TOKEN is undefined', () => {
    vi.stubEnv('GITHUB_TOKEN', undefined as unknown as string);
    expect(() => getGitHubToken()).toThrow(MissingTokenError);
  });

  it('throws MissingTokenError when GITHUB_TOKEN is the empty string', () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    expect(() => getGitHubToken()).toThrow(MissingTokenError);
  });

  it('throws MissingTokenError when GITHUB_TOKEN is whitespace-only', () => {
    // Regression: whitespace-only values used to pass the truthy check and
    // reach the GitHub API verbatim, producing a transient-looking 401 instead
    // of immediate permanent-fault classification. See QUA-482 minor review.
    vi.stubEnv('GITHUB_TOKEN', '   ');
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
    vi.stubEnv('GITHUB_TOKEN', '\t\n  \t');
    expect(() => getGitHubToken()).toThrow(MissingTokenError);
  });

  it('returns the token when GITHUB_TOKEN is a valid value', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_abc123');
    expect(getGitHubToken()).toBe('ghp_abc123');
  });

  it('returns the trimmed token when GITHUB_TOKEN has surrounding whitespace', () => {
    // Common when users do `GITHUB_TOKEN=$(cat token.txt)` with a trailing
    // newline. Previously sent verbatim and returned 401; now trimmed.
    vi.stubEnv('GITHUB_TOKEN', '  ghp_abc123\n');
    expect(getGitHubToken()).toBe('ghp_abc123');
  });
});

describe('MissingTokenError', () => {
  it('has name === "MissingTokenError" for serialized classification', () => {
    // Load-bearing: downstream log/telemetry code that JSON-serializes errors
    // or crosses a subprocess boundary loses `instanceof` and must rely on
    // `.name`. Pin this so a rename can't silently break classifiers.
    const err = new MissingTokenError();
    expect(err.name).toBe('MissingTokenError');
  });

  it('uses the shared MISSING_TOKEN_HELP_MESSAGE', () => {
    const err = new MissingTokenError();
    expect(err.message).toBe(MISSING_TOKEN_HELP_MESSAGE);
  });

  it('extends Error so stack traces work', () => {
    const err = new MissingTokenError();
    expect(err).toBeInstanceOf(Error);
    expect(err.stack).toBeTruthy();
  });
});

describe('isMissingTokenError', () => {
  it('accepts real MissingTokenError instances', () => {
    expect(isMissingTokenError(new MissingTokenError())).toBe(true);
  });

  it('accepts serialized errors with matching .name (cross-realm / JSON roundtrip)', () => {
    // A real scenario: a subprocess throws MissingTokenError, the parent
    // captures stderr, reconstructs the error as a plain object, and hands
    // it to the classifier. `instanceof` fails across the boundary — only
    // `.name` survives. The classifier must still recognize it.
    const serialized = { name: 'MissingTokenError', message: 'anything' };
    expect(isMissingTokenError(serialized)).toBe(true);

    const roundTripped = JSON.parse(
      JSON.stringify({ name: 'MissingTokenError', message: 'x' }),
    );
    expect(isMissingTokenError(roundTripped)).toBe(true);
  });

  it('rejects plain Error instances, even with matching message content', () => {
    // QUA-482: the whole point of the refactor is that a plain Error whose
    // message happens to contain "GITHUB_TOKEN not set" must NOT be classified
    // as a missing-token error. Guard against future regressions.
    expect(isMissingTokenError(new Error(MISSING_TOKEN_HELP_MESSAGE))).toBe(false);
    expect(
      isMissingTokenError(
        new Error('upstream log: "GITHUB_TOKEN not set" appeared'),
      ),
    ).toBe(false);
  });

  it('rejects non-error falsy / primitive values', () => {
    expect(isMissingTokenError(null)).toBe(false);
    expect(isMissingTokenError(undefined)).toBe(false);
    expect(isMissingTokenError('MissingTokenError')).toBe(false);
    expect(isMissingTokenError(42)).toBe(false);
    expect(isMissingTokenError({})).toBe(false);
  });
});
