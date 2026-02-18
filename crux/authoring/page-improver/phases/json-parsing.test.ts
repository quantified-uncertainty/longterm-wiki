import { describe, it, expect } from 'vitest';
import { parseJsonFromLlm } from './json-parsing.ts';

// Fallback factory used in all tests
const fallback = (raw: string, error?: string) => ({ sources: [], error, raw });

describe('parseJsonFromLlm', () => {
  it('parses a valid JSON object', () => {
    const raw = '{"sources":[{"topic":"t","title":"T","url":"u","facts":["f"],"relevance":"high"}],"summary":"ok"}';
    const result = parseJsonFromLlm<{ sources: unknown[]; summary?: string }>(raw, 'research', fallback);
    expect(result.sources).toHaveLength(1);
    expect(result.summary).toBe('ok');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"sources":[],"summary":"ok"}\n```';
    const result = parseJsonFromLlm<{ sources: unknown[] }>(raw, 'research', fallback);
    expect(result.sources).toEqual([]);
  });

  it('extracts JSON object embedded in prose', () => {
    const raw = 'Here is the result:\n{"sources":[],"summary":"done"}\nEnd of response.';
    const result = parseJsonFromLlm<{ sources: unknown[] }>(raw, 'research', fallback);
    expect(result.sources).toEqual([]);
  });

  it('recovers partial sources array from truncated JSON', () => {
    // Simulate a truncated response: the JSON is cut off after the first source object
    const raw = `{
  "sources": [
    {
      "topic": "AI risk",
      "title": "Source A",
      "url": "https://example.com/a",
      "facts": ["fact 1"],
      "relevance": "high"
    },
    {
      "topic": "AI policy"`;  // truncated mid-object
    const result = parseJsonFromLlm<{ sources: unknown[]; error?: string }>(raw, 'research', fallback);
    // Should recover the first complete source
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect((result.sources[0] as { title: string }).title).toBe('Source A');
  });

  it('returns fallback when JSON is completely unparseable', () => {
    const raw = 'This is not JSON at all, just plain text.';
    const result = parseJsonFromLlm<{ sources: unknown[]; error?: string }>(raw, 'research', fallback);
    expect(result.sources).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('recovers multiple complete sources from truncated JSON', () => {
    const source = (n: number) => `{
      "topic": "topic${n}",
      "title": "Source ${n}",
      "url": "https://example.com/${n}",
      "facts": ["fact"],
      "relevance": "high"
    }`;
    const raw = `{"sources":[${source(1)},${source(2)},${source(3)},{"topic":"trunc`; // truncated
    const result = parseJsonFromLlm<{ sources: unknown[] }>(raw, 'research', fallback);
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.sources.length).toBeGreaterThanOrEqual(3);
  });
});
