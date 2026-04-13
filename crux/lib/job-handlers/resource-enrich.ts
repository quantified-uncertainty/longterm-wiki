/**
 * Resource Enrichment Job Handler
 *
 * Combines classification and deep enrichment in a single LLM call per resource.
 * Triggered automatically by resource-ingest when a resource is reachable,
 * or manually via the job queue.
 *
 * Params:
 *   - resourceId: string (required) — resource stableId
 *   - url: string (required) — resource URL
 *
 * Flow:
 *   1. Validate params
 *   2. Check if resource is already enriched (skip guard)
 *   3. Load cached content from citation_content
 *   4. Call Claude (Sonnet, standard API) with combined classify+enrich prompt
 *   5. Parse and validate JSON response
 *   6. Persist enrichment data back to the resource
 *
 * Part of the automated resource pipeline (#3499, Problem 3).
 */

import type { JobHandlerResult, JobHandlerContext } from './types.ts';
import { z } from 'zod';
import { createLlmClient, MODELS, callLlm } from '../llm.ts';
import { parseJsonResponse } from '../anthropic.ts';
import { getCitationContentByUrl } from '../wiki-server/citations.ts';
import { getResource, upsertResourceBatch, suggestResourcesApi } from '../wiki-server/resources.ts';
import { COMBINED_ENRICHMENT_SYSTEM, combinedEnrichmentPrompt } from '../../resource-enrichment/prompts.ts';
import { classifyByUrl, FAST_PATH_THRESHOLD } from '../sourcing/url-quality.ts';

// ---------------------------------------------------------------------------
// getResource() returns ResourceRow & { citedBy: string[] } — we use fields
// directly from that type without re-declaring an interface.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Params validation
// ---------------------------------------------------------------------------

