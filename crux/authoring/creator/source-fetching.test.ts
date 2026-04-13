import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerResearchSources, extractUrls } from './source-fetching.ts';

// Mock the resource-lookup module so tests don't hit the real resource YAML.
// Default returns null (treat every URL as new).
vi.mock('../../lib/search/resource-lookup.ts', () => ({
  getResourceByUrl: vi.fn(() => null),
}));

interface TestContext {
  topicDir: string;
  saved: Record<string, string | object>;
  logs: Array<{ phase: string; message: string }>;
}

function makeContext(): { ctx: TestContext; phaseCtx: Parameters<typeof registerResearchSources>[1] } {
  const topicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-sources-test-'));
  const ctx: TestContext = { topicDir, saved: {}, logs: [] };
  const phaseCtx: Parameters<typeof registerResearchSources>[1] = {
    log: (phase: string, message: string) => {
      ctx.logs.push({ phase, message });
    },
    saveResult: (_topic: string, filename: string, data: string | object) => {
      ctx.saved[filename] = data;
      return path.join(topicDir, filename);
    },
    getTopicDir: (_topic: string) => topicDir,
  };
  return { ctx, phaseCtx };
}

describe('registerResearchSources — QUA-290 hard-fail behavior', () => {
  let ctx: TestContext;
  let phaseCtx: Parameters<typeof registerResearchSources>[1];

  beforeEach(() => {
    const made = makeContext();
    ctx = made.ctx;
    phaseCtx = made.phaseCtx;
  });

  afterEach(() => {
    if (ctx.topicDir && fs.existsSync(ctx.topicDir)) {
      fs.rmSync(ctx.topicDir, { recursive: true, force: true });
    }
  });

  it('throws when perplexity-research.json is missing', async () => {
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow(
      /no Perplexity research file found/,
    );
  });

  it('throws QUA-290-tagged error when research file is missing', async () => {
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow(/QUA-290/);
  });

  it('throws when research file exists but has zero citation URLs', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({ sources: [{ citations: [], content: 'some research' }] }),
    );
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow(
      /0 usable citation URLs/,
    );
  });

  it('throws when research file has only non-http citations', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({
        sources: [{ citations: ['not-a-url', 'ftp://example.com', '', null] }],
      }),
    );
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow(
      /0 usable citation URLs/,
    );
  });

  it('throws when sources array is empty', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({ sources: [] }),
    );
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow(
      /0 usable citation URLs/,
    );
  });

  it('throws when sources is missing entirely', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({}),
    );
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow(
      /0 usable citation URLs/,
    );
  });

  it('error mentions QUA-290 for traceability', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({ sources: [] }),
    );
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow(/QUA-290/);
  });

  it('succeeds when research file has at least one valid http URL', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({
        sources: [
          {
            citations: ['https://example.com/paper-1', 'https://anthropic.com/research'],
            content: 'research',
          },
        ],
      }),
    );

    const result = await registerResearchSources('test-topic', phaseCtx);
    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(ctx.saved['registered-sources.json']).toBeDefined();
  });

  it('does not write registered-sources.json when throwing', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({ sources: [] }),
    );
    await expect(registerResearchSources('test-topic', phaseCtx)).rejects.toThrow();
    expect(ctx.saved['registered-sources.json']).toBeUndefined();
  });

  it('deduplicates URLs across sources before counting', async () => {
    fs.writeFileSync(
      path.join(ctx.topicDir, 'perplexity-research.json'),
      JSON.stringify({
        sources: [
          { citations: ['https://example.com/a', 'https://example.com/b'] },
          { citations: ['https://example.com/a', 'https://example.com/c'] },
        ],
      }),
    );

    const result = await registerResearchSources('test-topic', phaseCtx);
    expect(result.total).toBe(3);
  });
});

describe('extractUrls — sanity check (existing behavior)', () => {
  it('extracts a single URL from text', () => {
    expect(extractUrls('see https://example.com here')).toEqual(['https://example.com']);
  });

  it('strips trailing punctuation', () => {
    expect(extractUrls('https://example.com, https://other.com.')).toEqual([
      'https://example.com',
      'https://other.com',
    ]);
  });
});
