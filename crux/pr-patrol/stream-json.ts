/**
 * PR Patrol — stream-json event processing for spawnClaude
 *
 * The patrol daemon spawns `claude --print --output-format stream-json
 * --verbose` (QUA-1078). Each stdout line is one JSON event. This module
 * accumulates the agent's textual output into a backward-compatible
 * `result.output` string (so the existing `looksLikeNoOp` /
 * `looksLikeMainRootCause` / `extractFixPrNumber` regexes keep working) and
 * tracks cumulative `input_tokens` so spawnClaude can SIGTERM a runaway
 * agent before it burns the budget.
 *
 * Kept as a pure module — no spawn/IO — so the parser is unit-testable
 * without standing up a real subprocess.
 */

export interface StreamJsonState {
  /** Captured assistant/result text in arrival order. Joined for backward-compat output. */
  outputParts: string[];
  /** Sum of `message.usage.input_tokens` across every assistant event. */
  cumulativeInputTokens: number;
  /** True once a `result` event signalled max-turns (CLI-side). */
  hitMaxTurns: boolean;
}

export interface LineEffect {
  /** Text to render to the operator (preserves the live `tail -f run.log` UX). */
  stderrText: string | null;
  /** True iff cumulative input_tokens crossed the cap on this line. */
  budgetCrossedNow: boolean;
}

export function newStreamJsonState(): StreamJsonState {
  return {
    outputParts: [],
    cumulativeInputTokens: 0,
    hitMaxTurns: false,
  };
}

/**
 * Apply a single stream-json line to `state`. Tolerant of malformed input —
 * unparseable lines are appended to outputParts and surfaced verbatim to the
 * operator (claude warnings/errors sometimes come through as plain text).
 *
 * `cap` of 0 disables the budget check.
 */
export function processStreamJsonLine(
  line: string,
  state: StreamJsonState,
  cap: number,
): LineEffect {
  const trimmed = line.trim();
  if (!trimmed) return { stderrText: null, budgetCrossedNow: false };

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Pass non-JSON lines straight through — claude's pre-stream stderr
    // sometimes interleaves into stdout on auth/credit errors. Keep them
    // visible AND searchable in `output` so existing regexes still fire.
    state.outputParts.push(trimmed);
    return { stderrText: trimmed, budgetCrossedNow: false };
  }

  const type = typeof evt.type === 'string' ? evt.type : '';

  if (type === 'assistant') {
    return handleAssistant(evt, state, cap);
  }
  if (type === 'result') {
    return handleResult(evt, state);
  }
  if (type === 'user') {
    return handleUserToolResult(evt, state);
  }
  if (type === 'system') {
    return handleSystem(evt);
  }
  // Unknown event types (rate_limit_event, etc.) — silently track raw type for debugging.
  return { stderrText: null, budgetCrossedNow: false };
}

function handleAssistant(
  evt: Record<string, unknown>,
  state: StreamJsonState,
  cap: number,
): LineEffect {
  const msg = (evt.message ?? {}) as Record<string, unknown>;
  const usage = (msg.usage ?? {}) as Record<string, unknown>;
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;

  const wasUnderCap = cap > 0 ? state.cumulativeInputTokens < cap : false;
  state.cumulativeInputTokens += inputTokens;
  const budgetCrossedNow = cap > 0 && wasUnderCap && state.cumulativeInputTokens >= cap;

  const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
  const lines: string[] = [];
  for (const part of content) {
    const partType = typeof part.type === 'string' ? part.type : '';
    if (partType === 'text' && typeof part.text === 'string') {
      const text = part.text.trim();
      if (text) {
        state.outputParts.push(text);
        lines.push(text);
      }
    } else if (partType === 'tool_use') {
      const name = typeof part.name === 'string' ? part.name : '?';
      const input = part.input;
      let preview = '';
      if (input && typeof input === 'object') {
        const io = input as Record<string, unknown>;
        if (typeof io.command === 'string') preview = io.command;
        else if (typeof io.file_path === 'string') preview = io.file_path;
        else if (typeof io.pattern === 'string') preview = io.pattern;
        else if (typeof io.path === 'string') preview = io.path;
        else if (typeof io.url === 'string') preview = io.url;
      }
      // Tool calls don't contribute to backward-compat output — they were
      // never in text mode either (text mode only echoed the agent's own
      // prose). But render them to stderr so the operator sees progress.
      const truncated = preview.length > 160 ? preview.slice(0, 159) + '…' : preview;
      lines.push(`[tool] ${name}${truncated ? ': ' + truncated : ''}`);
    }
  }

  return {
    stderrText: lines.length > 0 ? lines.join('\n') : null,
    budgetCrossedNow,
  };
}

function handleResult(
  evt: Record<string, unknown>,
  state: StreamJsonState,
): LineEffect {
  const resultText = typeof evt.result === 'string' ? evt.result : '';
  const stopReason = typeof evt.stop_reason === 'string' ? evt.stop_reason : '';
  const subtype = typeof evt.subtype === 'string' ? evt.subtype : '';
  const isError = evt.is_error === true;

  if (resultText) {
    state.outputParts.push(resultText);
  }
  // CLI-side max-turns signal:
  //   - subtype === 'error_max_turns' (newer claude builds)
  //   - stop_reason === 'max_turns'
  //   - "max turns" in result text
  // We OR them together so a future CLI rename doesn't silently break the gate.
  if (
    subtype === 'error_max_turns' ||
    stopReason === 'max_turns' ||
    /max[ _-]?turns/i.test(resultText)
  ) {
    state.hitMaxTurns = true;
  }

  let stderrText: string | null = null;
  if (resultText) stderrText = resultText;
  else if (isError && subtype) stderrText = `[result error] ${subtype}`;

  return { stderrText, budgetCrossedNow: false };
}

function handleUserToolResult(
  _evt: Record<string, unknown>,
  _state: StreamJsonState,
): LineEffect {
  // Deliberately a no-op: tool_result content is NOT pushed into outputParts.
  // The regex classifiers (`looksLikeNoOp`, `looksLikeMainRootCause`,
  // `extractFixPrNumber`, fix-complete tail) are calibrated against the
  // agent's own prose only. A `gh api /search/issues` tool_result can dump
  // dozens of github.com/.../pull/N URLs into the buffer and trick
  // `extractFixPrNumber` into matching a sibling PR instead of the agent's
  // actual fix-PR. tool_result was never user-visible in text mode either
  // (claude only emitted assistant turns to stdout), so omitting it here
  // preserves the prior contract. We also don't render to stderr — keeps the
  // live `tail -f run.log` focused on the agent's own thinking + tool calls.
  return { stderrText: null, budgetCrossedNow: false };
}

function handleSystem(evt: Record<string, unknown>): LineEffect {
  const subtype = typeof evt.subtype === 'string' ? evt.subtype : '';
  if (subtype === 'init') {
    const model = typeof evt.model === 'string' ? evt.model : 'unknown';
    return { stderrText: `[claude] init model=${model}`, budgetCrossedNow: false };
  }
  return { stderrText: null, budgetCrossedNow: false };
}

/** Build the backward-compatible `output` string consumed by the existing regexes. */
export function buildOutput(state: StreamJsonState): string {
  return state.outputParts.join('\n');
}
