#!/usr/bin/env npx tsx
/**
 * Backfill resource summaries using LLM.
 *
 * Fetches resources without summaries from the wiki-server,
 * retrieves their content via source-fetcher, generates summaries
 * with Claude Haiku, and upserts back.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod npx tsx scripts/backfill-resource-summaries.ts --batch=50
 *   WIKI_SERVER_ENV=prod npx tsx scripts/backfill-resource-summaries.ts --batch=10 --type=paper --dry-run
 */

import { createClient, MODELS, callClaude, sleep, parseJsonResponse } from '../crux/lib/anthropic.ts';
import { listResources, upsertResource } from '../crux/lib/wiki-server/resources.ts';
import { fetchSource } from '../crux/lib/search/source-fetcher.ts';

// ── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : defaultVal;
}
const BATCH_SIZE = parseInt(getArg("batch", "20"), 10);
const RESOURCE_TYPE = getArg("type", "");
const DRY_RUN = args.includes("--dry-run");
const MODEL = getArg("model", "haiku");

// ── Summary prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a research assistant that writes concise, informative summaries of technical documents and articles. You specialize in AI safety, machine learning, and related policy topics.

Given the content of a resource (paper, article, blog post, etc.), produce a JSON response with:
- "summary": A 2-4 sentence summary capturing the key contribution or argument (100-200 words)
- "keyPoints": An array of 3-5 bullet points highlighting the most important findings or claims

Be factual and precise. Do not speculate beyond what the content states. If the content is too short or unclear to summarize meaningfully, set summary to null.`;

function buildUserPrompt(title: string, url: string, content: string): string {
  // Truncate content to ~4000 chars to keep costs low with Haiku
  const truncated = content.length > 4000 ? content.slice(0, 4000) + "\n[... truncated]" : content;
  return `Summarize this resource:

Title: ${title}
URL: ${url}

Content:
${truncated}

Respond with JSON: { "summary": "...", "keyPoints": ["...", "..."] }`;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const client = createClient();
  if (!client) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  console.log(`Fetching resources without summaries (batch=${BATCH_SIZE}, type=${RESOURCE_TYPE || "all"})...`);

  // Fetch resources in pages until we have enough without summaries
  const needsSummary: Array<{ id: string; title: string; url: string; type: string; abstract?: string }> = [];
  let offset = 0;
  const PAGE_SIZE = 200;

  while (needsSummary.length < BATCH_SIZE) {
    const result = await listResources(PAGE_SIZE, offset, RESOURCE_TYPE || undefined);
    if (!result.ok) {
      console.error("Failed to list resources:", result.error);
      process.exit(1);
    }

    const items = (result.data as { resources: Array<Record<string, unknown>> }).resources ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      if (needsSummary.length >= BATCH_SIZE) break;
      if (!item.summary && item.url && item.title) {
        needsSummary.push({
          id: item.id as string,
          title: item.title as string,
          url: item.url as string,
          type: item.type as string,
          abstract: item.abstract as string | undefined,
        });
      }
    }

    offset += PAGE_SIZE;
    // Safety: don't scan more than 10,000 resources
    if (offset > 10000) break;
  }

  console.log(`Found ${needsSummary.length} resources without summaries`);

  if (DRY_RUN) {
    console.log("\n--- DRY RUN ---");
    for (const r of needsSummary) {
      console.log(`  ${r.type.padEnd(10)} ${r.id.slice(0, 20).padEnd(22)} ${r.title.slice(0, 60)}`);
    }
    return;
  }

  let summarized = 0;
  let failed = 0;
  let skipped = 0;

  for (const resource of needsSummary) {
    console.log(`\n[${summarized + failed + skipped + 1}/${needsSummary.length}] ${resource.title.slice(0, 60)}...`);

    // Get content: prefer abstract if available, otherwise fetch
    let content = resource.abstract ?? "";

    if (!content || content.length < 100) {
      try {
        const fetched = await fetchSource({
          url: resource.url,
          extractMode: "full",
        });
        if (fetched.status === "ok" && fetched.content) {
          content = fetched.content;
        } else {
          console.log(`  ⏭  Could not fetch content (${fetched.status})`);
          skipped++;
          continue;
        }
      } catch (e) {
        console.log(`  ⏭  Fetch error: ${e instanceof Error ? e.message : String(e)}`);
        skipped++;
        continue;
      }
    }

    if (content.length < 50) {
      console.log("  ⏭  Content too short");
      skipped++;
      continue;
    }

    // Generate summary with LLM
    try {
      const result = await callClaude(client, {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(resource.title, resource.url, content),
        maxTokens: 500,
        temperature: 0,
      });

      const parsed = parseJsonResponse(result.text) as {
        summary?: string | null;
        keyPoints?: string[];
      };

      if (!parsed.summary) {
        console.log("  ⏭  LLM returned null summary");
        skipped++;
        continue;
      }

      // Upsert back to wiki-server
      const upsertResult = await upsertResource({
        id: resource.id,
        url: resource.url,
        title: resource.title,
        type: resource.type,
        summary: parsed.summary,
        key_points: parsed.keyPoints ?? [],
      });

      if (upsertResult.ok) {
        console.log(`  ✅  Summary saved (${parsed.summary.length} chars, ${parsed.keyPoints?.length ?? 0} key points)`);
        summarized++;
      } else {
        console.log(`  ❌  Upsert failed: ${upsertResult.error}`);
        failed++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Rate limited")) {
        console.log("  ⏳  Rate limited, waiting 30s...");
        await sleep(30000);
        // Don't count as failed, will miss this one though
        skipped++;
      } else {
        console.log(`  ❌  LLM error: ${msg}`);
        failed++;
      }
    }

    // Small delay between requests
    await sleep(500);
  }

  console.log(`\n━━━ Done ━━━`);
  console.log(`  Summarized: ${summarized}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Failed:     ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
