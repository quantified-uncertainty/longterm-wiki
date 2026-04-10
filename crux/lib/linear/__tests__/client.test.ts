import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectCorruption, linearGraphQL, linearIssueUrl } from '../client.ts';

describe('detectCorruption', () => {
  it('flags ANSI escape sequences', () => {
    expect(detectCorruption('hello \x1b[31mred\x1b[0m')).toMatch(/ANSI/);
  });

  it('flags dotenv injection output', () => {
    expect(detectCorruption('[dotenv] injecting env from .env')).toMatch(/dotenv/);
  });

  it('flags shell "command not found" output', () => {
    expect(detectCorruption('/tmp/foo.sh: command not found')).toMatch(/shell error/);
  });

  it('flags 4+ consecutive asterisks from broken bold markup', () => {
    expect(detectCorruption('see **** for details')).toMatch(/corrupted bold/);
  });

  it('passes clean text', () => {
    expect(detectCorruption('Normal text with *one* and **two** stars')).toBeNull();
    expect(detectCorruption('')).toBeNull();
  });
});

describe('linearIssueUrl', () => {
  it('builds the canonical URL for an identifier', () => {
    expect(linearIssueUrl('QUA-184')).toBe(
      'https://linear.app/quantifieduncertainty/issue/QUA-184'
    );
  });
});

describe('linearGraphQL transport', () => {
  let originalFetch: typeof fetch;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalKey;
  });

  it('throws when LINEAR_API_KEY is missing', async () => {
    delete process.env.LINEAR_API_KEY;
    await expect(linearGraphQL('query { viewer { id } }')).rejects.toThrow(/LINEAR_API_KEY/);
  });

  it('sends the Authorization header with the raw key (no Bearer prefix)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await linearGraphQL('query { viewer { id } }');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('lin_test_key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('rejects request variables containing ANSI codes (corruption check)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      linearGraphQL('mutation X($body: String!) { x(body: $body) }', {
        body: 'hello \x1b[31mred\x1b[0m',
      })
    ).rejects.toThrow(/corruption check/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces GraphQL errors from the response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ errors: [{ message: 'Not authorized' }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    await expect(linearGraphQL('query { x }')).rejects.toThrow(/Not authorized/);
  });

  it('surfaces HTTP errors with the response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('internal error details', { status: 500 })
    ) as unknown as typeof fetch;

    await expect(linearGraphQL('query { x }')).rejects.toThrow(/500.*internal error details/);
  });

  it('returns the data field on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: 'u1' } } }), { status: 200 })
    ) as unknown as typeof fetch;

    const result = await linearGraphQL<{ viewer: { id: string } }>(
      'query { viewer { id } }'
    );
    expect(result.viewer.id).toBe('u1');
  });

  it('throws when response has no data and no errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(linearGraphQL('query { x }')).rejects.toThrow(/no data/);
  });
});
