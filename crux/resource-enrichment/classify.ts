/**
 * Resource Enrichment — LLM Classification (Phase 4a)
 *
 * Uses the Anthropic Batch API with Haiku to classify all resources:
 * - resource_subtype (arxiv_preprint, blog_post, executive_order, etc.)
 * - resource_purpose (primary_source, commentary, dataset, etc.)
 * - context_note (single sentence of context)
 * - Which sub-table the resource belongs to
 *
 * Cost: ~$15 for 5,000 resources with Haiku batch (50% discount).
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import {
  createBatch,
  pollBatch,
  downloadBatchResults,
  type BatchRequest,
} from './batch-client.ts';
import { CLASSIFICATION_SYSTEM, classificationPrompt } from './prompts.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';

interface ClassificationResult {
  resource_subtype: string;
  resource_purpose: string;
  context_note: string;
  sub_table: 'paper' | 'forum_post' | 'policy_doc' | 'none';
}

export async function classifyCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const subcommand = args[0] || 'status';
  const dryRun = options['dry-run'] as boolean;
  const limit = (options.limit as number) || 5000;
  const batchId = options['batch-id'] as string;

  if (subcommand === 'status' && batchId) {
    // Poll a running batch
    const { getBatchStatus } = await import('./batch-client.ts');
    const status = await getBatchStatus(batchId);
    console.log(`Batch ${batchId}:`);
    console.log(`  Status: ${status.processing_status}`);
    console.log(`  Succeeded: ${status.request_counts.succeeded}`);
    console.log(`  Errored: ${status.request_counts.errored}`);
    console.log(`  Processing: ${status.request_counts.processing}`);
    return { exitCode: 0, output: '' };
  }

  if (subcommand === 'submit' || subcommand === 'dry-run') {
    return await submitClassification(limit, subcommand === 'dry-run' || dryRun);
  }

  if (subcommand === 'download' && batchId) {
    return await downloadAndApplyClassification(batchId, dryRun);
  }

  if (subcommand === 'poll' && batchId) {
    const status = await pollBatch(batchId);
    if (status.processing_status === 'ended') {
      return await downloadAndApplyClassification(batchId, dryRun);
    }
    return { exitCode: 0, output: '' };
  }

  console.log(`Usage:
  crux resources classify submit [--limit=N] [--dry-run]    Submit classification batch
  crux resources classify status --batch-id=ID              Check batch status
  crux resources classify poll --batch-id=ID                Poll until complete, then apply
  crux resources classify download --batch-id=ID            Download and apply results`);
  return { exitCode: 0, output: '' };
}

async function submitClassification(limit: number, dryRun: boolean): Promise<CommandResult> {
  console.log('🏷️  Resource Classification (Haiku batch)\n');
  if (dryRun) console.log('  DRY RUN — batch will not be submitted\n');

  const resources = await loadResourcesPGFirst();

  // Filter to resources that need classification
  const toClassify = resources.filter((r) => {
    if (!r.url) return false;
    // Skip already classified
    if (r.enrichment_status === 'classified' || r.enrichment_status === 'enriched' || r.enrichment_status === 'reviewed') {
      return false;
    }
    return true;
  }).slice(0, limit);

  console.log(`  ${toClassify.length} resources to classify\n`);

  if (toClassify.length === 0) {
    console.log('  ✅ All resources already classified');
    return { exitCode: 0, output: 'All resources already classified' };
  }

  // Build batch requests
  const requests: BatchRequest[] = toClassify.map((r) => ({
    custom_id: r.id,
    params: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: CLASSIFICATION_SYSTEM,
      messages: [
        {
          role: 'user' as const,
          content: classificationPrompt({
            id: r.id,
            url: r.url,
            title: r.title || null,
            type: r.type || null,
            content_snippet: (r.abstract || r.summary || '').slice(0, 500) || null,
          }),
        },
      ],
    },
  }));

  // Estimate cost
  const avgInputTokens = 300;
  const avgOutputTokens = 150;
  const inputCostPer1M = 0.40; // Haiku batch: 50% of $0.80
  const outputCostPer1M = 2.00; // Haiku batch: 50% of $4.00
  const estimatedCost = (
    (requests.length * avgInputTokens * inputCostPer1M) / 1_000_000 +
    (requests.length * avgOutputTokens * outputCostPer1M) / 1_000_000
  );

  console.log(`  Estimated cost: $${estimatedCost.toFixed(2)}`);
  console.log(`  Requests: ${requests.length}`);

  if (dryRun) {
    console.log('\n  Would submit batch with these sample requests:');
    for (const r of requests.slice(0, 3)) {
      console.log(`    ${r.custom_id}: ${r.params.messages[0].content.slice(0, 100)}...`);
    }
    return { exitCode: 0, output: `Would classify ${requests.length} resources (~$${estimatedCost.toFixed(2)})` };
  }

  // Submit batch
  const batchIdResult = await createBatch(requests);
  console.log(`\n  Batch submitted: ${batchIdResult}`);
  console.log(`  Monitor with: crux resources classify status --batch-id=${batchIdResult}`);
  console.log(`  Or poll:       crux resources classify poll --batch-id=${batchIdResult}`);

  return { exitCode: 0, output: `Batch ${batchIdResult} submitted with ${requests.length} requests` };
}

async function downloadAndApplyClassification(batchId: string, dryRun: boolean): Promise<CommandResult> {
  console.log(`  Downloading results for batch ${batchId}...`);

  const results = await downloadBatchResults(batchId);
  console.log(`  Got ${results.length} results`);

  let applied = 0;
  let errors = 0;

  const updates: Array<{
    id: string;
    url: string;
    resourceSubtype: string;
    resourcePurpose: string;
    contextNote: string;
    enrichmentStatus: string;
  }> = [];

  const resources = await loadResourcesPGFirst();
  const resourceMap = new Map(resources.map((r) => [r.id, r]));

  for (const item of results) {
    if (item.result.type !== 'succeeded' || !item.result.message) {
      errors++;
      continue;
    }

    try {
      const text = item.result.message.content[0]?.text || '';
      const parsed = JSON.parse(text) as ClassificationResult;
      const resource = resourceMap.get(item.custom_id);
      if (!resource) continue;

      updates.push({
        id: item.custom_id,
        url: resource.url,
        resourceSubtype: parsed.resource_subtype,
        resourcePurpose: parsed.resource_purpose,
        contextNote: parsed.context_note,
        enrichmentStatus: 'classified',
      });
      applied++;
    } catch (err) {
      errors++;
      console.warn(`  ✗ Parse error for ${item.custom_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`  Parsed ${applied} results (${errors} errors)`);

  if (!dryRun && updates.length > 0) {
    // Write in batches of 200
    for (let i = 0; i < updates.length; i += 200) {
      const batch = updates.slice(i, i + 200);
      const result = await apiRequest(
        'POST',
        '/api/resources/batch',
        { items: batch },
        30000,
      );
      if (result.ok) {
        console.log(`  ✓ Written batch ${Math.floor(i / 200) + 1}`);
      } else {
        console.error(`  ✗ Batch write failed: ${result.message}`);
      }
    }
  }

  return { exitCode: 0, output: `Applied ${applied} classifications` };
}
