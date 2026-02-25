/**
 * Claims Ingest Resource — extract claims from an external resource
 *
 * Phase 3: Resource-centric ingestion pipeline.
 * Reads a resource from YAML (by ID), fetches its content (local cache or
 * wiki-server), runs LLM claim extraction targeted at each cited entity,
 * and inserts claims tagged back to the source resource.
 *
 * Claims are inserted with:
 *   entityId      = the wiki entity the claim is about (from cited_by)
 *   entityType    = "wiki-page"
 *   resourceIds   = [resource.id]   ← links claim back to source
 *   confidence    = "unverified"
 *   sourceQuote   = relevant excerpt (when available)
 *
 * Usage:
 *   pnpm crux claims ingest-resource <resource-id>
 *   pnpm crux claims ingest-resource <resource-id> --entity=kalshi
 *   pnpm crux claims ingest-resource <resource-id> --dry-run
 *   pnpm crux claims ingest-resource <resource-id> --model=google/gemini-2.0-flash-001
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 */

import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { callOpenRouter, stripCodeFences, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  insertClaimBatch,
  type InsertClaimItem,
} from '../lib/wiki-server/claims.ts';
import { loadResources } from '../resource-io.ts';
import { VALID_CLAIM_TYPES, claimTypeToCategory } from '../lib/claim-utils.ts';
import type { ClaimTypeValue } from '../lib/claim-utils.ts';
import type { Resource } from '../resource-types.ts';

// ---------------------------------------------------------------------------
// Project root (for cache paths)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CACHE_SOURCES_TEXT = join(PROJECT_ROOT, '.cache', 'sources', 'text');
const CACHE_SOURCES_PDF = join(PROJECT_ROOT, '.cache', 'sources', 'pdf');

// ---------------------------------------------------------------------------
// Resource text assembly
// ---------------------------------------------------------------------------

/**
 * Build a text corpus from a resource for LLM extraction.
 * Priority: local cached text file > wiki-server content > YAML metadata fields.
 */
