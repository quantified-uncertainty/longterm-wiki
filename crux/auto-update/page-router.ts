/**
 * Page Router
 *
 * Maps news digest items to wiki pages that need updating.
 *
 * Two-stage approach:
 * 1. Fast entity matching: news items mentioning known entities → route to those pages
 * 2. LLM routing: remaining high-relevance items → LLM decides which pages to update
 *
 * Also identifies potential new pages when news covers topics not in the wiki.
 *
 * Cost: ~$0.05-0.15 per routing pass (Haiku)
 */

import { readFileSync } from 'fs';
import { createClient, callClaude, MODELS, parseJsonResponse } from '../lib/anthropic.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import type { NewsDigest, DigestItem, UpdatePlan, PageUpdate, NewPageSuggestion } from './types.ts';

// ── Page Index ──────────────────────────────────────────────────────────────

interface PageEntry {
  id: string;
  title: string;
  entityType: string;
  readerImportance: number;
  updateFrequency: number;
  lastEdited: string;
  categories: string[];
}

function buildPageIndex(): PageEntry[] {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const pages: PageEntry[] = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    if (fm.pageType === 'stub' || fm.pageType === 'documentation' || fm.entityType === 'internal') continue;
    if (fm.evergreen === false) continue;

    const parts = filePath.replace(CONTENT_DIR_ABS + '/', '').split('/');
    const filename = parts[parts.length - 1].replace(/\.(mdx?|md)$/, '');
    const id = filename === 'index' && parts.length >= 2 ? parts[parts.length - 2] : filename;

    pages.push({
      id,
      title: typeof fm.title === 'string' ? fm.title : id,
      entityType: typeof fm.entityType === 'string' ? fm.entityType : 'unknown',
      readerImportance: Number(fm.readerImportance) || 50,
      updateFrequency: Number(fm.update_frequency) || 90,
      lastEdited: typeof fm.lastEdited === 'string' ? fm.lastEdited : '',
      categories: [
        ...(typeof fm.subcategory === 'string' ? [fm.subcategory] : []),
        ...(typeof fm.entityType === 'string' ? [fm.entityType] : []),
      ],
    });
  }

  return pages;
}

// ── Entity Matching ─────────────────────────────────────────────────────────

/**
 * Fast first pass: match digest items to pages via entity IDs mentioned in the items.
 * Returns items that were matched and items that need LLM routing.
 */
function entityMatch(
  digest: NewsDigest,
  pages: PageEntry[],
): { matched: Map<string, DigestItem[]>; unmatched: DigestItem[] } {
  const pageMap = new Map(pages.map(p => [p.id, p]));
  const matched = new Map<string, DigestItem[]>();
  const unmatched: DigestItem[] = [];

  for (const item of digest.items) {
    let wasMatched = false;

    for (const entityId of item.entities) {
      if (pageMap.has(entityId)) {
        if (!matched.has(entityId)) matched.set(entityId, []);
        matched.get(entityId)!.push(item);
        wasMatched = true;
      }
    }

    if (!wasMatched) {
      unmatched.push(item);
    }
  }

  return { matched, unmatched };
}

// ── LLM Routing ─────────────────────────────────────────────────────────────

interface LlmRoutingResult {
  pageUpdates: Array<{
    pageId: string;
    relevantItems: number[];    // indices into the item list
    reason: string;
    suggestedTier: 'polish' | 'standard' | 'deep';
    directions: string;
  }>;
  newPages: Array<{
    suggestedTitle: string;
    suggestedId: string;
    reason: string;
    relevantItems: number[];
    suggestedTier: 'budget' | 'standard' | 'premium';
  }>;
  skipped: Array<{
    index: number;
    reason: string;
  }>;
}

/**
 * Use LLM to route unmatched (or high-relevance) items to wiki pages.
 */
