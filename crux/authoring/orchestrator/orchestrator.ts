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

import { createLlmClient, streamingCreate, type StreamingCreateOptions } from '../../lib/llm.ts';
import { MODELS } from '../../lib/anthropic.ts';
import { withRetry, startHeartbeat } from '../../lib/resilience.ts';
import { createPhaseLogger } from '../../lib/output.ts';
import { saveArtifacts } from '../../lib/wiki-server/artifacts.ts';
import { CostTracker } from '../../lib/cost-tracker.ts';

import {
  type OrchestratorContext,
  type OrchestratorOptions,
  type OrchestratorResult,
  type OrchestratorPageData,
  type OrchestratorTier,
  TIER_BUDGETS,
} from './types.ts';
import { renumberFootnotes } from '../../lib/section-splitter.ts';
import { buildToolDefinitions, buildToolHandlers, wrapWithTracking, extractQualityMetrics } from './tools/index.ts';
import { buildImproveSystemPrompt, buildRefinementPrompt } from './prompts.ts';
import { evaluateQualityGate } from './quality-gate.ts';

const log = createPhaseLogger();

// ---------------------------------------------------------------------------
// Dollar-sign escaping normalization
// ---------------------------------------------------------------------------

/**
 * Collapse corrupted multi-backslash sequences before $ down to a single \$.
 * This is a safety net that catches corruption from the auto-fixer or LLM
 * (e.g. \\\\\$ → \$). Runs once at finalization and after each section rewrite.
 *
 * Only collapses 3+ backslashes (which are always corruption). Two backslashes
 * (\\$) could legitimately mean "literal backslash followed by dollar" and are
 * left untouched.
 */
export function normalizeDollarEscaping(content: string): string {
  return content.replace(/\\{3,}\$/g, '\\$');
}

