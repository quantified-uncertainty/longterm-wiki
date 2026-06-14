/**
 * Unit tests for LLM payload capture (step 1b).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRecord = vi.fn();
vi.mock('../wiki-server/llm-payloads.ts', () => ({
  recordLlmPayload: (...args: unknown[]) => mockRecord(...args),
}));

import { capturePayload } from './capture-payload.ts';
import { runWithAmbientContext } from './ambient-tracker.ts';
import { CostTracker } from '../cost-tracker.ts';

const baseInput = {
  model: 'claude-haiku-4-5-20251001',
  request: { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
  response: 'hello',
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('capturePayload', () => {
  beforeEach(() => {
    mockRecord.mockReset().mockResolvedValue({ ok: true, data: { id: 1 } });
    delete process.env.LLM_PAYLOAD_CAPTURE_RATE;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is off by default — no POST when rate is unset', () => {
    capturePayload(baseInput);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does not capture when rate is 0', () => {
    process.env.LLM_PAYLOAD_CAPTURE_RATE = '0';
    capturePayload(baseInput);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('captures at rate 1 and tags flow + runId from ambient context', () => {
    process.env.LLM_PAYLOAD_CAPTURE_RATE = '1';
    runWithAmbientContext(
      { tracker: new CostTracker(), flow: 'research-agent', runId: 'run-123' },
      () => capturePayload({ ...baseInput, label: 'verify' }),
    );
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const arg = mockRecord.mock.calls[0][0];
    expect(arg).toMatchObject({
      flow: 'research-agent',
      runId: 'run-123',
      label: 'verify',
      model: 'claude-haiku-4-5-20251001',
      response: 'hello',
      tokensInput: 10,
      tokensOutput: 5,
    });
  });

  it('respects the sample rate via Math.random', () => {
    process.env.LLM_PAYLOAD_CAPTURE_RATE = '0.5';
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // above 0.5 → skip
    capturePayload(baseInput);
    expect(mockRecord).not.toHaveBeenCalled();

    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0.1); // below 0.5 → capture
    capturePayload(baseInput);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('skips (does not clip) oversize calls so the corpus stays replayable', () => {
    process.env.LLM_PAYLOAD_CAPTURE_RATE = '1';
    capturePayload({ ...baseInput, response: 'x'.repeat(300_000) });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('never throws when the POST rejects', () => {
    process.env.LLM_PAYLOAD_CAPTURE_RATE = '1';
    mockRecord.mockRejectedValue(new Error('network down'));
    expect(() => capturePayload(baseInput)).not.toThrow();
  });
});