async function llmRoute(
  items: DigestItem[],
  pages: PageEntry[],
  verbose = false,
): Promise<LlmRoutingResult> {
  if (items.length === 0) {
    return { pageUpdates: [], newPages: [], skipped: [] };
  }

  const client = createClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY required for LLM routing');

  // Build a compact page index for the prompt
  // Sort by importance, take top pages
  const topPages = [...pages]
    .sort((a, b) => b.readerImportance - a.readerImportance)
    .slice(0, 200);

  const pageList = topPages.map(p =>
    `${p.id}: "${p.title}" (${p.entityType}, importance=${p.readerImportance})`
  ).join('\n');

  const itemList = items.map((item, idx) =>
    `${idx + 1}. [score=${item.relevanceScore}] "${item.title}" — ${item.summary.slice(0, 150)}`
  ).join('\n');

  if (verbose) {
    console.log(`  LLM routing ${items.length} items against ${topPages.length} pages...`);
  }

  const result = await callClaude(client, {
    model: MODELS.haiku,
    maxTokens: 6000,
    systemPrompt: `You are a routing system for an AI safety wiki. Given news items and a list of wiki pages, decide which pages should be updated based on the news.

Rules:
- Only route items that contain genuinely new, substantive information
- A page should only be updated if the news materially changes or adds to its content
- Suggest "polish" tier for minor additions, "standard" for notable updates, "deep" for major developments
- If news covers a topic not in the wiki, suggest a new page (only for clearly important topics)
- Include specific "directions" — what exactly should be updated on each page
- Skip items that are trivial, redundant, or not actionable for wiki updates

Output ONLY a JSON object with this structure:
{
  "pageUpdates": [{ "pageId": "...", "relevantItems": [1, 3], "reason": "...", "suggestedTier": "standard", "directions": "Add section about..." }],
  "newPages": [{ "suggestedTitle": "...", "suggestedId": "...", "reason": "...", "relevantItems": [5], "suggestedTier": "standard" }],
  "skipped": [{ "index": 2, "reason": "..." }]
}`,
    userPrompt: `## Wiki Pages (top ${topPages.length} by importance)\n${pageList}\n\n## News Items to Route\n${itemList}`,
  });

  try {
    return parseJsonResponse(result.text) as LlmRoutingResult;
  } catch {
    if (verbose) {
      console.log(`  LLM routing parse failed, returning empty results`);
    }
    return { pageUpdates: [], newPages: [], skipped: [] };
  }
}

// ── Cost Estimation ─────────────────────────────────────────────────────────

const COST_MAP: Record<string, number> = {
  polish: 2.5,
  standard: 6.5,
  deep: 12.5,
  budget: 3,
  premium: 10,
};

// ── Routing Helpers (exported for testing) ───────────────────────────────────

const TIER_RANK = { polish: 1, standard: 2, deep: 3 } as const;

/**
 * Deduplicate page updates by pageId.
 * For duplicates: merge relevantNews arrays and take the highest tier.
 */
export function deduplicatePageUpdates(updates: PageUpdate[]): PageUpdate[] {
  const seen = new Map<string, PageUpdate>();

  for (const update of updates) {
    const existing = seen.get(update.pageId);
    if (existing) {
      existing.relevantNews.push(...update.relevantNews);
      if ((TIER_RANK[update.suggestedTier] ?? 0) > (TIER_RANK[existing.suggestedTier] ?? 0)) {
        existing.suggestedTier = update.suggestedTier;
      }
      if (update.directions && !existing.directions.includes(update.directions)) {
        existing.directions += '\n' + update.directions;
      }
    } else {
      seen.set(update.pageId, { ...update, relevantNews: [...update.relevantNews] });
    }
  }

  return [...seen.values()];
}

/**
 * Apply page count and budget limits to a sorted list of updates.
 *
 * Budget floor: when a page's assigned tier exceeds the remaining budget,
 * downgrade to 'polish' instead of skipping entirely — a polish-tier update
 * with relevant context is better than no update at all.
 */
export function applyBudgetAndPageLimits(
  updates: PageUpdate[],
  maxPages: number,
  maxBudget: number,
): { finalUpdates: PageUpdate[]; skippedReasons: Array<{ item: string; reason: string }> } {
  const finalUpdates: PageUpdate[] = [];
  const skippedReasons: Array<{ item: string; reason: string }> = [];
  let budgetRemaining = maxBudget;

  for (const update of updates) {
    if (finalUpdates.length >= maxPages) {
      skippedReasons.push({ item: update.pageTitle, reason: 'Exceeded page limit' });
      continue;
    }

    const cost = COST_MAP[update.suggestedTier] ?? 6.5;
    if (cost > budgetRemaining) {
      // Try downgrading to polish before giving up
      const polishCost = COST_MAP.polish;
      if (update.suggestedTier !== 'polish' && polishCost <= budgetRemaining) {
        budgetRemaining -= polishCost;
        finalUpdates.push({ ...update, suggestedTier: 'polish' });
      } else {
        skippedReasons.push({ item: update.pageTitle, reason: 'Exceeded budget' });
      }
      continue;
    }

    budgetRemaining -= cost;
    finalUpdates.push(update);
  }

  return { finalUpdates, skippedReasons };
}

// ── Main Export ──────────────────────────────────────────────────────────────

export interface RoutingOptions {
  /** Max pages to update in one run (default: 10) */
  maxPages?: number;
  /** Max budget in dollars (default: 50) */
  maxBudget?: number;
  verbose?: boolean;
}

/**
 * Route a news digest to wiki page updates.
 *
 * Returns an UpdatePlan describing which pages to update and what new pages to create.
 */