function buildResourceText(resource: Resource & { localFilename?: string }): string {
  // Try local cached text file (from knowledge.db sync)
  if (resource.localFilename) {
    const txtPath = join(CACHE_SOURCES_TEXT, resource.localFilename);
    if (existsSync(txtPath)) {
      const content = readFileSync(txtPath, 'utf-8');
      if (content.length > 200) return content.slice(0, 40000); // cap at 40K chars
    }
    // Check pdf subdir
    const pdfPath = join(CACHE_SOURCES_PDF, resource.localFilename);
    if (existsSync(pdfPath)) {
      const content = readFileSync(pdfPath, 'utf-8');
      if (content.length > 200) return content.slice(0, 40000);
    }
  }

  // Also check by resource.id in text dir
  const idTxtPath = join(CACHE_SOURCES_TEXT, `${resource.id}.txt`);
  if (existsSync(idTxtPath)) {
    const content = readFileSync(idTxtPath, 'utf-8');
    if (content.length > 200) return content.slice(0, 40000);
  }

  // Fall back to rich YAML metadata fields
  const parts: string[] = [];
  if (resource.title) parts.push(`# ${resource.title}`);
  if (resource.authors && resource.authors.length > 0) {
    parts.push(`Authors: ${resource.authors.join(', ')}`);
  }
  if (resource.published_date || (resource as unknown as { date?: string }).date) {
    const d = resource.published_date ?? (resource as unknown as { date?: string }).date;
    parts.push(`Published: ${d}`);
  }
  if (resource.abstract) {
    parts.push(`\n## Abstract\n${resource.abstract}`);
  }
  if ((resource as unknown as { summary?: string }).summary) {
    parts.push(`\n## Summary\n${(resource as unknown as { summary?: string }).summary}`);
  }
  const keyPoints = (resource as unknown as { key_points?: string[] }).key_points;
  if (keyPoints && keyPoints.length > 0) {
    parts.push(`\n## Key Points\n${keyPoints.map(p => `- ${p}`).join('\n')}`);
  }
  const review = (resource as unknown as { review?: string }).review;
  if (review) {
    parts.push(`\n## Review\n${review}`);
  }

  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// LLM extraction — resource-aware, entity-targeted
// ---------------------------------------------------------------------------

interface ExtractedResourceClaim {
  claimText: string;
  claimType: ClaimTypeValue;
  relevance: 'direct' | 'contextual' | 'background';
  sourceQuote?: string;  // verbatim quote from the resource, if extractable
  relatedEntities?: string[];
}

function buildExtractionPrompt(resource: Resource, targetEntity: string): string {
  return `You are extracting factual claims from an external resource (paper, article, report) that is relevant to a wiki article about "${targetEntity}".

Resource metadata:
- Title: ${resource.title ?? 'Unknown'}
- URL: ${resource.url}
- Authors: ${resource.authors?.join(', ') ?? 'Unknown'}
- Type: ${resource.type}

For each claim, provide:
- "claimText": a single atomic, self-contained factual statement
- "claimType": one of:
    "factual" — specific facts, events, dates
    "numeric" — claims with specific numbers, percentages, dollar amounts, counts
    "historical" — historical events or timeline items
    "evaluative" — assessments, conclusions, or recommendations
    "causal" — cause-effect assertions
    "consensus" — what is broadly agreed upon in the field
    "speculative" — predictions, projections, or uncertain claims
    "relational" — comparisons between entities
- "relevance": "direct" (explicitly about ${targetEntity}), "contextual" (directly related context), or "background" (general field context)
- "sourceQuote": a SHORT verbatim quote (max 200 chars) from the resource text that supports this claim, if available
- "relatedEntities": other entity IDs/names mentioned alongside ${targetEntity} in the claim

Rules:
- Focus on claims most relevant to "${targetEntity}"
- Each claim must be atomic and self-contained
- Include specific numbers, names, and dates when present
- Skip trivial or overly general statements
- Extract 5-15 claims (fewer is fine if the resource is brief or tangential)
- Prefer "direct" relevance claims

Respond ONLY with JSON:
{"claims": [{"claimText": "...", "claimType": "factual", "relevance": "direct", "sourceQuote": "...", "relatedEntities": []}]}`;
}

async function extractClaimsForEntity(
  resourceText: string,
  resource: Resource,
  targetEntity: string,
  opts: { model?: string } = {},
): Promise<ExtractedResourceClaim[]> {
  const systemPrompt = buildExtractionPrompt(resource, targetEntity);
  const userPrompt = `RESOURCE TEXT:\n\n${resourceText}\n\nExtract claims relevant to "${targetEntity}". Return JSON only.`;

  try {
    const raw = await callOpenRouter(systemPrompt, userPrompt, {
      model: opts.model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 3000,
      title: 'LongtermWiki Resource Claims Extraction',
    });

    const json = stripCodeFences(raw);
    const parsed = JSON.parse(json) as { claims?: unknown[] };

    if (!Array.isArray(parsed.claims)) return [];

    return parsed.claims
      .filter((c): c is ExtractedResourceClaim =>
        typeof c === 'object' && c !== null &&
        typeof (c as ExtractedResourceClaim).claimText === 'string' &&
        (c as ExtractedResourceClaim).claimText.length > 10
      )
      .map(c => {
        const item = c as ExtractedResourceClaim;
        return {
          claimText: item.claimText,
          claimType: (VALID_CLAIM_TYPES.includes(item.claimType as ClaimTypeValue)
            ? item.claimType
            : 'factual') as ClaimTypeValue,
          relevance: (['direct', 'contextual', 'background'].includes(item.relevance)
            ? item.relevance
            : 'contextual') as 'direct' | 'contextual' | 'background',
          sourceQuote: typeof item.sourceQuote === 'string' && item.sourceQuote.length > 5
            ? item.sourceQuote.slice(0, 500)
            : undefined,
          relatedEntities: Array.isArray(item.relatedEntities)
            ? (item.relatedEntities as unknown[]).map(String).filter(s => s.length > 0)
            : [],
        };
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Entity "${targetEntity}" — extraction failed: ${msg.slice(0, 120)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const targetEntityFilter = typeof args.entity === 'string' ? args.entity : null;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const resourceId = positional[0];

  if (!resourceId) {
    console.error(`${c.red}Error: provide a resource ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims ingest-resource <resource-id>`);
    process.exit(1);
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

  // Load resource from YAML
  const allResources = loadResources();
  const resource = allResources.find(r => r.id === resourceId);
  if (!resource) {
    console.error(`${c.red}Error: resource "${resourceId}" not found in data/resources/**.yaml${c.reset}`);
    process.exit(1);
  }

  // Determine target entities
  const citedBy = resource.cited_by ?? [];
  if (citedBy.length === 0 && !targetEntityFilter) {
    console.error(`${c.yellow}Warning: resource "${resourceId}" has no cited_by entries.${c.reset}`);
    console.error(`  Use --entity=<page-id> to specify a target entity manually.`);
    process.exit(1);
  }
  const targetEntities = targetEntityFilter
    ? [targetEntityFilter]
    : citedBy;

  // Build resource text
  const resourceText = buildResourceText(resource as Resource & { localFilename?: string });
  const textSource = resourceText.length > 500 ? 'full text / rich metadata' : 'minimal metadata';

  console.log(`\n${c.bold}${c.blue}Claims Ingest Resource: ${resourceId}${c.reset}`);
  console.log(`  Title:        ${resource.title ?? '(untitled)'}`);
  console.log(`  URL:          ${resource.url}`);
  console.log(`  Text source:  ${textSource} (${resourceText.length} chars)`);
  console.log(`  Target entities: ${targetEntities.join(', ')}`);
  if (dryRun) {
    console.log(`  ${c.yellow}DRY RUN — claims will not be stored${c.reset}`);
  }
  console.log('');

  if (resourceText.length < 100) {
    console.warn(`${c.yellow}Warning: very little text available for extraction. Results may be limited.${c.reset}`);
    console.warn(`  Consider fetching the resource first: pnpm crux resources fetch ${resourceId}`);
    console.log('');
  }

  // Extract claims per target entity
  const allResults: Array<{
    entity: string;
    claims: ExtractedResourceClaim[];
  }> = [];

  for (const entity of targetEntities) {
    process.stdout.write(`  ${c.dim}Extracting for ${entity}...${c.reset}`);
    const claims = await extractClaimsForEntity(resourceText, resource, entity, { model });
    allResults.push({ entity, claims });
    const directCount = claims.filter(cl => cl.relevance === 'direct').length;
    console.log(` ${c.green}${claims.length} claims${c.reset} (${directCount} direct)`);
  }

  const totalClaims = allResults.reduce((s, r) => s + r.claims.length, 0);
  console.log(`\n  Total extracted: ${c.bold}${totalClaims}${c.reset} claims across ${targetEntities.length} entities`);

  if (dryRun) {
    // Show breakdown
    for (const { entity, claims } of allResults) {
      if (claims.length === 0) continue;
      console.log(`\n${c.bold}Entity: ${entity}${c.reset} (${claims.length} claims)`);
      const byCat: Record<string, number> = {};
      for (const cl of claims) {
        byCat[cl.claimType] = (byCat[cl.claimType] ?? 0) + 1;
      }
      for (const [type, cnt] of Object.entries(byCat)) {
        console.log(`  ${type.padEnd(14)} ${cnt}`);
      }
      console.log(`\n  Sample claims:`);
      for (const cl of claims.slice(0, 5)) {
        const quote = cl.sourceQuote ? ` → "${cl.sourceQuote.slice(0, 60)}..."` : '';
        console.log(`  [${cl.claimType}/${cl.relevance}] ${cl.claimText.slice(0, 100)}${quote}`);
      }
      if (claims.length > 5) console.log(`  ... and ${claims.length - 5} more`);
    }
    console.log(`\n${c.green}Dry run complete. Remove --dry-run to store.${c.reset}\n`);
    return;
  }

  // Insert into PostgreSQL
  console.log(`\n  Storing in PostgreSQL...`);

  const BATCH_SIZE = 50;
  let inserted = 0;
  let failed = 0;

  for (const { entity, claims } of allResults) {
    if (claims.length === 0) continue;

    const items: InsertClaimItem[] = claims.map(claim => ({
      entityId: entity,
      entityType: 'wiki-page',
      claimType: claim.claimType,
      claimText: claim.claimText,
      confidence: 'unverified',
      sourceQuote: claim.sourceQuote ?? null,
      // Enhanced fields
      claimCategory: claimTypeToCategory(claim.claimType),
      relatedEntities: claim.relatedEntities && claim.relatedEntities.length > 0
        ? claim.relatedEntities
        : null,
      // Resource linkage
      resourceIds: [resource.id],
      // Legacy fields
      value: `From: ${resource.title?.slice(0, 200) ?? resource.id}`,
      unit: claim.relevance,
      section: `Resource: ${resource.id}`,
    }));

    // Insert in batches
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const result = await insertClaimBatch(batch);
      if (result.ok) {
        inserted += result.data.inserted;
      } else {
        failed += batch.length;
        console.warn(`  ${c.yellow}[warn] Batch insert failed for ${entity}: ${String(result.error).slice(0, 80)}${c.reset}`);
      }
    }
  }

  console.log(`\n${c.bold}Done:${c.reset}`);
  console.log(`  Inserted: ${c.green}${inserted}${c.reset} claims`);
  if (failed > 0) {
    console.log(`  Failed:   ${c.red}${failed}${c.reset}`);
  }
  console.log(`\n  Next steps:`);
  for (const { entity } of allResults) {
    console.log(`    pnpm crux claims status ${entity}    # Check entity claim coverage`);
  }
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims ingest-resource failed:', err);
    process.exit(1);
  });
}