/** Error message patterns that indicate a transient/retryable failure. */
const TRANSIENT_ERROR_PATTERNS = [
  'timeout', 'ECONNRESET', 'socket hang up', 'overloaded',
  '529', '429', 'rate_limit', 'UND_ERR_SOCKET', 'terminated',
  'ETIMEDOUT', 'ENOTFOUND', 'fetch failed',
];

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
  signal?: AbortSignal,
): Promise<string> {
  const messages: MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  const trackingOptions: StreamingCreateOptions = {
    tracker: ctx.tracker,
    label: 'orchestrator',
  };

  const makeRequest = (msgs: MessageParam[]) =>
    withRetry(
      () => streamingCreate(client, {
        model: orchestratorModel,
        max_tokens: 16_000,
        system: systemPrompt,
        tools: tools as Anthropic.Messages.Tool[],
        messages: msgs,
      }, trackingOptions),
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
    // Check abort signal (from batch runner timeout)
    if (signal?.aborted) {
      log('orchestrator', 'Abort signal received — stopping agent loop');
      break;
    }

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
      let isError = false;

      if (!handler) {
        result = `TOOL ERROR: Unknown tool "${toolUse.name}". Use a different tool.`;
        isError = true;
      } else {
        try {
          const input = (toolUse.input ?? {}) as Record<string, unknown>;
          result = await handler(input);
          // Check if the handler returned a JSON error object
          if (result.startsWith('{"error":')) {
            isError = true;
            result = `TOOL ERROR: ${result}\nThe tool encountered an error. Try a different approach or skip this step.`;
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          const errorMsg = error.message || String(err);

          // Retry once for transient failures (timeouts, rate limits, network errors)
          const isTransient = TRANSIENT_ERROR_PATTERNS.some(p => errorMsg.includes(p));
          if (isTransient) {
            log('orchestrator', `Transient error in ${toolUse.name}, retrying in 3s: ${errorMsg.slice(0, 80)}`);
            await new Promise(r => setTimeout(r, 3000));
            try {
              const input = (toolUse.input ?? {}) as Record<string, unknown>;
              result = await handler(input);
            } catch (retryErr: unknown) {
              const retryError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
              result = `TOOL ERROR: ${toolUse.name} failed after retry: ${retryError.message}. Try a different approach.`;
              isError = true;
            }
          } else {
            result = `TOOL ERROR: ${toolUse.name} failed: ${errorMsg}. Try a different approach.`;
            isError = true;
          }
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
        is_error: isError,
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
  const signal = options.signal;

  log('orchestrator', `Starting orchestrator for "${page.title}"`);
  log('orchestrator', `Tier: ${budget.name} (max ${budget.maxToolCalls} calls, ${budget.maxResearchQueries} research queries)`);
  log('orchestrator', `Orchestrator model: ${orchestratorModel}`);
  log('orchestrator', `Writer model: ${writerModel}`);
  if (directions) log('orchestrator', `Directions: ${directions}`);

  const startTime = Date.now();

  // ── Build context ─────────────────────────────────────────────────────────

  const tracker = new CostTracker();

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
    sectionDiffs: [],
    tracker,
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
    client, systemPrompt, userMessage, toolDefs, trackedHandlers, ctx, orchestratorModel, signal,
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
      client, systemPrompt, refinementMessage, toolDefs, trackedHandlers, ctx, orchestratorModel, signal,
    );

    refinementCycles++;
    log('orchestrator', `Refinement cycle ${cycle} complete (${ctx.toolCallCount} total tool calls)`);
  }

  // ── Deduplicate footnotes ────────────────────────────────────────────────

  ctx.currentContent = deduplicateFootnotes(ctx.currentContent);
  ctx.currentContent = renumberFootnotes(ctx.currentContent, { warn: true });
  ctx.currentContent = normalizeDollarEscaping(ctx.currentContent);

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

  // Cost breakdown by tool (estimated)
  const costBreakdown: Record<string, number> = {};
  for (const entry of ctx.costEntries) {
    costBreakdown[entry.toolName] = (costBreakdown[entry.toolName] || 0) + entry.estimatedCost;
  }

  // Add estimated orchestrator model cost (rough: ~$0.50 per loop)
  const orchestratorLlmCost = (1 + refinementCycles) * 0.50;
  costBreakdown['orchestrator_llm'] = orchestratorLlmCost;
  ctx.totalCost += orchestratorLlmCost;

  // Actual costs from CostTracker (null if no API calls were tracked)
  const actualTotalCost = tracker.entries.length > 0 ? tracker.totalCost : null;
  const actualCostBreakdown = tracker.entries.length > 0 ? tracker.breakdown() : null;

  log('orchestrator', '═'.repeat(50));
  log('orchestrator', 'Orchestrator Complete');
  log('orchestrator', `Duration: ${duration}s`);
  log('orchestrator', `Tool calls: ${ctx.toolCallCount}`);
  log('orchestrator', `Refinement cycles: ${refinementCycles}`);
  if (actualTotalCost != null) {
    log('orchestrator', `Cost: ~$${ctx.totalCost.toFixed(2)} estimated / $${actualTotalCost.toFixed(2)} actual`);
  } else {
    log('orchestrator', `Cost: ~$${ctx.totalCost.toFixed(2)} estimated`);
  }
  if (actualCostBreakdown && Object.keys(actualCostBreakdown).length > 0) {
    for (const [label, cost] of Object.entries(actualCostBreakdown).sort((a, b) => b[1] - a[1])) {
      log('orchestrator', `  ${label}: $${cost.toFixed(4)}`);
    }
  }
  log('orchestrator', `Quality gate: ${finalGate.passed ? 'PASSED' : 'FAILED'}`);
  log('orchestrator', `Final metrics: ${JSON.stringify(finalMetrics)}`);
  log('orchestrator', '═'.repeat(50));

  // ── Save artifacts to wiki-server (fire-and-forget) ──────────────────────

  if (options.saveArtifacts !== false) {
    const completedAt = new Date().toISOString();
    // Truncate source cache content to keep payload reasonable
    const trimmedSourceCache = ctx.sourceCache.map(s => ({
      id: s.id,
      url: s.url,
      title: s.title,
      author: s.author,
      date: s.date,
      facts: s.facts,
    }));

    saveArtifacts({
      pageId: page.id,
      engine: 'v2',
      tier,
      directions: directions || null,
      startedAt: new Date(startTime).toISOString(),
      completedAt,
      durationS: parseFloat(duration),
      totalCost: ctx.totalCost,
      sourceCache: trimmedSourceCache.length > 0 ? trimmedSourceCache : null,
      researchSummary: null,
      citationAudit: ctx.citationAudit ? { citations: ctx.citationAudit } : null,
      costEntries: ctx.costEntries.length > 0 ? ctx.costEntries : null,
      costBreakdown: Object.keys(costBreakdown).length > 0 ? costBreakdown : null,
      sectionDiffs: ctx.sectionDiffs.length > 0 ? ctx.sectionDiffs : null,
      qualityMetrics: finalMetrics as unknown as Record<string, unknown>,
      qualityGatePassed: finalGate.passed,
      qualityGaps: finalGate.gaps.length > 0 ? finalGate.gaps : null,
      toolCallCount: ctx.toolCallCount,
      refinementCycles,
    }).then(result => {
      if (result.ok) {
        log('orchestrator', `Artifacts saved to wiki-server (id: ${result.data.id})`);
      } else {
        log('orchestrator', `Warning: could not save artifacts: ${result.message}`);
      }
    }).catch(err => {
      log('orchestrator', `Warning: artifact save failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

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
    actualTotalCost,
    actualCostBreakdown,
    qualityMetrics: finalMetrics,
    qualityGatePassed: finalGate.passed,
    outputPath: '', // Set by caller
    finalContent: ctx.currentContent,
  };
}