export async function routeDigest(
  digest: NewsDigest,
  options: RoutingOptions = {},
): Promise<UpdatePlan> {
  const { maxPages = 10, maxBudget = 50, verbose = false } = options;

  if (verbose) {
    console.log(`\nRouting ${digest.itemCount} digest items to wiki pages...`);
  }

  const pages = buildPageIndex();

  // Stage 1: Entity matching
  const { matched, unmatched } = entityMatch(digest, pages);
  if (verbose) {
    console.log(`  Entity match: ${matched.size} pages matched, ${unmatched.length} items unmatched`);
  }

  // Stage 2: LLM routing for unmatched items (only high-relevance ones)
  const highRelevance = unmatched.filter(item => item.relevanceScore >= 40);
  const llmResults = await llmRoute(highRelevance, pages, verbose);

  // Merge results
  const pageUpdateMap = new Map<string, PageUpdate>();

  // From entity matching
  for (const [pageId, items] of matched) {
    const page = pages.find(p => p.id === pageId);
    if (!page) continue;

    pageUpdateMap.set(pageId, {
      pageId,
      pageTitle: page.title,
      reason: `${items.length} news item(s) mention this entity directly`,
      suggestedTier: items.some(i => i.relevanceScore >= 70) ? 'standard' : 'polish',
      relevantNews: items.map(i => ({
        title: i.title,
        url: i.url,
        summary: i.summary.slice(0, 200),
      })),
      directions: `Review and incorporate recent developments: ${items.map(i => i.title).join('; ')}`,
    });
  }

  // From LLM routing
  for (const update of llmResults.pageUpdates) {
    const existing = pageUpdateMap.get(update.pageId);
    const newsItems = update.relevantItems
      .map(idx => highRelevance[idx - 1])
      .filter(Boolean);

    if (existing) {
      // Merge with entity-matched result
      existing.relevantNews.push(...newsItems.map(i => ({
        title: i.title,
        url: i.url,
        summary: i.summary.slice(0, 200),
      })));
      // Upgrade tier if LLM suggests higher
      if ((TIER_RANK[update.suggestedTier] ?? 0) > (TIER_RANK[existing.suggestedTier] ?? 0)) {
        existing.suggestedTier = update.suggestedTier;
      }
      existing.directions += '\n' + update.directions;
    } else {
      const page = pages.find(p => p.id === update.pageId);
      pageUpdateMap.set(update.pageId, {
        pageId: update.pageId,
        pageTitle: page?.title || update.pageId,
        reason: update.reason,
        suggestedTier: update.suggestedTier,
        relevantNews: newsItems.map(i => ({
          title: i.title,
          url: i.url,
          summary: i.summary.slice(0, 200),
        })),
        directions: update.directions,
      });
    }
  }

  // Build new page suggestions
  const newPageSuggestions: NewPageSuggestion[] = llmResults.newPages.map(np => ({
    suggestedTitle: np.suggestedTitle,
    suggestedId: np.suggestedId,
    reason: np.reason,
    relevantNews: np.relevantItems
      .map(idx => highRelevance[idx - 1])
      .filter(Boolean)
      .map(i => ({ title: i.title, url: i.url })),
    suggestedTier: np.suggestedTier,
  }));

  // Sort by importance and apply limits.
  // Pre-build a Map so the sort comparator does O(1) lookups instead of O(n).
  const pageById = new Map(pages.map(p => [p.id, p]));
  const allUpdates = [...pageUpdateMap.values()]
    .sort((a, b) => {
      const pageA = pageById.get(a.pageId);
      const pageB = pageById.get(b.pageId);
      return (pageB?.readerImportance || 0) - (pageA?.readerImportance || 0);
    });

  // Deduplicate by pageId before applying limits (defensive: entity matching
  // across source batches or LLM routing can occasionally produce duplicates).
  const deduplicatedUpdates = deduplicatePageUpdates(allUpdates);

  // Apply budget + count limits (with polish-tier downgrade as budget floor).
  const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(
    deduplicatedUpdates,
    maxPages,
    maxBudget,
  );

  // Add skipped items from LLM
  for (const skip of llmResults.skipped) {
    const item = highRelevance[skip.index - 1];
    if (item) {
      skippedReasons.push({ item: item.title, reason: skip.reason });
    }
  }

  const estimatedCost = finalUpdates.reduce(
    (sum, u) => sum + (COST_MAP[u.suggestedTier] || 6.5),
    0,
  );

  if (verbose) {
    console.log(`  Plan: ${finalUpdates.length} page updates, ${newPageSuggestions.length} new page suggestions`);
    console.log(`  Estimated cost: ~$${estimatedCost.toFixed(0)}`);
  }

  return {
    date: new Date().toISOString().slice(0, 10),
    pageUpdates: finalUpdates,
    newPageSuggestions,
    skippedReasons,
    estimatedCost,
  };
}
