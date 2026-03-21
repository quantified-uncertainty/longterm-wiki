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
import { getCitationContentByUrl, listCitationContent } from '../lib/wiki-server/citations.ts';
import {
  createBatch,
  pollBatch,
  downloadBatchResults,
  type BatchRequest,
} from './batch-client.ts';
import { ENRICHMENT_SYSTEM, enrichmentPrompt } from './prompts.ts';
import type { Resource } from '../resource-types.ts';
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
  const dryRun = !!(options['dry-run'] || options.dryRun);
  const limit = (options.limit as number) || 5000;
  const batchId = (options['batch-id'] || options.batchId) as string;

  if (subcommand === 'status' && batchId) {
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
    const force = !!(options['force'] || options.force);
    return await submitEnrichment(limit, subcommand === 'dry-run' || dryRun, force);
  }

  if (subcommand === 'download' && batchId) {
    return await downloadAndApplyEnrichment(batchId, dryRun);
  }

  if (subcommand === 'poll' && batchId) {
    const status = await pollBatch(batchId);
    if (status.processing_status === 'ended') {
      return await downloadAndApplyEnrichment(batchId, dryRun);
    }
    return { exitCode: 0, output: '' };
  }

  console.log(`Usage:
  crux resources deep-enrich submit [--limit=N] [--dry-run] [--force]  Submit enrichment batch
  crux resources deep-enrich status --batch-id=ID              Check batch status
  crux resources deep-enrich poll --batch-id=ID                Poll until complete, then apply
  crux resources deep-enrich download --batch-id=ID            Download and apply results`);
  return { exitCode: 0, output: '' };
}

/**
 * Load fetched content from citation_content table for a list of resources.
 *
 * Strategy: build a URL→resourceId map from the resources, then fetch content
 * individually for matching URLs. Uses the bulk listing endpoint to identify
 * which URLs have content, then fetches full text for matches only.
 */
async function loadContentForResources(
  resources: Resource[],
  concurrency = 20,
): Promise<Map<string, string>> {
  const contentMap = new Map<string, string>();

  // Build URL → resource ID lookup
  const urlToId = new Map<string, string>();
  for (const r of resources) {
    if (r.url) urlToId.set(r.url, r.id);
  }

  // Step 1: Get all cached URLs from citation_content (bulk, no fullText)
  console.log(`  Loading content index from citation_content...`);
  const cachedUrls = new Set<string>();
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const result = await listCitationContent(pageSize, offset);
    if (!result.ok || !result.data) break;
    const entries = (result.data as { entries: Array<{ url: string }> }).entries;
    if (entries.length === 0) break;
    for (const e of entries) cachedUrls.add(e.url);
    offset += entries.length;
    if (entries.length < pageSize) break;
  }
  console.log(`  Found ${cachedUrls.size} cached URLs`);

  // Step 2: Filter to resources that have cached content
  const toFetch = resources.filter(r => r.url && cachedUrls.has(r.url));
  console.log(`  ${toFetch.length}/${resources.length} resources have cached content — fetching full text...`);

  if (toFetch.length === 0) return contentMap;

  // Step 3: Fetch full text for matching resources (concurrent)
  let idx = 0;
  let loaded = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (idx < toFetch.length) {
      const i = idx++;
      const r = toFetch[i];
      try {
        const result = await getCitationContentByUrl(r.url);
        if (result.ok && result.data) {
          const d = result.data as Record<string, unknown>;
          const text = (d.fullText as string) || (d.fullTextPreview as string) || '';
          if (text) {
            contentMap.set(r.id, text);
            loaded++;
          }
        }
      } catch {
        failed++;
      }

      if ((loaded + failed) % 100 === 0) {
        process.stdout.write(`\r  Fetched ${loaded + failed}/${toFetch.length} (${loaded} with content)`);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, toFetch.length) },
    () => worker(),
  );
  await Promise.all(workers);
  console.log(`\r  Content loaded: ${loaded} with text, ${failed} errors, ${resources.length - loaded} without content`);

  return contentMap;
}

async function submitEnrichment(limit: number, dryRun: boolean, force: boolean = false): Promise<CommandResult> {
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

  // Load fetched content from citation_content table
  const contentMap = await loadContentForResources(toEnrich);
  console.log();

  // Guardrail: warn if content hit rate is unexpectedly low
  const contentHitRate = contentMap.size / toEnrich.length;
  if (contentHitRate < 0.5 && toEnrich.length >= 50) {
    console.warn(`\n  ⚠ WARNING: Only ${(contentHitRate * 100).toFixed(0)}% of resources have cached content.`);
    console.warn(`    This means the LLM will work from URL+title only for ${toEnrich.length - contentMap.size} resources.`);
    console.warn(`    Consider running 'crux resources fetch-all' first to cache content.`);
    console.warn(`    To proceed anyway, re-run with --force.\n`);

    if (!force && !dryRun) {
      return { exitCode: 1, output: `Aborted: content hit rate too low (${(contentHitRate * 100).toFixed(0)}%). Use --force to override.` };
    }
  }

  // Build batch requests
  const requests: BatchRequest[] = toEnrich.map((r) => {
    // Use fetched content from citation_content, falling back to resource fields
    const content = contentMap.get(r.id) || r.abstract || r.summary || '';

    return {
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
              content: content.slice(0, 4000) || null,
              existing_tags: r.tags || null,
            }),
          },
        ],
      },
    };
  });

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
      let text = item.result.message.content[0]?.text || '';
      // Strip markdown code fences if present (LLMs sometimes wrap JSON in ```json ... ```)
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
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
