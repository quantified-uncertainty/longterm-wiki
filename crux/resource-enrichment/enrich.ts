/**
 * Resource Enrichment — LLM Deep Enrichment (Phase 4b)
 *
 * Uses the Anthropic Batch API with Sonnet to deeply enrich all resources:
 * - Clean title (if current is bad/truncated)
 * - Summary (1-3 sentences)
 * - Key points (3-5 bullets)
 * - Tags
 * - Importance score (0-100)
 * - Type-specific fields for sub-tables
 *
 * Cost: ~$100 for 5,000 resources with Sonnet batch (50% discount).
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import {
  createBatch,
  pollBatch,
  downloadBatchResults,
  type BatchRequest,
} from './batch-client.ts';
import { ENRICHMENT_SYSTEM, enrichmentPrompt } from './prompts.ts';
import type { CommandResult } from '../lib/cli.ts';

interface EnrichmentResult {
  clean_title: string | null;
  summary: string;
  key_points: string[];
  tags: string[];
  importance_score: number;
  resource_purpose: string;
  context_note: string;
}

export async function deepEnrichCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const subcommand = args[0] || 'status';
  const dryRun = options['dry-run'] as boolean;
  const limit = (options.limit as number) || 5000;
  const batchId = options['batch-id'] as string;

  if (subcommand === 'status' && batchId) {
    const { getBatchStatus } = await import('./batch-client.ts');
    const status = await getBatchStatus(batchId);
    console.log(`Batch ${batchId}:`);
    console.log(`  Status: ${status.processing_status}`);
    console.log(`  Succeeded: ${status.request_counts.succeeded}`);
    console.log(`  Errored: ${status.request_counts.errored}`);
    console.log(`  Processing: ${status.request_counts.processing}`);
    return { exitCode: 0 };
  }

  if (subcommand === 'submit' || subcommand === 'dry-run') {
    return await submitEnrichment(limit, subcommand === 'dry-run' || dryRun);
  }

  if (subcommand === 'download' && batchId) {
    return await downloadAndApplyEnrichment(batchId, dryRun);
  }

  if (subcommand === 'poll' && batchId) {
    const status = await pollBatch(batchId);
    if (status.processing_status === 'ended') {
      return await downloadAndApplyEnrichment(batchId, dryRun);
    }
    return { exitCode: 0 };
  }

  console.log(`Usage:
  crux resources deep-enrich submit [--limit=N] [--dry-run]    Submit enrichment batch
  crux resources deep-enrich status --batch-id=ID              Check batch status
  crux resources deep-enrich poll --batch-id=ID                Poll until complete, then apply
  crux resources deep-enrich download --batch-id=ID            Download and apply results`);
  return { exitCode: 0 };
}

async function submitEnrichment(limit: number, dryRun: boolean): Promise<CommandResult> {
  console.log('🔬 Deep Resource Enrichment (Sonnet batch)\n');
  if (dryRun) console.log('  DRY RUN — batch will not be submitted\n');

  const resources = await loadResourcesPGFirst();

  // Filter to classified-but-not-yet-enriched resources
  const toEnrich = resources.filter((r) => {
    if (!r.url) return false;
    if (r.enrichment_status === 'enriched' || r.enrichment_status === 'reviewed') return false;
    return true;
  }).slice(0, limit);

  console.log(`  ${toEnrich.length} resources to enrich\n`);

  if (toEnrich.length === 0) {
    console.log('  ✅ All resources already enriched');
    return { exitCode: 0, output: 'All resources already enriched' };
  }

  // Build batch requests
  const requests: BatchRequest[] = toEnrich.map((r) => ({
    custom_id: r.id,
    params: {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: ENRICHMENT_SYSTEM,
      messages: [
        {
          role: 'user' as const,
          content: enrichmentPrompt({
            id: r.id,
            url: r.url,
            title: r.title || null,
            type: r.type || null,
            summary: r.summary || null,
            content: (r.abstract || r.summary || '').slice(0, 4000) || null,
            existing_tags: r.tags || null,
          }),
        },
      ],
    },
  }));

  // Estimate cost
  const avgInputTokens = 1500;
  const avgOutputTokens = 400;
  const inputCostPer1M = 1.50; // Sonnet batch: 50% of $3.00
  const outputCostPer1M = 7.50; // Sonnet batch: 50% of $15.00
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
    return { exitCode: 0, output: `Would enrich ${requests.length} resources (~$${estimatedCost.toFixed(2)})` };
  }

  // Submit batch
  const batchIdResult = await createBatch(requests);
  console.log(`\n  Batch submitted: ${batchIdResult}`);
  console.log(`  Monitor with: crux resources deep-enrich status --batch-id=${batchIdResult}`);
  console.log(`  Or poll:       crux resources deep-enrich poll --batch-id=${batchIdResult}`);

  return { exitCode: 0, output: `Batch ${batchIdResult} submitted with ${requests.length} requests` };
}

async function downloadAndApplyEnrichment(batchId: string, dryRun: boolean): Promise<CommandResult> {
  console.log(`  Downloading results for batch ${batchId}...`);

  const results = await downloadBatchResults(batchId);
  console.log(`  Got ${results.length} results`);

  let applied = 0;
  let errors = 0;

  const updates: Array<{
    id: string;
    url: string;
    title?: string;
    summary?: string;
    keyPoints?: string[];
    tags?: string[];
    importanceScore?: number;
    resourcePurpose?: string;
    contextNote?: string;
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
      const parsed = JSON.parse(text) as EnrichmentResult;
      const resource = resourceMap.get(item.custom_id);
      if (!resource) continue;

      const update: Record<string, unknown> = {
        id: item.custom_id,
        url: resource.url,
        enrichmentStatus: 'enriched',
      };

      // Only update title if LLM provided a clean one and current title looks bad
      if (parsed.clean_title && resource.title && (
        resource.title.length < 20 ||
        resource.title.includes('...') ||
        resource.title === resource.url
      )) {
        update.title = parsed.clean_title;
      }

      if (parsed.summary) update.summary = parsed.summary;
      if (parsed.key_points?.length > 0) update.keyPoints = parsed.key_points;
      if (parsed.tags?.length > 0) update.tags = parsed.tags;
      if (parsed.importance_score != null) update.importanceScore = parsed.importance_score / 100; // normalize to 0-1
      if (parsed.resource_purpose) update.resourcePurpose = parsed.resource_purpose;
      if (parsed.context_note) update.contextNote = parsed.context_note;

      updates.push(update as typeof updates[number]);
      applied++;
    } catch (err) {
      errors++;
      console.warn(`  ✗ Parse error for ${item.custom_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`  Parsed ${applied} results (${errors} errors)`);

  if (!dryRun && updates.length > 0) {
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

  return { exitCode: 0, output: `Applied ${applied} enrichments` };
}
