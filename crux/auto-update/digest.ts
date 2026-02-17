/**
 * News Digest Builder
 *
 * Takes raw feed items and produces a structured digest:
 * 1. Deduplicates items with similar titles
 * 2. Uses LLM to score relevance to AI safety wiki topics
 * 3. Extracts topic tags and matches to wiki entity IDs
 * 4. Filters out low-relevance items
 *
 * Cost: ~$0.02-0.05 per digest (Haiku, typically <2000 items)
 */

import { createClient, callClaude, MODELS, parseJsonResponse } from '../lib/anthropic.ts';
import type { FeedItem, DigestItem, NewsDigest } from './types.ts';

// ── Deduplication ───────────────────────────────────────────────────────────

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

/**
 * Deduplicate items within this batch and against previously seen items.
 * @param previouslySeen - Hashes from prior runs (loaded from state file)
 */
function deduplicateItems(items: FeedItem[], previouslySeen?: Set<string>): { items: FeedItem[]; skippedAsSeen: number } {
  const seen = new Set<string>(previouslySeen || []);
  const result: FeedItem[] = [];
  let skippedAsSeen = 0;

  for (const item of items) {
    const key = normalizeTitle(item.title);
    if (key.length < 5) continue; // Skip empty/trivial titles
    if (seen.has(key)) {
      if (previouslySeen?.has(key)) skippedAsSeen++;
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return { items: result, skippedAsSeen };
}

// ── LLM Classification ─────────────────────────────────────────────────────

/**
 * Batch-classify feed items for AI safety wiki relevance.
 * Processes items in batches to stay within context limits.
 */
async function classifyItems(
  items: FeedItem[],
  entityIds: string[],
  verbose = false,
): Promise<DigestItem[]> {
  const client = createClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY required for digest building');

  const BATCH_SIZE = 30;
  const allDigestItems: DigestItem[] = [];

  // Sample entity IDs to give the model context (don't send all 600+)
  const entitySample = entityIds.slice(0, 150).join(', ');

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    if (verbose) {
      console.log(`  Classifying batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)...`);
    }

    const itemList = batch.map((item, idx) => (
      `${idx + 1}. [${item.sourceId}] "${item.title}" (${item.publishedAt})\n   ${item.summary.slice(0, 200)}`
    )).join('\n');

    const result = await callClaude(client, {
      model: MODELS.haiku,
      maxTokens: 4000,
      systemPrompt: `You classify news items for an AI safety wiki. Score each item's relevance (0-100) to AI safety, alignment, governance, compute, AI labs, existential risk, or related topics. Extract topic tags and match to wiki entity IDs where possible.

Known wiki entity IDs (sample): ${entitySample}

Output ONLY a JSON array. Each element: { "index": <1-based>, "relevanceScore": <0-100>, "topics": ["tag1", "tag2"], "entities": ["entity-id-1"], "skip": false }

Set skip=true for items clearly irrelevant to AI safety (e.g., sports, entertainment, unrelated tech). Be generous with relevance — if it could plausibly inform any wiki page, include it.`,
      userPrompt: `Classify these ${batch.length} news items:\n\n${itemList}`,
    });

    try {
      const parsed = parseJsonResponse(result.text) as Array<{
        index: number;
        relevanceScore: number;
        topics: string[];
        entities: string[];
        skip: boolean;
      }>;

      for (const classification of parsed) {
        if (classification.skip) continue;
        const itemIdx = classification.index - 1;
        if (itemIdx < 0 || itemIdx >= batch.length) continue;

        const item = batch[itemIdx];
        allDigestItems.push({
          title: item.title,
          url: item.url,
          sourceId: item.sourceId,
          publishedAt: item.publishedAt,
          summary: item.summary,
          relevanceScore: classification.relevanceScore,
          topics: classification.topics || [],
          entities: classification.entities || [],
        });
      }
    } catch (err) {
      // If parsing fails for a batch, include all items with default scores
      if (verbose) {
        console.log(`    Classification parsing failed, including all items with default scores`);
      }
      for (const item of batch) {
        allDigestItems.push({
          title: item.title,
          url: item.url,
          sourceId: item.sourceId,
          publishedAt: item.publishedAt,
          summary: item.summary,
          relevanceScore: 50,
          topics: item.categories,
          entities: [],
        });
      }
    }
  }

  return allDigestItems;
}

// ── Main Export ──────────────────────────────────────────────────────────────

export interface BuildDigestOptions {
  /** Minimum relevance score to include (default: 20) */
  minRelevance?: number;
  /** Known entity IDs from the wiki for matching */
  entityIds?: string[];
  /** Previously seen item hashes (from prior runs) to skip */
  previouslySeen?: Set<string>;
  verbose?: boolean;
}

/**
 * Build a news digest from raw feed items.
 *
 * Steps:
 * 1. Deduplicates items
 * 2. Classifies with LLM (relevance scoring, topic extraction)
 * 3. Filters by minimum relevance
 * 4. Sorts by relevance score descending
 */
export async function buildDigest(
  feedItems: FeedItem[],
  fetchedSources: string[],
  failedSources: string[],
  options: BuildDigestOptions = {},
): Promise<NewsDigest> {
  const { minRelevance = 20, entityIds = [], previouslySeen, verbose = false } = options;

  if (verbose) {
    console.log(`\nBuilding digest from ${feedItems.length} raw items...`);
    if (previouslySeen) {
      console.log(`  ${previouslySeen.size} previously seen items loaded for cross-run dedup`);
    }
  }

  // Step 1: Deduplicate (within batch + against prior runs)
  const { items: unique, skippedAsSeen } = deduplicateItems(feedItems, previouslySeen);
  if (verbose) {
    console.log(`  ${feedItems.length} → ${unique.length} after dedup${skippedAsSeen > 0 ? ` (${skippedAsSeen} seen in prior runs)` : ''}`);
  }

  // Step 2: If no items, return empty digest
  if (unique.length === 0) {
    return {
      date: new Date().toISOString().slice(0, 10),
      itemCount: 0,
      items: [],
      fetchedSources,
      failedSources,
    };
  }

  // Step 3: LLM classification
  const classified = await classifyItems(unique, entityIds, verbose);

  // Step 4: Filter by relevance
  const filtered = classified.filter(item => item.relevanceScore >= minRelevance);

  // Step 5: Sort by relevance
  filtered.sort((a, b) => b.relevanceScore - a.relevanceScore);

  if (verbose) {
    console.log(`  ${classified.length} classified → ${filtered.length} above relevance threshold (${minRelevance})`);
  }

  return {
    date: new Date().toISOString().slice(0, 10),
    itemCount: filtered.length,
    items: filtered,
    fetchedSources,
    failedSources,
  };
}
