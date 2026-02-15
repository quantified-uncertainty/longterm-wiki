#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Rank Pages by Importance
 *
 * Uses Claude to decide where unranked pages belong in the importance ranking.
 * For each page, performs a binary search through the existing ranking by asking
 * Claude "is this page more or less important than X?" at each step.
 *
 * Usage:
 *   pnpm crux importance rank <page-id>          # Rank a single page
 *   pnpm crux importance rank --batch=10          # Rank 10 unranked pages
 *   pnpm crux importance rank --batch=10 --auto   # Non-interactive (no confirmation)
 */

import { readFileSync } from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { createLogger, createProgress } from '../lib/output.ts';
import { loadPages, CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { createClient, callClaude, MODELS } from '../lib/anthropic.ts';
import {
  loadRanking,
  saveRanking,
  findUnrankedPages,
  insertAt,
  getNeighbors,
} from '../lib/importance-ranking.ts';

const args = parseCliArgs(process.argv.slice(2));
const log = createLogger(args.ci as boolean);
const c = log.colors;

const SYSTEM_PROMPT = `You are an AI safety researcher ranking wiki pages by their importance to understanding and mitigating AI risk.

When comparing two topics, consider:
1. How central is this topic to AI safety? (core alignment concepts > peripheral topics)
2. How much would understanding this topic help someone working on AI safety?
3. How significant is this topic's real-world impact on AI risk trajectories?
4. How many other important AI safety topics depend on understanding this one?

You must respond with ONLY "A" or "B" — nothing else. No explanation, no hedging.`;

interface PageInfo {
  id: string;
  title: string;
  description?: string | null;
  category?: string;
}

function getPageInfo(pageId: string, pagesMap: Map<string, PageInfo>): PageInfo {
  return pagesMap.get(pageId) || { id: pageId, title: pageId };
}

function formatPageForComparison(page: PageInfo): string {
  let text = `"${page.title}" (${page.id})`;
  if (page.description) {
    text += `\n  Description: ${page.description}`;
  }
  if (page.category) {
    text += `\n  Category: ${page.category}`;
  }
  return text;
}

/**
 * Binary search to find where a page belongs in the ranking.
 * Returns the 1-based position where the page should be inserted.
 */
async function findPosition(
  pageId: string,
  ranking: string[],
  pagesMap: Map<string, PageInfo>,
  client: ReturnType<typeof createClient>,
): Promise<number> {
  if (ranking.length === 0) return 1;

  const pageInfo = getPageInfo(pageId, pagesMap);

  let lo = 0;
  let hi = ranking.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midInfo = getPageInfo(ranking[mid], pagesMap);

    const prompt = `Which topic is MORE important to AI safety?

A: ${formatPageForComparison(pageInfo)}

B: ${formatPageForComparison(midInfo)}

Reply with only "A" or "B".`;

    const result = await callClaude(client!, {
      model: MODELS.haiku,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: prompt,
      maxTokens: 10,
      temperature: 0,
    });

    const answer = result.text.trim().toUpperCase();

    if (answer === 'A') {
      // Page is more important than mid → search upper half
      hi = mid - 1;
    } else {
      // Page is less important than mid → search lower half
      lo = mid + 1;
    }
  }

  return lo + 1; // Convert to 1-based position
}

async function main() {
  const pages = loadPages();
  const pagesMap = new Map<string, PageInfo>();
  for (const p of pages) {
    pagesMap.set(p.id, {
      id: p.id,
      title: p.title,
      description: p.description || p.llmSummary,
      category: p.category,
    });
  }

  const { ranking } = loadRanking();
  const positionalArgs = args._positional as string[];

  // Determine which pages to rank
  let toRank: string[];

  if (positionalArgs.length > 0) {
    // Rank specific page(s)
    toRank = positionalArgs;
  } else if (args.batch) {
    // Rank a batch of unranked pages
    const limit = parseInt(args.batch as string, 10);
    const unranked = findUnrankedPages(ranking);

    if (unranked.length === 0) {
      log.success('All pages are ranked!');
      process.exit(0);
    }

    // Prioritize pages that already have some importance score
    toRank = unranked
      .map((id) => {
        const page = pages.find((p) => p.id === id);
        return { id, importance: page?.importance ?? 0 };
      })
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, limit)
      .map((p) => p.id);

    log.info(`Ranking ${toRank.length} of ${unranked.length} unranked pages`);
  } else {
    log.error('Specify a page ID or use --batch=N');
    process.exit(1);
  }

  // Verify pages exist
  for (const id of toRank) {
    if (!pagesMap.has(id)) {
      log.warn(`Page not found: ${id} (skipping)`);
    }
  }
  toRank = toRank.filter((id) => pagesMap.has(id));

  if (toRank.length === 0) {
    log.error('No valid pages to rank.');
    process.exit(1);
  }

  // Initialize Claude client
  const client = createClient();
  if (!client) {
    log.error('ANTHROPIC_API_KEY required for LLM-assisted ranking');
    process.exit(1);
  }

  log.heading(`Ranking ${toRank.length} page(s)`);
  console.log('');

  let currentRanking = [...ranking];
  const progress = toRank.length > 1 ? createProgress(toRank.length, 'Ranking') : null;

  for (const pageId of toRank) {
    const info = getPageInfo(pageId, pagesMap);
    const comparisons = Math.ceil(Math.log2(Math.max(currentRanking.length, 1)));

    if (!progress) {
      log.dim(`  Placing "${info.title}" (~${comparisons} comparisons)...`);
    }

    const position = await findPosition(pageId, currentRanking, pagesMap, client);
    currentRanking = insertAt(currentRanking, pageId, position);

    const { above, below } = getNeighbors(currentRanking, position, 2);
    const aboveStr = above.map((id) => getPageInfo(id, pagesMap).title).join(', ');
    const belowStr = below.map((id) => getPageInfo(id, pagesMap).title).join(', ');

    if (!progress) {
      console.log(`  ${c.green}→ Position ${position}/${currentRanking.length}${c.reset}`);
      if (aboveStr) console.log(`    ${c.dim}above: ${aboveStr}${c.reset}`);
      if (belowStr) console.log(`    ${c.dim}below: ${belowStr}${c.reset}`);
      console.log('');
    } else {
      progress.update();
    }
  }

  progress?.done();

  // Save updated ranking
  saveRanking({ ranking: currentRanking });
  log.success(`Ranking saved (${currentRanking.length} total pages)`);

  if (toRank.length > 1) {
    console.log('');
    log.info('Run `pnpm crux importance show --top=20` to review the ranking.');
    log.info('Run `pnpm crux importance sync --apply` to write scores to frontmatter.');
  }
}

main().catch((err) => {
  log.error(`Error: ${err.message}`);
  process.exit(1);
});
