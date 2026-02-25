/**
 * Claims From Resource — extract claims from a URL or batch of URLs
 *
 * Phase 3: URL-based ingestion pipeline.
 * Takes a raw URL, fetches its content, determines relevant entities
 * (via CLI flag, resource YAML, or LLM routing), extracts claims,
 * deduplicates, and inserts into the database.
 *
 * Usage:
 *   pnpm crux claims from-resource <url>
 *   pnpm crux claims from-resource <url> --entity=kalshi
 *   pnpm crux claims from-resource <url> --dry-run
 *   pnpm crux claims from-resource --batch urls.txt --dry-run
 *   pnpm crux claims from-resource <url> --no-auto-resource
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 */

import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { callOpenRouter, stripCodeFences, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { insertClaimBatch, getClaimsByEntity, type InsertClaimItem } from '../lib/wiki-server/claims.ts';
import { getResourceByUrl } from '../lib/resource-lookup.ts';
import { fetchSource } from '../lib/source-fetcher.ts';
import { loadResources, saveResources } from '../resource-io.ts';
import { loadEntities } from '../lib/content-types.ts';
import { deduplicateClaims } from '../lib/claim-utils.ts';
import {
  extractClaimsForEntity,
  buildInsertItem,
  buildResourceText,
  type ExtractedResourceClaim,
} from './ingest-resource.ts';
import type { Resource } from '../resource-types.ts';

type Colors = ReturnType<typeof getColors>;

// ---------------------------------------------------------------------------
// Entity routing — determine which entities a URL is relevant to
// ---------------------------------------------------------------------------

/**
 * Use LLM to route content to relevant wiki entities.
 * Sends a content preview + entity list to the LLM and asks it to pick 1-5.
 */
async function routeToEntities(
  title: string,
  contentPreview: string,
  model?: string,
): Promise<string[]> {
  const entities = loadEntities();
  // Build a compact entity list for the LLM (id + title, max 500 entities)
  const entityList = entities
    .filter(e => e.type !== 'stub' && e.title)
    .slice(0, 500)
    .map(e => `${e.id}: ${e.title}`)
    .join('\n');

  const systemPrompt = `You are routing an external resource to relevant wiki entities. Given the resource title and content preview, select 1-5 wiki entities that this resource is most relevant to.

Available entities:
${entityList}

Return ONLY a JSON array of entity IDs (strings), e.g.: ["entity-id-1", "entity-id-2"]
Select entities where this resource would provide useful factual claims for the wiki article.`;

  const userPrompt = `Resource title: ${title}\n\nContent preview:\n${contentPreview.slice(0, 3000)}`;

  try {
    const raw = await callOpenRouter(systemPrompt, userPrompt, {
      model: model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 500,
      title: 'LongtermWiki Entity Routing',
    });
    const json = stripCodeFences(raw);
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 5);
    }
    return [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Entity routing failed: ${msg.slice(0, 120)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Auto-create resource entry
// ---------------------------------------------------------------------------

function autoCreateResource(url: string, title: string): Resource {
  const hash = createHash('md5').update(url).digest('hex').slice(0, 16);
  return {
    id: hash,
    url,
    title: title || url,
    type: 'article',
    _sourceFile: 'web-other',
  };
}

// ---------------------------------------------------------------------------
// Process a single URL
// ---------------------------------------------------------------------------

interface ProcessResult {
  url: string;
  extracted: number;
  inserted: number;
  deduplicated: number;
  entities: string[];
  error?: string;
}

async function processUrl(
  url: string,
  opts: {
    entityFilter: string[];
    dryRun: boolean;
    model?: string;
    noAutoResource: boolean;
    c: Colors;
  },
): Promise<ProcessResult> {
  const { entityFilter, dryRun, model, noAutoResource, c } = opts;
  const result: ProcessResult = {
    url,
    extracted: 0,
    inserted: 0,
    deduplicated: 0,
    entities: [],
  };

  try {
    // 1. Look up URL in resource YAML
    let resource = getResourceByUrl(url) as Resource | null;
    let resourceText: string;

    // 2. Fetch content
    console.log(`  ${c.dim}Fetching content...${c.reset}`);
    const fetched = await fetchSource({ url, extractMode: 'full' });

    if (fetched.status === 'error' || fetched.status === 'dead') {
      result.error = `Fetch failed: ${fetched.status}`;
      console.log(`  ${c.red}${result.error}${c.reset}`);
      return result;
    }

    // If we have fetched content, use it; otherwise fall back to resource YAML metadata
    if (fetched.content && fetched.content.length > 200) {
      resourceText = fetched.content.slice(0, 40000);
    } else if (resource) {
      resourceText = buildResourceText(resource as Resource & { localFilename?: string });
    } else {
      result.error = 'No content available (fetch returned empty and no resource YAML)';
      console.log(`  ${c.yellow}${result.error}${c.reset}`);
      return result;
    }

    // 3. Auto-create resource entry if not found and not disabled
    if (!resource && !noAutoResource) {
      resource = autoCreateResource(url, fetched.title || '');
      // Persist to YAML
      const allResources = loadResources();
      allResources.push(resource);
      if (!dryRun) {
        saveResources(allResources);
        console.log(`  ${c.dim}Auto-created resource: ${resource.id}${c.reset}`);
      } else {
        console.log(`  ${c.dim}Would auto-create resource: ${resource.id}${c.reset}`);
      }
    } else if (!resource) {
      // No resource and auto-create disabled — create a minimal in-memory resource
      resource = autoCreateResource(url, fetched.title || '');
    }

    // 4. Determine target entities
    let targetEntities: string[];
    if (entityFilter.length > 0) {
      targetEntities = entityFilter;
    } else if (resource.cited_by && resource.cited_by.length > 0) {
      targetEntities = resource.cited_by;
    } else {
      // LLM-based routing
      console.log(`  ${c.dim}Routing to entities via LLM...${c.reset}`);
      targetEntities = await routeToEntities(
        fetched.title || resource.title || '',
        resourceText,
        model,
      );
      if (targetEntities.length === 0) {
        result.error = 'No relevant entities found. Use --entity=<id> to specify manually.';
        console.log(`  ${c.yellow}${result.error}${c.reset}`);
        return result;
      }
      console.log(`  ${c.dim}Routed to: ${targetEntities.join(', ')}${c.reset}`);
    }
    result.entities = targetEntities;

    // 5. Extract claims per entity
    for (const entity of targetEntities) {
      process.stdout.write(`  ${c.dim}Extracting for ${entity}...${c.reset}`);
      let claims = await extractClaimsForEntity(resourceText, resource, entity, { model });
      result.extracted += claims.length;

      // 6. Deduplicate
      if (!dryRun && claims.length > 0) {
        const existingResult = await getClaimsByEntity(entity);
        if (existingResult.ok && existingResult.data.claims.length > 0) {
          const existingTexts = existingResult.data.claims.map(cl => cl.claimText);
          const dedupResult = deduplicateClaims(claims, existingTexts);
          result.deduplicated += dedupResult.duplicateCount;
          claims = dedupResult.unique;
        }
      }

      const directCount = claims.filter(cl => cl.relevance === 'direct').length;
      console.log(` ${c.green}${claims.length} claims${c.reset} (${directCount} direct)`);

      if (dryRun) {
        // Print sample
        for (const cl of claims.slice(0, 3)) {
          console.log(`    [${cl.claimType}] ${cl.claimText.slice(0, 100)}`);
        }
        if (claims.length > 3) console.log(`    ... and ${claims.length - 3} more`);
        continue;
      }

      // 7. Insert
      if (claims.length > 0) {
        const items: InsertClaimItem[] = claims.map(claim =>
          buildInsertItem(claim, entity, resource!),
        );

        const batchResult = await insertClaimBatch(items);
        if (batchResult.ok) {
          result.inserted += batchResult.data.inserted;
        } else {
          console.warn(`  ${c.yellow}[warn] Insert failed for ${entity}: ${String(batchResult.error).slice(0, 80)}${c.reset}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = msg.slice(0, 200);
    console.error(`  ${c.red}Error: ${result.error}${c.reset}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const noAutoResource = args['no-auto-resource'] === true;
  const batchFile = typeof args.batch === 'string' ? args.batch : null;
  const limit = typeof args.limit === 'number' ? args.limit : Infinity;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];

  // Parse entity filter (can be repeated: --entity=a --entity=b)
  const entityFilter: string[] = [];
  if (typeof args.entity === 'string') {
    entityFilter.push(args.entity);
  } else if (Array.isArray(args.entity)) {
    entityFilter.push(...args.entity.filter((e: unknown): e is string => typeof e === 'string'));
  }

  // Check server availability (unless dry-run)
  if (!dryRun) {
    const serverAvailable = await isServerAvailable();
    if (!serverAvailable) {
      console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
      console.error(`  Use --dry-run to extract without storing.`);
      process.exit(1);
    }
  }

  // Determine URLs to process
  let urls: string[];

  if (batchFile) {
    if (!existsSync(batchFile)) {
      console.error(`${c.red}Error: batch file not found: ${batchFile}${c.reset}`);
      process.exit(1);
    }
    const content = readFileSync(batchFile, 'utf-8');
    urls = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } else if (positional.length > 0) {
    urls = [positional[0]];
  } else {
    console.error(`${c.red}Error: provide a URL or --batch=<file>${c.reset}`);
    console.error(`  Usage: pnpm crux claims from-resource <url>`);
    console.error(`         pnpm crux claims from-resource --batch urls.txt`);
    process.exit(1);
  }

  // Apply limit
  if (urls.length > limit) {
    urls = urls.slice(0, limit);
  }

  const isBatch = urls.length > 1;

  console.log(`\n${c.bold}${c.blue}Claims From Resource${c.reset}`);
  console.log(`  URLs to process: ${urls.length}`);
  if (entityFilter.length > 0) {
    console.log(`  Target entities: ${entityFilter.join(', ')}`);
  }
  if (dryRun) {
    console.log(`  ${c.yellow}DRY RUN — claims will not be stored${c.reset}`);
  }
  console.log('');

  // Process each URL
  const results: ProcessResult[] = [];
  let processed = 0;

  for (const url of urls) {
    processed++;
    if (isBatch) {
      console.log(`\n${c.bold}[${processed}/${urls.length}] ${url}${c.reset}`);
    } else {
      console.log(`${c.bold}URL: ${url}${c.reset}`);
    }

    const result = await processUrl(url, {
      entityFilter,
      dryRun,
      model,
      noAutoResource,
      c,
    });
    results.push(result);
  }

  // Summary
  const totalExtracted = results.reduce((s, r) => s + r.extracted, 0);
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const totalDeduped = results.reduce((s, r) => s + r.deduplicated, 0);
  const errorCount = results.filter(r => r.error).length;

  console.log(`\n${c.bold}Summary:${c.reset}`);
  console.log(`  URLs processed: ${results.length}`);
  console.log(`  Claims extracted: ${c.green}${totalExtracted}${c.reset}`);
  if (totalDeduped > 0) {
    console.log(`  Deduplicated: ${c.dim}${totalDeduped}${c.reset}`);
  }
  if (!dryRun) {
    console.log(`  Claims inserted: ${c.green}${totalInserted}${c.reset}`);
  }
  if (errorCount > 0) {
    console.log(`  Errors: ${c.red}${errorCount}${c.reset}`);
    for (const r of results.filter(r => r.error)) {
      console.log(`    ${c.red}${r.url}: ${r.error}${c.reset}`);
    }
  }
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims from-resource failed:', err);
    process.exit(1);
  });
}
