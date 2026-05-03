/**
 * TableBase Agent
 *
 * Runs the LLM enrichment agent for a single task using the shared
 * runLlmAgent() with server tool support (web_search_20250305).
 */

import { createLlmClient, runLlmAgent, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { withPipelineRun } from '../lib/pipeline-runs/lifecycle.ts';
import type { EnrichmentTask, TaskResult } from './types.ts';
import { getSystemPrompt, getUserPrompt } from './prompts.ts';
import { getToolDefinitions, buildToolHandlers } from './tools.ts';
import { truncate } from '../lib/text-utils.ts';

const MAX_TOOL_TURNS = 25;

export interface AgentRunOptions {
  dryRun?: boolean;
  model?: string;
  /** Skip sourcing before submitting records */
  skipSourcing?: boolean;
  /**
   * QUA-730: required when skipSourcing is true. Must be in
   * SKIP_SOURCING_REASONS. Forwarded to the agent tool layer.
   */
  skipSourcingReason?: string;
  /** For source-discovery: also link discovered resources to records */
  apply?: boolean;
  /**
   * QUA-655: route supported record types through `POST /api/enrichment/propose`
   * (tier-aware defensive gate) instead of the direct `/sync` endpoint.
   */
  viaPropose?: boolean;
}

/**
 * Run the enrichment agent for a single task.
 * Returns the task result with records created/updated and cost.
 */
export async function runEnrichmentAgent(
  task: EnrichmentTask,
  options: AgentRunOptions = {},
): Promise<TaskResult> {
  const {
    dryRun = false,
    model = MODELS.sonnet,
    skipSourcing = false,
    skipSourcingReason,
    apply = false,
    viaPropose = false,
  } = options;
  const startTime = Date.now();
  const tracker = new CostTracker();

  const client = createLlmClient();
  const systemPrompt = getSystemPrompt(task);
  const userPrompt = getUserPrompt(task);
  const { tools: regularTools, serverTools } = getToolDefinitions({ taskType: task.taskType, apply });
  const toolHandlers = buildToolHandlers(task, dryRun, { skipSourcing, skipSourcingReason, apply, viaPropose });

  let totalRecordsCreated = 0;

  console.log(`[tablebase] Running agent for ${task.taskType} on "${task.entityName}" (${task.id})${dryRun ? ' [DRY RUN]' : ''}`);

  return withPipelineRun(
    {
      pipelineName: 'tablebase-agent',
      entityId: task.entityId,
      shape: task.taskType,
      allowOffline: true,
      tracker,
    },
    async () => {
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
          console.log(`[tablebase]   tool: ${toolName} → ${truncate(result, 123, { ellipsis: '...' })}`);
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
    },
  );
}
