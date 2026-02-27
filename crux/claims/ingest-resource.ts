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
 *   claimMode     = "attributed"    ← resource says X, wiki doesn't endorse
 *   attributedTo  = resource.authors[0] (when available)
 *   asOf          = resource.published_date (when available)
 *   sources[]     = inline source with resourceId, url, sourceQuote
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
import { callOpenRouter, stripCodeFences, parseJsonWithRepair, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  insertClaimBatch,
  getClaimsByEntity,
  clearClaimsBySection,
  type InsertClaimItem,
} from '../lib/wiki-server/claims.ts';
import { loadResources } from '../resource-io.ts';
import { VALID_CLAIM_TYPES, claimTypeToCategory, parseNumericValue, deduplicateClaims } from '../lib/claim-utils.ts';
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
export function buildResourceText(resource: Resource & { localFilename?: string }): string {
  // Try local cached text file
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
  if (resource.published_date || resource.date) {
    const d = resource.published_date ?? resource.date;
    parts.push(`Published: ${d}`);
  }
  if (resource.abstract) {
    parts.push(`\n## Abstract\n${resource.abstract}`);
  }
  if (resource.summary) {
    parts.push(`\n## Summary\n${resource.summary}`);
  }
  if (resource.key_points && resource.key_points.length > 0) {
    parts.push(`\n## Key Points\n${resource.key_points.map(p => `- ${p}`).join('\n')}`);
  }
  if (resource.review) {
    parts.push(`\n## Review\n${resource.review}`);
  }

  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// LLM extraction — resource-aware, entity-targeted
// ---------------------------------------------------------------------------

export interface ExtractedResourceClaim {
  claimText: string;
  claimType: ClaimTypeValue;
  relevance: 'direct' | 'contextual' | 'background';
  // Phase 2 fields — only 'endorsed' and 'attributed' are currently accepted by the server schema
  claimMode: 'endorsed' | 'attributed';
  attributedTo?: string;
  asOf?: string;
  measure?: string;
  valueNumeric?: number;
  valueLow?: number;
  valueHigh?: number;
  sourceQuote?: string;
  relatedEntities?: string[];
  // Structured claim fields (Phase 3 — Wikidata-style)
  subjectEntity?: string;
  property?: string;
  structuredValue?: string;
  valueUnit?: string;
  valueDate?: string;
  qualifiers?: Record<string, string>;
}

export function buildExtractionPrompt(resource: Resource, targetEntity: string): string {
  return `You are extracting factual claims from an external resource (paper, article, report) that is relevant to a wiki article about "${targetEntity}".

Resource metadata:
- Title: ${resource.title ?? 'Unknown'}
- URL: ${resource.url}
- Authors: ${resource.authors?.join(', ') ?? 'Unknown'}
- Type: ${resource.type}

For each claim, provide:
- "claimText": a single atomic, self-contained factual statement
- "claimType": one of: "factual", "numeric", "historical", "evaluative", "causal", "consensus", "speculative", "relational"
- "relevance": "direct" (explicitly about ${targetEntity}), "contextual" (directly related context), or "background" (general field context)
- "claimMode": "endorsed" (resource asserts this), or "attributed" (resource reports what someone else claims)
- "attributedTo": (only when claimMode="attributed") the entity or name making the claim (e.g. "openai", "the authors")
- "asOf": (optional) date this claim was true, YYYY-MM or YYYY-MM-DD format
- "measure": (optional, only for numeric claims) snake_case measure ID: "valuation", "funding_total", "employee_count", "revenue", "parameters", "benchmark_score"
- "valueNumeric": (optional) central numeric value as plain number (e.g. 7300000000 for $7.3B, 0.92 for 92%)
- "valueLow": (optional) lower bound if a range is given
- "valueHigh": (optional) upper bound if a range is given
- "sourceQuote": REQUIRED — a SHORT verbatim quote (max 200 chars) copied exactly from the resource text that supports this claim. Every claim MUST include a sourceQuote.
- "relatedEntities": other entity IDs/names mentioned alongside ${targetEntity} in the claim

Rules:
- Focus on claims most relevant to "${targetEntity}"
- Each claim must be atomic and self-contained
- Include specific numbers, names, and dates when present
- Skip trivial or overly general statements
- Extract 5-15 claims (fewer is fine if the resource is brief or tangential)
- Prefer "direct" relevance claims
- Use "numeric" claimType for any claim with specific dollar amounts, percentages, counts, or sizes
- Always include valueNumeric for numeric claims — extract the number even if written out (e.g. "$7.3 billion" → 7300000000)
- ALWAYS include sourceQuote — every claim must be grounded with an exact verbatim excerpt from the resource text

Respond ONLY with JSON:
{"claims": [{"claimText": "...", "claimType": "factual", "relevance": "direct", "claimMode": "endorsed", "sourceQuote": "...", "relatedEntities": []}]}`;
}

export async function extractClaimsForEntity(
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
    const parsed = parseJsonWithRepair<{ claims?: unknown[] }>(json);

    if (!Array.isArray(parsed.claims)) return [];

    return parsed.claims
      .filter((c): c is Record<string, unknown> =>
        typeof c === 'object' && c !== null &&
        typeof (c as Record<string, unknown>).claimText === 'string' &&
        ((c as Record<string, unknown>).claimText as string).length > 10
      )
      .map(c => ({
        claimText: c.claimText as string,
        claimType: (VALID_CLAIM_TYPES.includes(c.claimType as ClaimTypeValue)
          ? c.claimType
          : 'factual') as ClaimTypeValue,
        relevance: (['direct', 'contextual', 'background'].includes(c.relevance as string)
          ? c.relevance
          : 'contextual') as 'direct' | 'contextual' | 'background',
        claimMode: (c.claimMode === 'attributed' ? 'attributed' : 'endorsed') as 'endorsed' | 'attributed',
        attributedTo: typeof c.attributedTo === 'string' && c.attributedTo.length > 0
          ? c.attributedTo
          : undefined,
        asOf: typeof c.asOf === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(c.asOf)
          ? c.asOf
          : undefined,
        measure: typeof c.measure === 'string' && c.measure.length > 0
          ? c.measure
          : undefined,
        valueNumeric: parseNumericValue(c.valueNumeric),
        valueLow: parseNumericValue(c.valueLow),
        valueHigh: parseNumericValue(c.valueHigh),
        sourceQuote: typeof c.sourceQuote === 'string' && c.sourceQuote.length > 5
          ? c.sourceQuote.slice(0, 500)
          : undefined,
        relatedEntities: Array.isArray(c.relatedEntities)
          ? (c.relatedEntities as unknown[]).map(String).filter(s => s.length > 0)
          : [],
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Entity "${targetEntity}" — extraction failed: ${msg.slice(0, 120)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Build InsertClaimItem from extracted claim + resource context
// ---------------------------------------------------------------------------

/**
 * Convert an extracted resource claim into an InsertClaimItem ready for DB insertion.
 */
export function buildInsertItem(
  claim: ExtractedResourceClaim,
  entity: string,
  resource: Resource,
): InsertClaimItem {
  return {
    entityId: entity,
    entityType: 'wiki-page',
    claimType: claim.claimType,
    claimText: claim.claimText,
    confidence: 'unverified', // @deprecated Use claimVerdict instead
    /** @deprecated Use sources[] instead. Kept for backward compat (double-write). */
    sourceQuote: claim.sourceQuote ?? null,
    // Extraction doesn't verify — leave claimVerdict null (will be set by verify step)
    claimVerdict: null,
    // Enhanced fields
    claimCategory: claimTypeToCategory(claim.claimType),
    relatedEntities: claim.relatedEntities && claim.relatedEntities.length > 0
      ? claim.relatedEntities
      : null,
    // Phase 2 fields
    claimMode: claim.claimMode,
    attributedTo: claim.attributedTo ?? resource.authors?.[0] ?? null,
    asOf: claim.asOf ?? resource.published_date ?? null,
    measure: claim.measure ?? null,
    valueNumeric: claim.valueNumeric ?? null,
    valueLow: claim.valueLow ?? null,
    valueHigh: claim.valueHigh ?? null,
    // Structured claim fields (migration 0032)
    subjectEntity: claim.subjectEntity ?? null,
    property: claim.property ?? null,
    structuredValue: claim.structuredValue ?? null,
    valueUnit: claim.valueUnit ?? null,
    valueDate: claim.valueDate ?? null,
    qualifiers: claim.qualifiers ?? null,
    // Resource linkage via claim_sources + legacy resourceIds
    resourceIds: [resource.id],
    sources: claim.sourceQuote
      ? [{ resourceId: resource.id, sourceQuote: claim.sourceQuote, isPrimary: true }]
      : [{ resourceId: resource.id, isPrimary: true }],
    // Legacy fields
    value: `From: ${resource.title?.slice(0, 200) ?? resource.id}`,
    unit: claim.relevance,
    section: `Resource: ${resource.id}`,
  };
}

// ---------------------------------------------------------------------------
// Deduplication helper
// ---------------------------------------------------------------------------

/**
 * Fetch existing claim texts for an entity and deduplicate new claims against them.
 */
async function deduplicateAgainstExisting(
  entity: string,
  claims: ExtractedResourceClaim[],
  c: ReturnType<typeof getColors>,
): Promise<ExtractedResourceClaim[]> {
  const existingResult = await getClaimsByEntity(entity);
  if (!existingResult.ok || existingResult.data.claims.length === 0) {
    return claims;
  }

  const existingTexts = existingResult.data.claims.map(cl => cl.claimText);
  const { unique, duplicateCount } = deduplicateClaims(claims, existingTexts);

  if (duplicateCount > 0) {
    console.log(`  ${c.dim}Dedup: ${duplicateCount} duplicate(s) removed for ${entity}${c.reset}`);
  }

  return unique;
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

  const force = args.force === true;

  // Dedup check: skip entities that already have claims from this resource
  // (unless --force is passed, in which case clear first)
  const entitiesToProcess: string[] = [];
  if (!dryRun) {
    for (const entity of targetEntities) {
      const existing = await getClaimsByEntity(entity);
      const hasResourceClaims = existing.ok &&
        existing.data.claims.some(cl => cl.section === `Resource: ${resource.id}`);
      if (hasResourceClaims) {
        if (!force) {
          console.log(`  ${c.yellow}Skipping ${entity}: already has claims from ${resource.id}. Use --force to re-ingest.${c.reset}`);
          continue;
        }
        // --force: clear only claims from THIS resource (not page extraction or other resources)
        const sectionKey = `Resource: ${resource.id}`;
        const cleared = await clearClaimsBySection(entity, sectionKey);
        if (cleared.ok) {
          console.log(`  ${c.dim}Cleared ${cleared.data.deleted} existing claims for ${entity} from ${resource.id} (--force)${c.reset}`);
        }
      }
      entitiesToProcess.push(entity);
    }
  } else {
    entitiesToProcess.push(...targetEntities);
  }

  if (entitiesToProcess.length === 0) {
    console.log(`\n${c.yellow}All target entities already have claims from this resource.${c.reset}`);
    console.log(`  Use --force to re-ingest.\n`);
    return;
  }

  // Extract claims per target entity
  const allResults: Array<{
    entity: string;
    claims: ExtractedResourceClaim[];
  }> = [];

  for (const entity of entitiesToProcess) {
    process.stdout.write(`  ${c.dim}Extracting for ${entity}...${c.reset}`);
    let claims = await extractClaimsForEntity(resourceText, resource, entity, { model });
    const rawCount = claims.length;

    // Deduplicate against existing claims (skip during dry-run to avoid server dependency)
    if (!dryRun && claims.length > 0) {
      claims = await deduplicateAgainstExisting(entity, claims, c);
    }

    allResults.push({ entity, claims });
    const directCount = claims.filter(cl => cl.relevance === 'direct').length;
    const dedupNote = rawCount !== claims.length ? `, ${rawCount - claims.length} deduped` : '';
    console.log(` ${c.green}${claims.length} claims${c.reset} (${directCount} direct${dedupNote})`);
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
        const modeTag = cl.claimMode === 'attributed' ? ` [by:${cl.attributedTo ?? '?'}]` : '';
        const numTag = cl.valueNumeric !== undefined ? ` [=${cl.valueNumeric}]` : '';
        const asOfTag = cl.asOf ? ` [${cl.asOf}]` : '';
        console.log(`  [${cl.claimType}/${cl.relevance}${modeTag}${asOfTag}${numTag}] ${cl.claimText.slice(0, 100)}${quote}`);
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

    const items: InsertClaimItem[] = claims.map(claim =>
      buildInsertItem(claim, entity, resource),
    );

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

  const allClaims = allResults.flatMap(r => r.claims);
  const attributedCount = allClaims.filter(cl => cl.claimMode === 'attributed').length;
  const numericCount = allClaims.filter(cl => cl.valueNumeric !== undefined).length;

  console.log(`\n${c.bold}Done:${c.reset}`);
  console.log(`  Inserted: ${c.green}${inserted}${c.reset} claims`);
  if (attributedCount > 0) console.log(`  Attributed: ${c.yellow}${attributedCount}${c.reset} claims with attribution`);
  if (numericCount > 0) console.log(`  Numeric:    ${c.green}${numericCount}${c.reset} claims with extracted values`);
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