const ResourceEnrichParamsSchema = z.object({
  resourceId: z.string().min(1),
  url: z.string().url(),
  // When true, the upstream `resource-ingest` job detected that the cached
  // content changed since the previous fetch — bypass the "already enriched"
  // skip guard so we re-classify with fresh data. Optional for backwards
  // compatibility (older job rows in the queue won't have it).
  contentChanged: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// LLM response validation
// ---------------------------------------------------------------------------

const CombinedEnrichmentResultSchema = z.object({
  resource_subtype: z.string().min(1),
  resource_purpose: z.string().min(1),
  context_note: z.string().max(500).default(''),  // matches UpsertResourceSchema.contextNote max(500)
  clean_title: z.string().nullable(),
  summary: z.string().min(1),
  key_points: z.array(z.string().max(200)).min(1).max(10),
  tags: z.array(z.string()).max(10),
  importance_score: z.number().int().min(0).max(100),
  discovered_urls: z.array(z.string().url()).max(5).optional(),
});

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleResourceEnrich(
  params: Record<string, unknown>,
  ctx: JobHandlerContext,
): Promise<JobHandlerResult> {
  const parsed = ResourceEnrichParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      success: false,
      data: {},
      error: `Invalid params: ${parsed.error.message.slice(0, 300)}`,
    };
  }
  const { resourceId, url, contentChanged } = parsed.data;

  if (ctx.verbose) {
    console.log(`[resource-enrich] Enriching ${url} (resource=${resourceId})`);
  }

  const startTime = Date.now();

  try {
    // 1. Fetch resource metadata and check skip guard
    const resourceResult = await getResource(resourceId);
    if (!resourceResult.ok) {
      return {
        success: false,
        data: { resourceId, url },
        error: `Failed to fetch resource: ${resourceResult.message}`,
      };
    }

    const resource = resourceResult.data;

    // Skip guard: bypass when the upstream ingest reports `contentChanged: true`,
    // so we can re-classify resources whose cached content has shifted.
    // Without this bypass, the "re-classify on re-fetch" temporal story is a lie.
    if (
      (resource.enrichmentStatus === 'enriched' || resource.enrichmentStatus === 'reviewed') &&
      contentChanged !== true
    ) {
      if (ctx.verbose) {
        console.log(`[resource-enrich] Skipping ${resourceId} — already ${resource.enrichmentStatus}`);
      }
      return {
        success: true,
        data: { resourceId, url, skipped: true, reason: `Already ${resource.enrichmentStatus}` },
      };
    }

    if (contentChanged === true && ctx.verbose) {
      console.log(`[resource-enrich] Re-enriching ${resourceId} — content changed since last fetch`);
    }

    // 2. Load cached content from citation_content
    let content: string | null = null;
    const contentResult = await getCitationContentByUrl(url);
    if (contentResult.ok && contentResult.data) {
      const d = contentResult.data as Record<string, unknown>;
      content = (d.fullText as string) || (d.fullTextPreview as string) || null;
    }

    const contentAvailable = content != null && content.length > 0;

    if (ctx.verbose) {
      console.log(`[resource-enrich] Content ${contentAvailable ? `available (${content!.length} chars)` : 'not available — using URL+title only'}`);
    }

    // 3. Build combined classify+enrich prompt
    const prompt = combinedEnrichmentPrompt({
      url,
      title: resource.title,
      type: resource.type,
      summary: resource.summary,
      content,
      existing_tags: resource.tags,
    });

    // 4. Call LLM
    const client = createLlmClient();
    const llmResult = await callLlm(client, { system: COMBINED_ENRICHMENT_SYSTEM, user: prompt }, {
      model: MODELS.sonnet,
      maxTokens: 1200,
      temperature: 0,
      retryLabel: `resource-enrich-${resourceId}`,
    });

    // 5. Parse and validate response
    const raw = parseJsonResponse(llmResult.text);
    const validated = CombinedEnrichmentResultSchema.safeParse(raw);

    if (!validated.success) {
      return {
        success: false,
        data: { resourceId, url, rawResponse: llmResult.text.slice(0, 500) },
        error: `LLM response validation failed: ${validated.error.message.slice(0, 300)}`,
      };
    }

    const result = validated.data;

    // URL-heuristic fast-path: deterministically override `resource_purpose`
    // when the URL clearly points at a homepage, regardless of what the LLM
    // returned. The LLM still ran (we need summary/key_points/etc.), so the
    // savings here are correctness, not cost — see Discussion #4221.
    const urlClass = classifyByUrl(url);
    const urlHeuristicHomepage =
      urlClass.purpose === 'homepage' && urlClass.confidence >= FAST_PATH_THRESHOLD;
    const finalResourcePurpose = urlHeuristicHomepage ? 'homepage' : result.resource_purpose;

    if (urlHeuristicHomepage && ctx.verbose) {
      console.log(`[resource-enrich] URL heuristic override: resource_purpose='homepage' (${urlClass.reasons.join(',')})`);
    }

    // 6. Persist enrichment data
    const update: Record<string, unknown> = {
      id: resourceId,
      url,
      enrichmentStatus: 'enriched',
      resourceSubtype: result.resource_subtype,
      resourcePurpose: finalResourcePurpose,
      contextNote: result.context_note,
      summary: result.summary,
      keyPoints: result.key_points,
      tags: result.tags,
      importanceScore: result.importance_score / 100, // normalize 0-100 → 0-1
    };

    // Only update title if LLM provided a clean one
    if (result.clean_title) {
      if (
        !resource.title ||
        resource.title.length < 20 ||
        resource.title.includes('...') ||
        resource.title === url
      ) {
        update.title = result.clean_title;
      }
    }

    const writeResult = await upsertResourceBatch([update as Parameters<typeof upsertResourceBatch>[0][number]]);
    if (!writeResult.ok) {
      return {
        success: false,
        data: { resourceId, url },
        error: `Failed to persist enrichment: ${writeResult.message}`,
      };
    }

    // 7. Fire-and-forget: suggest discovered URLs for ingestion
    const discoveredUrls = result.discovered_urls?.filter(
      (u) => u !== url, // exclude the source URL itself
    );
    if (discoveredUrls && discoveredUrls.length > 0) {
      suggestResourcesApi({ urls: discoveredUrls }).catch((e: unknown) => {
        console.warn(
          `[resource-enrich] Failed to suggest discovered URLs for ${resourceId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
      if (ctx.verbose) {
        console.log(`[resource-enrich] Suggested ${discoveredUrls.length} discovered URL(s) for ingestion`);
      }
    }

    const durationMs = Date.now() - startTime;
    const estimatedCost = estimateCost(llmResult.usage.input_tokens, llmResult.usage.output_tokens);

    if (ctx.verbose) {
      console.log(`[resource-enrich] Done: ${resourceId} in ${durationMs}ms (~$${estimatedCost.toFixed(4)})`);
    }

    return {
      success: true,
      data: {
        resourceId,
        url,
        contentAvailable,
        durationMs,
        inputTokens: llmResult.usage.input_tokens,
        outputTokens: llmResult.usage.output_tokens,
        estimatedCostUsd: estimatedCost,
        fieldsWritten: Object.keys(update).filter(k => k !== 'id' && k !== 'url'),
        discoveredUrls: discoveredUrls?.length ? discoveredUrls : undefined,
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: { resourceId, url, durationMs: Date.now() - startTime },
      error: error.slice(0, 500),
    };
  }
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function estimateCost(inputTokens: number, outputTokens: number): number {
  // Sonnet standard API pricing (as of 2026-03)
  const inputCostPer1M = 3.00;
  const outputCostPer1M = 15.00;
  return (inputTokens * inputCostPer1M + outputTokens * outputCostPer1M) / 1_000_000;
}
