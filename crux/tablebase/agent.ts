/**
 * TableBase Agent
 *
 * Runs the LLM enrichment agent for a single task using the shared
 * runLlmAgent() with server tool support (web_search_20250305).
 */

import { createLlmClient, runLlmAgent, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import type { EnrichmentTask, TaskResult } from './types.ts';
import { getSystemPrompt, getUserPrompt } from './prompts.ts';
import { getToolDefinitions, buildToolHandlers } from './tools.ts';

const MAX_TOOL_TURNS = 25;

export interface AgentRunOptions {
  dryRun?: boolean;
  model?: string;
  /** Skip source-check before submitting records */
  skipSourceCheck?: boolean;
  /** For source-discovery: also link discovered resources to records */
  apply?: boolean;
}

/**
 * Run the enrichment agent for a single task.
 * Returns the task result with records created/updated and cost.
 */
export async function runEnrichmentAgent(
  task: EnrichmentTask,
  options: AgentRunOptions = {},
): Promise<TaskResult> {
  const { dryRun = false, model = MODELS.sonnet, skipSourceCheck = false, apply = false } = options;
  const startTime = Date.now();
  const tracker = new CostTracker();

  const client = createLlmClient();
  const systemPrompt = getSystemPrompt(task);
  const userPrompt = getUserPrompt(task);
  const { tools: regularTools, serverTools } = getToolDefinitions({ taskType: task.taskType, apply });
  const toolHandlers = buildToolHandlers(task, dryRun, { skipSourceCheck, apply });

  let totalRecordsCreated = 0;

  console.log(`[tablebase] Running agent for ${task.taskType} on "${task.entityName}" (${task.id})${dryRun ? ' [DRY RUN]' : ''}`);

  const finalText = await runLlmAgent(client, userPrompt, {
    model,
    maxTokens: 8000,
    systemPrompt,
    tools: regularTools,
    serverTools,
    toolHandlers,
    maxToolTurns: MAX_TOOL_TURNS,
    retryLabel: `tablebase-${task.taskType}`,
    heartbeatPhase: 'tablebase-agent',
    costTracker: tracker,
    onToolResult: (toolName, result) => {
      console.log(`[tablebase]   tool: ${toolName} → ${result.slice(0, 120)}${result.length > 120 ? '...' : ''}`);
      // Track records from submit_records calls
      const match = result.match(/Successfully submitted (\d+) records/);
      if (match) totalRecordsCreated += parseInt(match[1], 10);
      const dryMatch = result.match(/\[DRY RUN\] Would submit (\d+) records/);
      if (dryMatch) totalRecordsCreated += parseInt(dryMatch[1], 10);
      // Track resources suggested (source-discovery)
      if (toolName === 'suggest_resource' && result.includes('"resourceId"')) totalRecordsCreated++;
      if (toolName === 'suggest_resource' && result.includes('[DRY RUN]')) totalRecordsCreated++;
    },
  });

  const durationMs = Date.now() - startTime;

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
