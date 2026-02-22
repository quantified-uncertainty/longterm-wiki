/**
 * Core Agent Orchestrator
 *
 * Replaces fixed improve/create pipelines with an LLM agent that has
 * composable modules as tools. The orchestrator reads the page, analyzes gaps,
 * calls tools, checks quality gates, and iterates if needed.
 *
 * Architecture:
 *   1. Build context (page data, budget, initial content)
 *   2. Run the agent loop (Opus with tools) — the LLM decides what to call
 *   3. Evaluate quality gate
 *   4. If gaps found and refinement budget remains, feed gaps back and re-run
 *   5. Return final content + metrics + cost breakdown
 *
 * See E766 Part 11 and issue #692.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolUseBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';

import { createLlmClient, streamingCreate } from '../../lib/llm.ts';
import { MODELS } from '../../lib/anthropic.ts';
import { withRetry, startHeartbeat } from '../../lib/resilience.ts';
import { createPhaseLogger } from '../../lib/output.ts';

import {
  type OrchestratorContext,
  type OrchestratorOptions,
  type OrchestratorResult,
  type OrchestratorPageData,
  type OrchestratorTier,
  TIER_BUDGETS,
} from './types.ts';
import { renumberFootnotes } from '../../lib/section-splitter.ts';
import { buildToolDefinitions, buildToolHandlers, wrapWithTracking, extractQualityMetrics } from './tools.ts';
import { buildImproveSystemPrompt, buildRefinementPrompt } from './prompts.ts';
import { evaluateQualityGate } from './quality-gate.ts';

const log = createPhaseLogger();

/** Maximum number of refinement cycles after the initial run. */
const MAX_REFINEMENT_CYCLES = 2;

/** Max tool turns per agent invocation (safety limit). */
const MAX_TOOL_TURNS = 60;

// ---------------------------------------------------------------------------
// Footnote deduplication
// ---------------------------------------------------------------------------

/**
 * Merge duplicate footnotes that reference the same URL.
 * When multiple footnotes point to the same URL, keep the first one and
 * rewrite references in the body to point to it.
 */
