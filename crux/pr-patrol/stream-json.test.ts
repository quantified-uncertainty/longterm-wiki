import { describe, expect, it } from 'vitest';

import {
  buildOutput,
  newStreamJsonState,
  processStreamJsonLine,
} from './stream-json.ts';

const ASSISTANT_50K = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    usage: {
      input_tokens: 50_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [{ type: 'text', text: 'I will look at the failing test now.' }],
  },
});

const ASSISTANT_TEXT = (text: string, inputTokens = 1_000) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: { input_tokens: inputTokens, output_tokens: 50 },
      content: [{ type: 'text', text }],
    },
  });

const ASSISTANT_TOOL_USE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    usage: { input_tokens: 200, output_tokens: 5 },
    content: [
      {
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'pnpm test --run' },
      },
    ],
  },
});

const TOOL_RESULT = (text: string) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: text }],
    },
  });

const SYSTEM_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  model: 'claude-sonnet-4-6',
  cwd: '/tmp/wt',
  session_id: 'abc',
});

const RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'end_turn',
  num_turns: 3,
  duration_ms: 1234,
  total_cost_usd: 0.05,
  result: 'Done — pushed fix to claude/fix-1234. See https://github.com/x/y/pull/1234',
});

const RESULT_MAX_TURNS = JSON.stringify({
  type: 'result',
  subtype: 'error_max_turns',
  is_error: true,
  stop_reason: 'max_turns',
  num_turns: 60,
  duration_ms: 5_000,
  total_cost_usd: 0.5,
  result: 'Reached max turns. Stopping.',
});

describe('processStreamJsonLine', () => {
  it('accumulates input_tokens across assistant events', () => {
    const state = newStreamJsonState();
    processStreamJsonLine(ASSISTANT_TEXT('first', 1000), state, 50_000);
    processStreamJsonLine(ASSISTANT_TEXT('second', 2000), state, 50_000);
    processStreamJsonLine(ASSISTANT_TEXT('third', 3000), state, 50_000);
    expect(state.cumulativeInputTokens).toBe(6000);
  });

  it('appends assistant text to outputParts in order', () => {
    const state = newStreamJsonState();
    processStreamJsonLine(ASSISTANT_TEXT('first message'), state, 0);
    processStreamJsonLine(ASSISTANT_TEXT('second message'), state, 0);
    expect(buildOutput(state)).toBe('first message\nsecond message');
  });

  it('ignores empty / whitespace-only lines', () => {
    const state = newStreamJsonState();
    const a = processStreamJsonLine('', state, 0);
    const b = processStreamJsonLine('   ', state, 0);
    expect(a.stderrText).toBeNull();
    expect(b.stderrText).toBeNull();
    expect(state.outputParts).toEqual([]);
  });

  it('passes unparseable lines through (they may be claude warnings)', () => {
    const state = newStreamJsonState();
    const garbage = 'WARN: rate limit approaching';
    const effect = processStreamJsonLine(garbage, state, 0);
    expect(effect.stderrText).toBe(garbage);
    expect(state.outputParts).toEqual([garbage]);
  });

  it('flags budgetCrossedNow exactly once on the crossing event', () => {
    const state = newStreamJsonState();
    // Two assistant events of 25k each with cap 50k — second one crosses.
    const first = processStreamJsonLine(
      ASSISTANT_TEXT('a', 25_000),
      state,
      50_000,
    );
    const second = processStreamJsonLine(
      ASSISTANT_TEXT('b', 25_000),
      state,
      50_000,
    );
    expect(first.budgetCrossedNow).toBe(false);
    expect(second.budgetCrossedNow).toBe(true);
    expect(state.cumulativeInputTokens).toBe(50_000);

    // Subsequent events do NOT re-flag the cross — caller already killed.
    const third = processStreamJsonLine(
      ASSISTANT_TEXT('c', 10_000),
      state,
      50_000,
    );
    expect(third.budgetCrossedNow).toBe(false);
    expect(state.cumulativeInputTokens).toBe(60_000);
  });

  it('flags budgetCrossedNow when a single event crosses the cap', () => {
    const state = newStreamJsonState();
    const effect = processStreamJsonLine(ASSISTANT_50K, state, 50_000);
    expect(effect.budgetCrossedNow).toBe(true);
    expect(state.cumulativeInputTokens).toBe(50_000);
  });

  it('cap=0 disables the budget check', () => {
    const state = newStreamJsonState();
    const effect = processStreamJsonLine(ASSISTANT_TEXT('massive', 1_000_000), state, 0);
    expect(effect.budgetCrossedNow).toBe(false);
  });

  it('renders tool_use as a single-line preview to stderr', () => {
    const state = newStreamJsonState();
    const effect = processStreamJsonLine(ASSISTANT_TOOL_USE, state, 0);
    expect(effect.stderrText).toBe('[tool] Bash: pnpm test --run');
    // Tool calls do NOT contribute to backward-compat output.
    expect(buildOutput(state)).toBe('');
  });

  it('captures tool_result text into output for substring matching', () => {
    const state = newStreamJsonState();
    processStreamJsonLine(TOOL_RESULT('PR url: github.com/foo/bar/pull/9876'), state, 0);
    expect(buildOutput(state)).toContain('pull/9876');
  });

  it('detects max-turns via subtype error_max_turns', () => {
    const state = newStreamJsonState();
    processStreamJsonLine(RESULT_MAX_TURNS, state, 0);
    expect(state.hitMaxTurns).toBe(true);
  });

  it('detects max-turns via stop_reason=max_turns even without subtype', () => {
    const state = newStreamJsonState();
    const evt = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'max_turns',
      result: '',
    });
    processStreamJsonLine(evt, state, 0);
    expect(state.hitMaxTurns).toBe(true);
  });

  it('does not flag max-turns on a clean end_turn result', () => {
    const state = newStreamJsonState();
    processStreamJsonLine(RESULT_OK, state, 0);
    expect(state.hitMaxTurns).toBe(false);
  });

  it('preserves agent text in the output for legacy regex callers', () => {
    const state = newStreamJsonState();
    processStreamJsonLine(SYSTEM_INIT, state, 0);
    processStreamJsonLine(
      ASSISTANT_TEXT('No code changes needed — this is a pre-existing failure on main'),
      state,
      0,
    );
    processStreamJsonLine(RESULT_OK, state, 0);

    const output = buildOutput(state);
    // looksLikeNoOp pattern
    expect(/no code changes needed/i.test(output)).toBe(true);
    // looksLikeMainRootCause pattern
    expect(/pre-existing.*failure/i.test(output)).toBe(true);
    // extractFixPrNumber pattern
    expect(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(output)?.[1]).toBe('1234');
  });

  it('emits a stderr line for system/init carrying the model', () => {
    const state = newStreamJsonState();
    const effect = processStreamJsonLine(SYSTEM_INIT, state, 0);
    expect(effect.stderrText).toContain('claude-sonnet-4-6');
  });

  it('handles a missing usage block defensively', () => {
    const state = newStreamJsonState();
    const evt = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'no usage' }] },
    });
    const effect = processStreamJsonLine(evt, state, 50_000);
    expect(effect.budgetCrossedNow).toBe(false);
    expect(state.cumulativeInputTokens).toBe(0);
    expect(buildOutput(state)).toBe('no usage');
  });

  it('tolerates unknown event types without error', () => {
    const state = newStreamJsonState();
    const evt = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} });
    const effect = processStreamJsonLine(evt, state, 0);
    expect(effect.stderrText).toBeNull();
  });
});
