#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Rerank Pages by Importance
 *
 * Sorts pages into an importance ranking using LLM judgment.
 * Supports two dimensions:
 *   - readership: How important is this page for readers? (default)
 *   - research: How much value would deeper investigation yield?
 *
 * Usage:
 *   pnpm crux importance rerank --sample=20                     # Test readership
 *   pnpm crux importance rerank --dimension=research --sample=20 # Test research
 *   pnpm crux importance rerank --all --apply                    # Full readership rerank
 *   pnpm crux importance rerank --dimension=research --all --apply
 *   pnpm crux importance rerank --verify --apply                 # Fix local inversions
 */

import { parseCliArgs } from '../lib/cli.ts';
import { createLogger, createProgress } from '../lib/output.ts';
import { loadPages } from '../lib/content-types.ts';
import { createClient, callClaude, MODELS, sleep } from '../lib/anthropic.ts';
import {
  loadRanking,
  saveRanking,
  getAllPageIds,
  insertAt,
  DEFAULT_DIMENSION,
} from '../lib/importance-ranking.ts';

const args = parseCliArgs(process.argv.slice(2));
const log = createLogger(args.ci as boolean);
const c = log.colors;

const dimension = (args.dimension as string) || DEFAULT_DIMENSION;

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

const costTracker = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,

  track(usage: { input_tokens: number; output_tokens: number }) {
    this.calls++;
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
  },

  estimateCost(model: string): number {
    const pricing: Record<string, [number, number]> = {
      [MODELS.haiku]: [0.80, 4.00],
      [MODELS.sonnet]: [3.00, 15.00],
      [MODELS.opus]: [15.00, 75.00],
    };
    const [inputRate, outputRate] = pricing[model] || [3.00, 15.00];
    return (this.inputTokens * inputRate + this.outputTokens * outputRate) / 1_000_000;
  },

  summary(model: string): string {
    const cost = this.estimateCost(model);
    return `API calls: ${this.calls} | Tokens: ${this.inputTokens.toLocaleString()} in + ${this.outputTokens.toLocaleString()} out | Est. cost: \$${cost.toFixed(3)}`;
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BATCH_SIZE = 25;
const VERIFY_WINDOW = 20;
const VERIFY_STRIDE = 10; // Overlap between windows
const MODEL = args.model === 'sonnet' ? MODELS.sonnet : MODELS.haiku;

// ---------------------------------------------------------------------------
// Dimension-specific prompts
// ---------------------------------------------------------------------------

const PROMPTS: Record<string, { sort: string; compare: string }> = {
  readership: {
    sort: `You are ranking wiki pages by their importance FOR READERS navigating AI safety — which pages are most important for someone trying to understand the AI safety landscape?

Ranking criteria:
1. **Centrality**: Core concepts (alignment, existential risk, superintelligence) > niche subtopics
2. **Foundational**: Topics that many other topics depend on understanding
3. **Real-world relevance**: Topics affecting actual AI development and governance decisions
4. **Breadth**: Topics relevant across multiple AI safety perspectives

Calibration:
- Core alignment concepts > specific organizations or people
- Major risk categories > individual risk subtypes
- Foundational capabilities concepts (compute, scaling) > narrow technical details
- Influential organizations > lesser-known orgs
- Concrete safety approaches > abstract philosophy
- People and funders generally rank lower`,

    compare: `You are ranking wiki pages by importance FOR READERS of an AI safety wiki. Which page is more important for someone trying to understand AI safety?

Respond with ONLY "A" or "B".`,
  },

  research: {
    sort: `You are ranking wiki pages by RESEARCH IMPORTANCE — which topics would yield the most valuable new insights if deeply investigated?

This is NOT about which topic is broadly important. It's about where DEEPER RESEARCH would have the highest marginal value. The best topics are narrow but incredibly important — investigating them further could reveal critical insights.

Ranking criteria:
1. **Insight potential**: Would deeper investigation reveal surprising findings that change how we think about AI risk? Narrow, specific topics often score highest here.
2. **Neglectedness**: Is this topic under-researched relative to its potential importance? Under-explored angles on well-known problems rank very high.
3. **Decision relevance**: Would new findings on this topic change what researchers, funders, or labs should do?
4. **Crux resolution**: Does this topic contain unresolved disagreements that, if resolved, would significantly update views on AI risk?

Calibration:
- Narrow technical topics with open questions (mesa-optimization, sleeper agents, scaling unpredictability) > broad overviews (AI alignment, existential risk)
- Under-studied risks and mechanisms > well-documented concepts
- Topics with expert disagreement > topics with consensus
- Specific empirical questions (eval saturation, capability elicitation) > philosophical frameworks
- Concrete safety approaches needing validation > established techniques
- Broad overview/index pages rank LOW — they compile knowledge, not generate it
- Internal/meta pages (wiki documentation, project pages) rank LOWEST`,

    compare: `You are ranking wiki pages by RESEARCH IMPORTANCE — which topic would yield more valuable new insights if deeply investigated? Think about neglectedness, insight potential, and whether findings would change important decisions.

Respond with ONLY "A" or "B".`,
  },
};

const SORT_USER_TEMPLATE = `Rank these wiki pages from MOST to LEAST important (by the criteria above).

Pages to rank:
{PAGES}

Return ONLY the page IDs in order, one per line, most important first. No numbering, no explanations, no other text.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageInfo {
  id: string;
  title: string;
  description: string;
  category: string;
}

// ---------------------------------------------------------------------------
// LLM sorting
// ---------------------------------------------------------------------------

function formatPageForBatch(page: PageInfo): string {
  let line = `- ${page.id}: "${page.title}"`;
  if (page.description) {
    const desc = page.description.length > 120
      ? page.description.slice(0, 117) + '...'
      : page.description;
    line += ` — ${desc}`;
  }
  if (page.category) {
    line += ` [${page.category}]`;
  }
  return line;
}

const dimPrompts = PROMPTS[dimension] || PROMPTS.readership;

/** Sort a batch of ≤30 pages using a single LLM prompt. */
async function sortBatch(
  pages: PageInfo[],
  client: ReturnType<typeof createClient>,
): Promise<string[]> {
  const pagesText = pages.map(formatPageForBatch).join('\n');
  const prompt = SORT_USER_TEMPLATE.replace('{PAGES}', pagesText);

  const result = await callClaude(client!, {
    model: MODEL,
    systemPrompt: dimPrompts.sort,
    userPrompt: prompt,
    maxTokens: 2000,
    temperature: 0,
  });
  costTracker.track(result.usage);

  const pageIdSet = new Set(pages.map((p) => p.id));
  const ranked = result.text
    .trim()
    .split('\n')
    .map((line) => line.trim().replace(/^\d+\.\s*/, '').replace(/^-\s*/, ''))
    .filter((id) => pageIdSet.has(id));

  // Add any missing pages at the end
  const rankedSet = new Set(ranked);
  for (const p of pages) {
    if (!rankedSet.has(p.id)) {
      ranked.push(p.id);
    }
  }

  return ranked;
}

/** Binary search to find where a page belongs in a ranking. */
async function binarySearchInsert(
  pageInfo: PageInfo,
  ranking: string[],
  pagesMap: Map<string, PageInfo>,
  client: ReturnType<typeof createClient>,
): Promise<number> {
  if (ranking.length === 0) return 1;

  let lo = 0;
  let hi = ranking.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midInfo = pagesMap.get(ranking[mid]);
    if (!midInfo) {
      lo = mid + 1;
      continue;
    }

    const prompt = `Which is MORE important?

A: "${pageInfo.title}" (${pageInfo.id})${pageInfo.description ? ` — ${pageInfo.description.slice(0, 150)}` : ''}

B: "${midInfo.title}" (${midInfo.id})${midInfo.description ? ` — ${midInfo.description.slice(0, 150)}` : ''}`;

    const result = await callClaude(client!, {
      model: MODELS.haiku,
      systemPrompt: dimPrompts.compare,
      userPrompt: prompt,
      maxTokens: 10,
      temperature: 0,
    });
    costTracker.track(result.usage);

    const answer = result.text.trim().toUpperCase();
    if (answer === 'A') {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return lo + 1;
}

/**
 * Verification pass: re-sort overlapping windows to fix local inversions.
 * Slides a window of VERIFY_WINDOW pages across the ranking with VERIFY_STRIDE overlap.
 */
async function verifyRanking(
  ranking: string[],
  pagesMap: Map<string, PageInfo>,
  client: ReturnType<typeof createClient>,
): Promise<string[]> {
  if (ranking.length <= VERIFY_WINDOW) {
    const pages = ranking.map((id) => pagesMap.get(id)!).filter(Boolean);
    return sortBatch(pages, client);
  }

  let result = [...ranking];
  let changes = 0;

  const windows = Math.ceil((ranking.length - VERIFY_WINDOW) / VERIFY_STRIDE) + 1;
  const verifyProgress = createProgress(windows, 'Verifying');

  for (let start = 0; start < ranking.length - VERIFY_STRIDE; start += VERIFY_STRIDE) {
    const end = Math.min(start + VERIFY_WINDOW, ranking.length);
    const windowIds = result.slice(start, end);
    const windowPages = windowIds.map((id) => pagesMap.get(id)!).filter(Boolean);

    if (windowPages.length < 2) {
      verifyProgress.update();
      continue;
    }

    const sorted = await sortBatch(windowPages, client);

    // Replace the window in the result
    result.splice(start, sorted.length, ...sorted);

    // Count how many moved
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== windowIds[i]) changes++;
    }

    verifyProgress.update();
    await sleep(100);
  }
  verifyProgress.done();

  log.dim(`  Verification moved ${changes} pages`);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const allPages = loadPages();
  const pagesMap = new Map<string, PageInfo>();

  for (const p of allPages) {
    pagesMap.set(p.id, {
      id: p.id,
      title: p.title,
      description: (p.description || p.llmSummary || '').slice(0, 200),
      category: p.category || '',
    });
  }

  const client = createClient();
  if (!client) {
    log.error('ANTHROPIC_API_KEY required for reranking');
    process.exit(1);
  }

  log.dim(`Dimension: ${dimension}`);

  // Verify mode: fix local inversions in existing ranking
  if (args.verify) {
    const { ranking } = loadRanking(dimension);
    if (ranking.length === 0) {
      log.error(`No ${dimension} ranking found. Run a full rerank first.`);
      process.exit(1);
    }

    log.heading(`Verifying ${dimension} ranking (${ranking.length} pages)`);
    const verified = await verifyRanking(ranking, pagesMap, client);

    if (args.apply) {
      saveRanking({ ranking: verified }, dimension);
      log.success(`Verified ranking saved`);
    } else {
      log.info('Run with --apply to save verified ranking.');
    }

    console.log('');
    log.dim(costTracker.summary(MODEL));
    return;
  }

  // Determine which pages to rerank
  let pageIds: string[];

  if (args.all) {
    pageIds = getAllPageIds().filter((id) => pagesMap.has(id));
    log.heading(`Reranking all ${pageIds.length} pages [${dimension}]`);
  } else if (args.sample) {
    const n = parseInt(args.sample as string, 10);
    const all = getAllPageIds().filter((id) => pagesMap.has(id));
    const { ranking: existingRanking } = loadRanking(dimension);
    const source = existingRanking.length > 0 ? existingRanking.filter((id) => pagesMap.has(id)) : all;
    const step = Math.max(1, Math.floor(source.length / n));
    pageIds = [];
    for (let i = 0; i < source.length && pageIds.length < n; i += step) {
      pageIds.push(source[i]);
    }
    log.heading(`Reranking sample of ${pageIds.length} pages [${dimension}]`);
  } else if (args._positional.length > 0) {
    pageIds = (args._positional as string[]).filter((id) => pagesMap.has(id));
    log.heading(`Reranking ${pageIds.length} specified pages [${dimension}]`);
  } else {
    log.error('Specify --sample=N, --all, --verify, or page IDs');
    process.exit(1);
  }

  const pages = pageIds.map((id) => pagesMap.get(id)!).filter(Boolean);

  if (pages.length === 0) {
    log.error('No valid pages to rank.');
    process.exit(1);
  }

  let finalRanking: string[];

  if (pages.length <= 30) {
    log.info(`Sorting ${pages.length} pages in a single prompt...`);
    console.log('');
    finalRanking = await sortBatch(pages, client);
  } else {
    // Phase 1: Sort in batches
    const chunks: PageInfo[][] = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      chunks.push(pages.slice(i, i + BATCH_SIZE));
    }

    log.info(`Phase 1: Sorting ${chunks.length} batches of ~${BATCH_SIZE} pages...`);
    const sortedChunks: string[][] = [];
    const sortProgress = createProgress(chunks.length, 'Sorting batches');

    for (const chunk of chunks) {
      const sorted = await sortBatch(chunk, client);
      sortedChunks.push(sorted);
      sortProgress.update();
      await sleep(200);
    }
    sortProgress.done();

    // Phase 2: Merge sorted chunks
    log.info(`Phase 2: Merging ${sortedChunks.length} sorted batches...`);
    finalRanking = sortedChunks[0];

    if (sortedChunks.length > 1) {
      const remaining: string[] = [];
      for (let i = 1; i < sortedChunks.length; i++) {
        remaining.push(...sortedChunks[i]);
      }

      const mergeProgress = createProgress(remaining.length, 'Merging');
      for (const pageId of remaining) {
        const info = pagesMap.get(pageId);
        if (!info) continue;
        const pos = await binarySearchInsert(info, finalRanking, pagesMap, client);
        finalRanking = insertAt(finalRanking, pageId, pos);
        mergeProgress.update();
      }
      mergeProgress.done();
    }

    // Phase 3: Verification pass to fix merge artifacts
    log.info('Phase 3: Verification pass...');
    finalRanking = await verifyRanking(finalRanking, pagesMap, client);
  }

  // Display results (top 50 + bottom 10)
  console.log('');
  log.subheading(`Ranking result [${dimension}]:`);
  console.log('');

  const show = Math.min(50, finalRanking.length);
  const posWidth = String(finalRanking.length).length;
  for (let i = 0; i < show; i++) {
    const id = finalRanking[i];
    const info = pagesMap.get(id);
    const title = info?.title || id;
    const pos = String(i + 1).padStart(posWidth);
    console.log(`  ${c.dim}${pos}.${c.reset} ${title} ${c.dim}(${id})${c.reset}`);
  }
  if (finalRanking.length > show + 10) {
    console.log(`  ${c.dim}... ${finalRanking.length - show - 10} more ...${c.reset}`);
  }
  if (finalRanking.length > show) {
    console.log('');
    log.dim('Bottom 10:');
    for (let i = Math.max(show, finalRanking.length - 10); i < finalRanking.length; i++) {
      const id = finalRanking[i];
      const info = pagesMap.get(id);
      const title = info?.title || id;
      const pos = String(i + 1).padStart(posWidth);
      console.log(`  ${c.dim}${pos}.${c.reset} ${title} ${c.dim}(${id})${c.reset}`);
    }
  }

  // Save
  if (args.apply) {
    if (args.all) {
      const rankedSet = new Set(finalRanking);
      const { ranking: existing } = loadRanking(dimension);
      for (const id of existing) {
        if (!rankedSet.has(id)) {
          finalRanking.push(id);
        }
      }
      saveRanking({ ranking: finalRanking }, dimension);
      log.success(`Full ${dimension} ranking saved (${finalRanking.length} pages)`);
    } else {
      const { ranking: existing } = loadRanking(dimension);
      const rerankedSet = new Set(finalRanking);
      let merged = existing.filter((id) => !rerankedSet.has(id));

      log.info('Merging into existing ranking...');
      for (const pageId of finalRanking) {
        const info = pagesMap.get(pageId);
        if (!info) continue;
        const pos = await binarySearchInsert(info, merged, pagesMap, client);
        merged = insertAt(merged, pageId, pos);
      }

      saveRanking({ ranking: merged }, dimension);
      log.success(`Merged ${dimension} ranking saved (${merged.length} pages)`);
    }

    console.log('');
    log.info('Run `pnpm crux importance sync --apply` to write scores to frontmatter.');
  } else {
    console.log('');
    log.info('Run with --apply to save this ranking.');
  }

  console.log('');
  log.dim(`Model: ${MODEL} | Dimension: ${dimension}`);
  log.dim(costTracker.summary(MODEL));
}

main().catch((err) => {
  log.error(`Error: ${err.message}`);
  process.exit(1);
});
