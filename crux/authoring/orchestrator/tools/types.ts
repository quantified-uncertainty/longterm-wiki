/**
 * Shared types for orchestrator tool registrations.
 *
 * Each tool file exports a `ToolRegistration` object that bundles the
 * Anthropic tool definition, handler factory, and cost estimate.
 * The registry assembles these into the maps that the orchestrator loop needs.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { OrchestratorContext } from '../types.ts';

/** A tool handler takes input and returns a string result. */
export interface ToolHandler {
  (input: Record<string, unknown>): Promise<string>;
}

/** Options passed to handler factories that need model configuration. */
export interface ToolHandlerOptions {
  /** Model to use for section writing (default: Sonnet). */
  writerModel: string;
}

/**
 * A complete tool registration.
 *
 * Adding a new tool to the orchestrator requires:
 *   1. Create `tools/<name>.ts` exporting a `ToolRegistration`
 *   2. Import it in `tools/registry.ts` and add to `ALL_TOOLS`
 *
 * That's it — the registry handles wiring it into `buildToolDefinitions()`
 * and `buildToolHandlers()`.
 */
export interface ToolRegistration {
  /** Tool name (must match the Anthropic tool definition name). */
  name: string;
  /** Estimated cost per call in USD. */
  cost: number;
  /** Anthropic tool-use schema (name, description, input_schema). */
  definition: Anthropic.Messages.Tool;
  /**
   * Factory that returns a handler closure over the orchestrator context.
   * Called once at orchestrator startup; the returned handler is called
   * each time the LLM invokes the tool.
   */
  createHandler: (ctx: OrchestratorContext, options: ToolHandlerOptions) => ToolHandler;
}
