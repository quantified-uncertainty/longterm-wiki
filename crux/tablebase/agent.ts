/**
 * TableBase Agent
 *
 * Wraps runLlmAgent() with tablebase-specific tools and prompts.
 * Runs an LLM agent that uses web search + wiki-server APIs to enrich
 * structured data for a single entity.
 */

import { createLlmClient, runLlmAgent, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import type { EnrichmentTask, TaskResult } from './types.ts';
import { getSystemPrompt, getUserPrompt } from './prompts.ts';
import { getToolDefinitions, buildToolHandlers } from './tools.ts';

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
  const { tools, serverTools } = getToolDefinitions();
  const toolHandlers = buildToolHandlers(task, dryRun);

  console.log(`[tablebase] Running agent for ${task.taskType} on "${task.entityName}" (${task.id})${dryRun ? ' [DRY RUN]' : ''}`);

  const result = await runLlmAgent(client, userPrompt, {
    model,
    maxTokens: 8000,
    systemPrompt,
    tools: [
      ...tools,
      // Server tools are passed as tool definitions with type field
      ...serverTools.map(st => ({
        ...st,
        // runLlmAgent expects the standard tool shape
        // Server tools are handled by the Anthropic API directly
      })),
    ] as Parameters<typeof runLlmAgent>[2]['tools'],
    toolHandlers,
    maxToolTurns: 15,
    retryLabel: `tablebase-${task.taskType}`,
    heartbeatPhase: 'tablebase-agent',
  });

  const durationMs = Date.now() - startTime;

  // Extract source URLs from the agent's response
  const urlPattern = /https?:\/\/[^\s"'<>)]+/g;
  const sources = [...new Set(result.match(urlPattern) || [])];

  // Count records from the response text (approximate from submit_records output)
  const createdMatch = result.match(/Successfully submitted (\d+) records/);
  const recordsCreated = createdMatch ? parseInt(createdMatch[1], 10) : 0;

  console.log(`[tablebase] Agent completed: ${recordsCreated} records, ${durationMs}ms, $${tracker.totalCost.toFixed(4)}`);

  return {
    taskId: task.id,
    recordsCreated,
    recordsUpdated: 0,
    durationMs,
    cost: tracker.totalCost,
    sources,
  };
}
