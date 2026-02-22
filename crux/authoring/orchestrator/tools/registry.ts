/**
 * Tool Registry — assembles individual tool modules into the maps
 * that the orchestrator loop needs.
 *
 * To add a new tool:
 *   1. Create `tools/<name>.ts` exporting a `ToolRegistration`
 *   2. Import it below and add to `ALL_TOOLS`
 *
 * That's it. The registry wires definitions, handlers, and costs
 * into buildToolDefinitions() and buildToolHandlers().
 */

import type Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '../../../lib/anthropic.ts';
import { createPhaseLogger } from '../../../lib/output.ts';
import type { OrchestratorContext } from '../types.ts';
import type { ToolHandler, ToolRegistration } from './types.ts';

// ── Import all tool registrations ─────────────────────────────────────────
// Each file exports `tool: ToolRegistration`. Add new tools here.

import { tool as readPage } from './read-page.ts';
import { tool as getPageMetrics } from './get-page-metrics.ts';
import { tool as splitIntoSections } from './split-into-sections.ts';
import { tool as runResearch } from './run-research.ts';
import { tool as rewriteSection } from './rewrite-section.ts';
import { tool as auditCitations } from './audit-citations.ts';
import { tool as addEntityLinks } from './add-entity-links.ts';
import { tool as addFactRefs } from './add-fact-refs.ts';
import { tool as validateContent } from './validate-content.ts';

// ── Tool registry ─────────────────────────────────────────────────────────

/** All registered tools. Order doesn't matter — filtering uses the name. */
const ALL_TOOLS: ToolRegistration[] = [
  readPage,
  getPageMetrics,
  splitIntoSections,
  runResearch,
  rewriteSection,
  auditCitations,
  addEntityLinks,
  addFactRefs,
  validateContent,
];

const log = createPhaseLogger();

// ── Build maps keyed by tool name ─────────────────────────────────────────

const toolByName = new Map<string, ToolRegistration>();
for (const t of ALL_TOOLS) {
  toolByName.set(t.name, t);
}

// ── Cost estimates (keyed by tool name) ───────────────────────────────────

const TOOL_COST_ESTIMATES: Record<string, number> = {};
for (const t of ALL_TOOLS) {
  TOOL_COST_ESTIMATES[t.name] = t.cost;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build the tool definitions array for the orchestrator.
 * Only includes tools that are in the enabledTools list.
 */
export function buildToolDefinitions(enabledTools: string[]): Anthropic.Messages.Tool[] {
  return enabledTools
    .map((name) => toolByName.get(name))
    .filter((t): t is ToolRegistration => t !== undefined)
    .map((t) => t.definition);
}

/**
 * Build tool handlers as closures over the orchestrator context.
 * Only includes tools that are in the enabled list for the current tier.
 */
export function buildToolHandlers(
  ctx: OrchestratorContext,
  writerModel: string = MODELS.sonnet,
): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const options = { writerModel };

  for (const name of ctx.budget.enabledTools) {
    const reg = toolByName.get(name);
    if (reg) {
      handlers[name] = reg.createHandler(ctx, options);
    }
  }

  return handlers;
}

/**
 * Wrap tool handlers with cost tracking and tool-call counting.
 * Returns handlers that update the context's cost/count fields.
 */
export function wrapWithTracking(
  handlers: Record<string, ToolHandler>,
  ctx: OrchestratorContext,
): Record<string, ToolHandler> {
  const wrapped: Record<string, ToolHandler> = {};

  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = async (input) => {
      ctx.toolCallCount++;
      const cost = TOOL_COST_ESTIMATES[name] || 0;
      ctx.costEntries.push({
        toolName: name,
        estimatedCost: cost,
        timestamp: Date.now(),
      });
      ctx.totalCost += cost;

      const result = await handler(input);

      // Append budget status so the agent stays informed
      const budgetStatus = `\n\n[Budget: ${ctx.toolCallCount}/${ctx.budget.maxToolCalls} tool calls used, ~$${ctx.totalCost.toFixed(2)} spent]`;
      return result + budgetStatus;
    };
  }

  return wrapped;
}