/** @internal Exported for testing. */
export function deduplicateFootnotes(content: string): string {
  // Extract all footnote definitions: [^N]: Title (URL) or [^N]: URL
  const footnoteDefRe = /^\[\^(\d+)\]:\s*(.+)$/gm;
  const defs: Array<{ num: number; text: string; url: string }> = [];

  for (const match of content.matchAll(footnoteDefRe)) {
    const num = parseInt(match[1], 10);
    const text = match[2].trim();
    // Extract URL from patterns like "Title (https://...)" or bare "https://..."
    const urlMatch = text.match(/\((https?:\/\/[^)]+)\)/) || text.match(/(https?:\/\/\S+)/);
    const url = urlMatch?.[1] || text;
    defs.push({ num, text, url });
  }

  if (defs.length === 0) return content;

  // Build URL → first footnote number mapping
  const urlToFirst = new Map<string, number>();
  const remapTable = new Map<number, number>(); // oldNum → newNum

  for (const def of defs) {
    const normalizedUrl = def.url.replace(/\/+$/, '').toLowerCase();
    if (!urlToFirst.has(normalizedUrl)) {
      urlToFirst.set(normalizedUrl, def.num);
    } else {
      remapTable.set(def.num, urlToFirst.get(normalizedUrl)!);
    }
  }

  if (remapTable.size === 0) return content;

  log('orchestrator', `Deduplicating ${remapTable.size} duplicate footnote(s)`);

  let result = content;

  // Rewrite inline references [^oldNum] → [^newNum]
  for (const [oldNum, newNum] of remapTable) {
    result = result.replace(
      new RegExp(`\\[\\^${oldNum}\\](?!:)`, 'g'),
      `[^${newNum}]`,
    );
  }

  // Remove the duplicate definitions
  for (const oldNum of remapTable.keys()) {
    result = result.replace(new RegExp(`^\\[\\^${oldNum}\\]:\\s*.+$\\n?`, 'gm'), '');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/**
 * Run the orchestrator agent loop. The LLM calls tools iteratively until
 * it decides to stop (end_turn) or hits the tool-call budget.
 *
 * Returns the final text response from the agent.
 */
async function runAgentLoop(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string,
  tools: Anthropic.Messages.Tool[],
  toolHandlers: Record<string, (input: Record<string, unknown>) => Promise<string>>,
  ctx: OrchestratorContext,
  orchestratorModel: string,
): Promise<string> {
  const messages: MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  const makeRequest = (msgs: MessageParam[]) =>
    withRetry(
      () => streamingCreate(client, {
        model: orchestratorModel,
        max_tokens: 16_000,
        system: systemPrompt,
        tools: tools as Anthropic.Messages.Tool[],
        messages: msgs,
      }),
      { label: `orchestrator(${orchestratorModel})` },
    );

  const stopHeartbeat = startHeartbeat('orchestrator', 60);
  let response: Anthropic.Messages.Message;
  try {
    response = await makeRequest(messages);
  } finally {
    stopHeartbeat();
  }

  let toolTurns = 0;

  while (response.stop_reason === 'tool_use' && toolTurns < MAX_TOOL_TURNS) {
    // Check budget
    if (ctx.toolCallCount >= ctx.budget.maxToolCalls) {
      log('orchestrator', `Tool-call budget exhausted (${ctx.toolCallCount}/${ctx.budget.maxToolCalls})`);
      // Send error results for ALL pending tool_use blocks so the API stays consistent
      const pendingToolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );
      const errorResults: ToolResultBlockParam[] = pendingToolUses.map(tu => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: `BUDGET EXHAUSTED: You have used all ${ctx.budget.maxToolCalls} tool calls. Stop now and provide your final summary.`,
        is_error: true,
      }));
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: errorResults });

      const stopFinal = startHeartbeat('orchestrator-final', 60);
      try {
        response = await makeRequest(messages);
      } finally {
        stopFinal();
      }
      break;
    }

    toolTurns++;
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );

    log('orchestrator', `Tool call ${ctx.toolCallCount + 1}: ${toolUseBlocks.map(b => b.name).join(', ')}`);

    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const handler = toolHandlers[toolUse.name];
      let result: string;

      if (!handler) {
        result = `Unknown tool: ${toolUse.name}`;
      } else {
        try {
          const input = (toolUse.input ?? {}) as Record<string, unknown>;
          result = await handler(input);
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          result = `Error: ${error.message}`;
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    const stopLoop = startHeartbeat('orchestrator-loop', 60);
    try {
      response = await makeRequest(messages);
    } finally {
      stopLoop();
    }
  }

  // Extract final text response
  const textBlocks = response.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
  );
  return textBlocks.map(b => b.text).join('\n');
}

// ---------------------------------------------------------------------------
// Main orchestrator function
// ---------------------------------------------------------------------------

/**
 * Run the agent orchestrator on an existing page.
 *
 * @param page - Page metadata (id, title, path, quality, etc.)
 * @param filePath - Absolute path to the MDX file
 * @param content - Current page content
 * @param options - Orchestrator options (tier, directions, model overrides)
 * @returns OrchestratorResult with final content, metrics, and cost breakdown
 */
