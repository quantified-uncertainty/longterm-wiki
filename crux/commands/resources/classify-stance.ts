/**
 * Classify resource stance for legislation-related resources.
 *
 * Uses Haiku to classify each resource as support/oppose/neutral/mixed/analysis
 * based on title, summary, and URL domain.
 *
 * Usage:
 *   pnpm crux resources classify-stance --page=california-sb1047
 *   pnpm crux resources classify-stance --page=california-sb1047 --apply
 *   pnpm crux resources classify-stance --page=california-sb1047 --limit=5 --verbose
 */

import { createClient, MODELS, parseJsonResponse } from '../../lib/anthropic.ts';
import { callLlm } from '../../lib/llm.ts';
import { CostTracker } from '../../lib/cost-tracker.ts';
import { getResourcesByPage, upsertResource } from '../../lib/wiki-server/resources.ts';
import type { ResourceRow } from '../../lib/wiki-server/resources.ts';

const VALID_STANCES = ['support', 'oppose', 'neutral', 'mixed', 'analysis'] as const;
type Stance = typeof VALID_STANCES[number];

interface ClassificationResult {
  resourceId: string;
  title: string;
  url: string;
  stance: Stance;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

const SYSTEM_PROMPT = `You classify resources about legislation into one of these stance categories:

- **support**: The resource explicitly supports or advocates for the legislation
- **oppose**: The resource explicitly opposes or argues against the legislation
- **neutral**: The resource reports on the legislation without taking a clear position
- **mixed**: The resource presents both supporting and opposing views without a dominant stance
- **analysis**: The resource provides technical, legal, or policy analysis without advocacy

Classify based on the title, summary, and source. When uncertain, prefer "neutral" for news articles and "analysis" for think tank / academic sources.

Output valid JSON only — an array of objects with: id, stance, confidence ("high"/"medium"/"low"), reasoning (one sentence).`;

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function buildUserPrompt(resources: Array<{ id: string; title: string; summary: string | null; url: string; domain: string | null }>): string {
  const items = resources.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary?.slice(0, 200) ?? null,
    source: r.domain ?? extractDomain(r.url) ?? 'unknown',
  }));
  return JSON.stringify(items, null, 2);
}

export async function classifyStance(args: {
  page: string;
  apply?: boolean;
  limit?: number;
  verbose?: boolean;
}): Promise<void> {
  const { page, apply = false, limit, verbose = false } = args;

  console.log(`\nClassifying resource stance for page: ${page}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'dry-run'}\n`);

  // Load resources for the page
  const result = await getResourcesByPage(page);
  if (!result.ok) {
    throw new Error(`Failed to load resources for page "${page}": ${result.error}`);
  }

  let resources = result.data.resources;
  console.log(`Found ${resources.length} resources for ${page}`);

  // Filter out resources that already have a stance
  const unclassified = resources.filter((r: any) => !r.stance);
  console.log(`${unclassified.length} unclassified (${resources.length - unclassified.length} already have stance)\n`);

  if (unclassified.length === 0) {
    console.log('Nothing to classify.');
    return;
  }

  let toClassify = unclassified;
  if (limit) toClassify = toClassify.slice(0, limit);

  const items = toClassify.map((r: any) => ({
    id: r.id,
    title: r.title ?? r.url,
    summary: r.summary ?? null,
    url: r.url,
    domain: extractDomain(r.url),
  }));

  // Batch into groups of 20 for the LLM
  const BATCH_SIZE = 20;
  const batches: typeof items[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  const client = createClient({ required: true })!;
  const tracker = new CostTracker();
  const allResults: ClassificationResult[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(`Batch ${batchIdx + 1}/${batches.length} (${batch.length} resources)...`);

    try {
      const response = await callLlm(client, {
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(batch),
      }, {
        model: MODELS.haiku,
        maxTokens: 4000,
        tracker,
        label: 'stance-classification',
      });

      const parsed = parseJsonResponse(response.text);
      if (!Array.isArray(parsed)) {
        console.error(`  Unexpected response format (not array), skipping batch`);
        continue;
      }

      for (const item of parsed as any[]) {
        if (!item.id || !item.stance) continue;
        if (!VALID_STANCES.includes(item.stance)) {
          if (verbose) console.log(`  ⚠ Invalid stance "${item.stance}" for ${item.id}, skipping`);
          continue;
        }
        const matchedItem = items.find((r) => r.id === item.id);
        if (!matchedItem) {
          if (verbose) console.log(`  ⚠ Unknown resource id "${item.id}", skipping`);
          continue;
        }
        allResults.push({
          resourceId: item.id,
          title: matchedItem.title,
          url: matchedItem.url,
          stance: item.stance,
          confidence: item.confidence ?? 'medium',
          reasoning: item.reasoning ?? '',
        });
      }
    } catch (err) {
      console.error(`  Batch ${batchIdx + 1} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Display results
  console.log(`\n── Results ──────────────────────────────────────`);
  const stanceCounts: Record<string, number> = {};
  for (const r of allResults) {
    stanceCounts[r.stance] = (stanceCounts[r.stance] ?? 0) + 1;
    if (verbose) {
      const conf = r.confidence === 'high' ? '●' : r.confidence === 'medium' ? '◐' : '○';
      console.log(`  ${conf} ${r.stance.padEnd(8)} ${r.title.slice(0, 60)}`);
      if (r.reasoning) console.log(`             ${r.reasoning}`);
    }
  }

  console.log(`\n  Classified: ${allResults.length}/${toClassify.length}`);
  for (const [stance, count] of Object.entries(stanceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${stance}: ${count}`);
  }
  console.log(`  Cost: $${tracker.totalCost.toFixed(4)}`);

  // Apply if requested
  if (apply && allResults.length > 0) {
    console.log(`\nApplying ${allResults.length} stance classifications...`);
    let updated = 0;
    let failed = 0;

    for (const r of allResults) {
      const result = await upsertResource({
        id: r.resourceId,
        url: r.url,
        stance: r.stance,
      });
      if (result.ok) {
        updated++;
      } else {
        failed++;
        if (verbose) console.error(`  Failed to update ${r.resourceId}: ${result.error}`);
      }
    }

    console.log(`  Updated: ${updated}, Failed: ${failed}`);
  } else if (!apply) {
    console.log(`\nRun with --apply to save classifications.`);
  }
}
