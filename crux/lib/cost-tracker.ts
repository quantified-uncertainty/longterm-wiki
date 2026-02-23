/**
 * CostTracker — Session-level actual cost collector.
 *
 * Hooks into streamingCreate() via an optional parameter. Every LLM API call
 * that passes a tracker automatically gets recorded with model, tokens, cost,
 * and a human-readable label.
 *
 * Usage:
 *   const tracker = new CostTracker();
 *   await streamingCreate(client, params, { tracker, label: 'orchestrator' });
 *   console.log(tracker.totalCost);        // $2.34
 *   console.log(tracker.breakdown());       // { orchestrator: 2.34 }
 */

import { calculateCost } from './pricing.ts';

/** A single recorded LLM API call. */
export interface CostEntry {
  /** Model ID used for the call. */
  model: string;
  /** Input tokens from response.usage. */
  inputTokens: number;
  /** Output tokens from response.usage. */
  outputTokens: number;
  /** Calculated cost in USD. */
  cost: number;
  /** Human-readable label for grouping (e.g. "orchestrator", "rewrite_section"). */
  label: string;
  /** Unix timestamp (ms) when the call completed. */
  timestamp: number;
}

/**
 * Collects actual API costs across an orchestrator run.
 *
 * Thread-safe for sequential use (one call at a time, which is how
 * the orchestrator works). Not designed for concurrent recording.
 */
export class CostTracker {
  readonly entries: CostEntry[] = [];

  /**
   * Record a completed API call.
   *
   * @param model - Model ID from the request params
   * @param usage - Usage object from the Anthropic response (input_tokens, output_tokens)
   * @param label - Grouping label (default: "unknown")
   */
  record(
    model: string,
    usage: { input_tokens: number; output_tokens: number },
    label?: string,
  ): void {
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const cost = calculateCost(model, { inputTokens, outputTokens });

    this.entries.push({
      model,
      inputTokens,
      outputTokens,
      cost,
      label: label ?? 'unknown',
      timestamp: Date.now(),
    });
  }

  /**
   * Record a cost from an external API that reports cost directly (not via tokens).
   * Used for OpenRouter/Perplexity calls that bypass the Anthropic SDK.
   *
   * @param model - Model identifier (e.g. "perplexity/sonar")
   * @param cost - Cost in USD as reported by the API
   * @param label - Grouping label
   */
  recordExternalCost(model: string, cost: number, label: string): void {
    this.entries.push({
      model,
      inputTokens: 0,
      outputTokens: 0,
      cost,
      label,
      timestamp: Date.now(),
    });
  }

  /** Total actual cost across all recorded calls. */
  get totalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.cost, 0);
  }

  /** Total tokens across all recorded calls. */
  get totalTokens(): { input: number; output: number } {
    return this.entries.reduce(
      (acc, e) => ({
        input: acc.input + e.inputTokens,
        output: acc.output + e.outputTokens,
      }),
      { input: 0, output: 0 },
    );
  }

  /** Cost summed by label. */
  breakdown(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const entry of this.entries) {
      result[entry.label] = (result[entry.label] || 0) + entry.cost;
    }
    return result;
  }

  /** Serializable summary for JSON output / logging. */
  toJSON(): {
    entries: CostEntry[];
    totalCost: number;
    totalTokens: { input: number; output: number };
    breakdown: Record<string, number>;
  } {
    return {
      entries: this.entries,
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      breakdown: this.breakdown(),
    };
  }
}