export async function runOrchestrator(
  page: OrchestratorPageData,
  filePath: string,
  content: string,
  options: OrchestratorOptions = {},
): Promise<OrchestratorResult> {
  const tier: OrchestratorTier = options.tier || 'standard';
  const directions = options.directions || '';
  const orchestratorModel = options.orchestratorModel || MODELS.opus;
  const writerModel = options.writerModel || MODELS.sonnet;
  const budget = TIER_BUDGETS[tier];

  log('orchestrator', `Starting orchestrator for "${page.title}"`);
  log('orchestrator', `Tier: ${budget.name} (max ${budget.maxToolCalls} calls, ${budget.maxResearchQueries} research queries)`);
  log('orchestrator', `Orchestrator model: ${orchestratorModel}`);
  log('orchestrator', `Writer model: ${writerModel}`);
  if (directions) log('orchestrator', `Directions: ${directions}`);

  const startTime = Date.now();

  // ── Build context ─────────────────────────────────────────────────────────

  const ctx: OrchestratorContext = {
    page,
    filePath,
    currentContent: content,
    originalContent: content,
    sourceCache: [],
    sections: null,
    splitPage: null,
    toolCallCount: 0,
    researchQueryCount: 0,
    costEntries: [],
    totalCost: 0,
    budget,
    directions,
    citationAudit: null,
  };

  // ── Build tools ───────────────────────────────────────────────────────────

  const client = createLlmClient();
  const toolDefs = buildToolDefinitions(budget.enabledTools);
  const rawHandlers = buildToolHandlers(ctx, writerModel);
  const trackedHandlers = wrapWithTracking(rawHandlers, ctx);

  // ── Build prompts ─────────────────────────────────────────────────────────

  const systemPrompt = buildImproveSystemPrompt(ctx);
  const userMessage = `Please improve the wiki page "${page.title}" (ID: ${page.id}). Start by reading the page and assessing its current state.`;

  // ── Run main agent loop ───────────────────────────────────────────────────

  log('orchestrator', 'Running main agent loop...');
  const agentResponse = await runAgentLoop(
    client, systemPrompt, userMessage, toolDefs, trackedHandlers, ctx, orchestratorModel,
  );
  log('orchestrator', `Main loop complete (${ctx.toolCallCount} tool calls, ~$${ctx.totalCost.toFixed(2)})`);
  log('orchestrator', `Agent summary: ${agentResponse.slice(0, 200)}...`);

  // ── Quality gate + refinement ─────────────────────────────────────────────

  let refinementCycles = 0;

  for (let cycle = 1; cycle <= MAX_REFINEMENT_CYCLES; cycle++) {
    // Check if we have tool calls remaining
    if (ctx.toolCallCount >= ctx.budget.maxToolCalls) {
      log('orchestrator', 'No tool-call budget remaining for refinement');
      break;
    }

    const gateResult = evaluateQualityGate(ctx);

    if (gateResult.passed) {
      log('orchestrator', 'Quality gate passed');
      break;
    }

    log('orchestrator', `Quality gate failed (cycle ${cycle}/${MAX_REFINEMENT_CYCLES}): ${gateResult.gaps.length} gap(s)`);
    for (const gap of gateResult.gaps) {
      log('orchestrator', `  - ${gap.slice(0, 100)}`);
    }

    // Feed gaps back to the agent
    const refinementMessage = buildRefinementPrompt(ctx, gateResult.gapSummary, gateResult.metrics, cycle);
    log('orchestrator', `Running refinement cycle ${cycle}...`);

    await runAgentLoop(
      client, systemPrompt, refinementMessage, toolDefs, trackedHandlers, ctx, orchestratorModel,
    );

    refinementCycles++;
    log('orchestrator', `Refinement cycle ${cycle} complete (${ctx.toolCallCount} total tool calls)`);
  }

  // ── Deduplicate footnotes ────────────────────────────────────────────────

  ctx.currentContent = deduplicateFootnotes(ctx.currentContent);
  ctx.currentContent = renumberFootnotes(ctx.currentContent);

  // ── Update lastEdited ──────────────────────────────────────────────────────

  const today = new Date().toISOString().split('T')[0];
  ctx.currentContent = ctx.currentContent.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`,
  );

  // ── Final metrics ─────────────────────────────────────────────────────────

  const finalMetrics = extractQualityMetrics(ctx.currentContent, filePath);
  const finalGate = evaluateQualityGate(ctx);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Cost breakdown by tool
  const costBreakdown: Record<string, number> = {};
  for (const entry of ctx.costEntries) {
    costBreakdown[entry.toolName] = (costBreakdown[entry.toolName] || 0) + entry.estimatedCost;
  }

  // Add estimated orchestrator model cost (rough: ~$0.50 per loop)
  const orchestratorLlmCost = (1 + refinementCycles) * 0.50;
  costBreakdown['orchestrator_llm'] = orchestratorLlmCost;
  ctx.totalCost += orchestratorLlmCost;

  log('orchestrator', '═'.repeat(50));
  log('orchestrator', 'Orchestrator Complete');
  log('orchestrator', `Duration: ${duration}s`);
  log('orchestrator', `Tool calls: ${ctx.toolCallCount}`);
  log('orchestrator', `Refinement cycles: ${refinementCycles}`);
  log('orchestrator', `Total cost: ~$${ctx.totalCost.toFixed(2)}`);
  log('orchestrator', `Quality gate: ${finalGate.passed ? 'PASSED' : 'FAILED'}`);
  log('orchestrator', `Final metrics: ${JSON.stringify(finalMetrics)}`);
  log('orchestrator', '═'.repeat(50));

  return {
    pageId: page.id,
    title: page.title,
    tier,
    directions,
    duration,
    toolCallCount: ctx.toolCallCount,
    refinementCycles,
    totalCost: ctx.totalCost,
    costBreakdown,
    qualityMetrics: finalMetrics,
    qualityGatePassed: finalGate.passed,
    outputPath: '', // Set by caller
    finalContent: ctx.currentContent,
  };
}
