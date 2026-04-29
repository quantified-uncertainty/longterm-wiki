import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getGitHubToken,
  isMissingTokenError,
  MissingTokenError,
  MISSING_TOKEN_HELP_MESSAGE,
  MISSING_TOKEN_SUMMARY,
  requireGitHubTokenOrExit,
} from './github.ts';

// Use `vi.stubEnv()` instead of mutating `process.env` directly. This is
// the vitest-blessed pattern for per-test env overrides and is auto-reverted
// by `vi.unstubAllEnvs()` in afterEach. `crux/vitest.config.ts` currently
// sets `fileParallelism: false` so there is no active cross-file race, but
// stubEnv is still safer if that config ever flips — and it makes the
// test's scope explicit without a hand-rolled save/restore in beforeEach.
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

  it('MISSING_TOKEN_HELP_MESSAGE is derived from MISSING_TOKEN_SUMMARY so they cannot drift', () => {
    // Regression for QUA-511: the ~8 display call sites (health-check summaries,
    // pr-patrol error logs, etc.) read MISSING_TOKEN_SUMMARY for short labels
    // and MISSING_TOKEN_HELP_MESSAGE for full help text. If the full message
    // ever stops starting with the summary, users see inconsistent labeling
    // between summary and detail views.
    expect(MISSING_TOKEN_HELP_MESSAGE.startsWith(MISSING_TOKEN_SUMMARY)).toBe(true);
    expect(MISSING_TOKEN_SUMMARY).toBe('GITHUB_TOKEN not set');
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

  it('accepts serialized errors with matching .name AND string .message', () => {
    // Real scenario: a subprocess throws MissingTokenError, the parent
    // captures stderr, reconstructs the error as a plain object, and hands
    // it to the classifier. `instanceof` fails across the boundary — only
    // `.name` and `.message` survive. The classifier must still recognize it.
    const serialized = { name: 'MissingTokenError', message: 'anything' };
    expect(isMissingTokenError(serialized)).toBe(true);

    // Real JSON roundtrip — the form `JSON.stringify(new MissingTokenError())`
    // produces once the error is passed through structured clone or rebuilt
    // from `Error.toJSON()` output.
    const roundTripped = JSON.parse(
      JSON.stringify({ name: 'MissingTokenError', message: 'x' }),
    );
    expect(isMissingTokenError(roundTripped)).toBe(true);
  });

  it('rejects bare {name} objects without a string message (duck-typing guard)', () => {
    // Security: the serialized-error branch must not accept arbitrary
    // attacker-crafted JSON blobs that happen to set `name`. Real serialized
    // errors always carry a `.message` — require it to narrow the false-
    // positive surface.
    expect(isMissingTokenError({ name: 'MissingTokenError' })).toBe(false);
    expect(
      isMissingTokenError({ name: 'MissingTokenError', message: 123 }),
    ).toBe(false);
    expect(
      isMissingTokenError({ name: 'MissingTokenError', message: null }),
    ).toBe(false);
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

// Shared preflight used by every long-running patrol entry point — see
// QUA-799 for the silent-degradation incident that motivated extracting this
// from three duplicated copies in the patrol code.
describe('requireGitHubTokenOrExit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not log or exit when GITHUB_TOKEN is set', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_abc123');
    const logs: string[] = [];
    const exits: number[] = [];
    requireGitHubTokenOrExit(
      (msg) => logs.push(msg),
      ((code: number) => {
        exits.push(code);
        return undefined as never;
      }),
    );
    expect(logs).toHaveLength(0);
    expect(exits).toHaveLength(0);
  });

  it('logs the canonical summary and calls exit(1) when GITHUB_TOKEN is missing', () => {
    vi.stubEnv('GITHUB_TOKEN', undefined as unknown as string);
    const logs: string[] = [];
    const exits: number[] = [];
    requireGitHubTokenOrExit(
      (msg) => logs.push(msg),
      ((code: number) => {
        exits.push(code);
        return undefined as never;
      }),
    );
    expect(logs).toEqual([`ERROR: ${MISSING_TOKEN_SUMMARY}`]);
    expect(exits).toEqual([1]);
  });

  it('logs and exits when GITHUB_TOKEN is whitespace-only (delegates to getGitHubToken)', () => {
    vi.stubEnv('GITHUB_TOKEN', '   \n');
    const logs: string[] = [];
    const exits: number[] = [];
    requireGitHubTokenOrExit(
      (msg) => logs.push(msg),
      ((code: number) => {
        exits.push(code);
        return undefined as never;
      }),
    );
    expect(exits).toEqual([1]);
    expect(logs[0]).toContain(MISSING_TOKEN_SUMMARY);
  });
});
