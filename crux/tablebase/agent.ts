/**
 * TableBase Agent
 *
 * Custom agent loop that supports both regular tools and Anthropic server tools
 * (web_search_20250305). Uses streamingCreate directly instead of runLlmAgent
 * because the latter doesn't support server tools.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolUseBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { createLlmClient, streamingCreate, extractText, MODELS } from '../lib/llm.ts';
import { withRetry, startHeartbeat } from '../lib/resilience.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import type { EnrichmentTask, TaskResult } from './types.ts';
import { getSystemPrompt, getUserPrompt } from './prompts.ts';
import { getToolDefinitions, buildToolHandlers } from './tools.ts';

const MAX_TOOL_TURNS = 15;

export interface AgentRunOptions {
  dryRun?: boolean;
  model?: string;
}

/**
 * Run the enrichment agent for a single task.
 * Returns the task result with records created/updated and cost.
 */
export async function runEnrichmentAgent(
  task: EnrichmentTask,
  options: AgentRunOptions = {},
): Promise<TaskResult> {
  const { dryRun = false, model = MODELS.sonnet } = options;
  const startTime = Date.now();
  const tracker = new CostTracker();

  const client = createLlmClient();
  const systemPrompt = getSystemPrompt(task);
  const userPrompt = getUserPrompt(task);
  const { tools: regularTools, serverTools } = getToolDefinitions();
  const toolHandlers = buildToolHandlers(task, dryRun);

  // Combine regular tools and server tools into a single array for the API
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: any[] = [
    ...regularTools.map(t => ({ type: 'custom' as const, ...t })),
    ...serverTools,
  ];

  const messages: MessageParam[] = [{ role: 'user', content: userPrompt }];

  console.log(`[tablebase] Running agent for ${task.taskType} on "${task.entityName}" (${task.id})${dryRun ? ' [DRY RUN]' : ''}`);

  const makeRequest = (msgs: MessageParam[]) =>
    withRetry(
      () => streamingCreate(client, {
        model,
        max_tokens: 8000,
        system: systemPrompt,
        tools: allTools,
        messages: msgs,
      }, { tracker, label: `tablebase-${task.taskType}` }),
      { label: `tablebase-${task.taskType}` },
    );

  let stopHb = startHeartbeat('tablebase-agent', 30);
  let response: Anthropic.Messages.Message;
  try {
    response = await makeRequest(messages);
  } finally {
    stopHb();
  }

  // Tool use loop
  let toolTurns = 0;
  let totalRecordsCreated = 0;

  while (response.stop_reason === 'tool_use' && toolTurns < MAX_TOOL_TURNS) {
    toolTurns++;
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const handler = toolHandlers[toolUse.name];
      if (handler) {
        try {
          const input = (toolUse.input ?? {}) as Record<string, unknown>;
          const result = await handler(input);
          console.log(`[tablebase]   tool: ${toolUse.name} → ${result.slice(0, 120)}${result.length > 120 ? '...' : ''}`);

          // Track records from submit_records calls
          const match = result.match(/Successfully submitted (\d+) records/);
          if (match) totalRecordsCreated += parseInt(match[1], 10);
          const dryMatch = result.match(/\[DRY RUN\] Would submit (\d+) records/);
          if (dryMatch) totalRecordsCreated += parseInt(dryMatch[1], 10);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tablebase]   tool ${toolUse.name} error: ${msg}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${msg}`,
          });
        }
      }
      // Server tools (web_search) are handled automatically by the API —
      // their results appear in the response content, no handler needed.
      // We only need to handle tool_use blocks for our custom tools.
    }

    // Only send tool results if we have any (skip if only server tool calls)
    if (toolResults.length > 0) {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    } else {
      // All tool calls were server tools — the results are already in the response
      messages.push({ role: 'assistant', content: response.content });
    }

    stopHb = startHeartbeat('tablebase-agent-loop', 30);
    try {
      response = await makeRequest(messages);
    } finally {
      stopHb();
    }
  }

  if (toolTurns >= MAX_TOOL_TURNS) {
    console.warn(`[tablebase] Hit tool turn limit (${MAX_TOOL_TURNS})`);
  }

  const durationMs = Date.now() - startTime;
  const finalText = extractText(response);

  // Extract source URLs from the final text
  const urlPattern = /https?:\/\/[^\s"'<>)]+/g;
  const sources = [...new Set(finalText.match(urlPattern) || [])];

  console.log(`[tablebase] Agent completed: ${totalRecordsCreated} records, ${Math.round(durationMs / 1000)}s, $${tracker.totalCost.toFixed(4)}`);

  return {
    taskId: task.id,
    recordsCreated: totalRecordsCreated,
    recordsUpdated: 0,
    durationMs,
    cost: tracker.totalCost,
    sources,
  };
}
