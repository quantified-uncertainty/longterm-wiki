/**
 * Claims Enrich Structured — add structured fields to existing claims
 *
 * Two-pass approach: claims are extracted first (without structured fields),
 * then this command enriches them with subject/property/value decomposition.
 *
 * This is more reliable than embedding structured fields in the extraction
 * prompt, where all tested models (Gemini Flash, Claude Haiku, Claude Sonnet)
 * ignored the structured field instructions entirely.
 *
 * Usage:
 *   pnpm crux claims enrich-structured <page-id>
 *   pnpm crux claims enrich-structured <page-id> --dry-run
 *   pnpm crux claims enrich-structured <page-id> --model=anthropic/claude-sonnet-4
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { callOpenRouter, stripCodeFences, parseJsonWithRepair, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  getClaimsByEntity,
  batchUpdateStructuredFields,
  type ClaimRow,
} from '../lib/wiki-server/claims.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Normalize partial dates to PostgreSQL DATE format (YYYY-MM-DD). */
function normalizeDate(d: string): string {
  if (/^\d{4}$/.test(d)) return `${d}-01-01`;          // "2024" → "2024-01-01"
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-01`;       // "2024-03" → "2024-03-01"
  return d;                                              // "2024-03-15" → as-is
}

// Load property vocabulary
interface PropertyEntry {
  id: string;
  label: string;
  description: string;
  value_type: string;
  value_unit?: string;
  category: string;
}

function loadProperties(): PropertyEntry[] {
  const raw = readFileSync(join(__dirname, '../../data/claims-properties.yaml'), 'utf-8');
  const parsed = yaml.load(raw) as { properties?: PropertyEntry[] } | null;
  if (!parsed?.properties || !Array.isArray(parsed.properties)) return [];
  return parsed.properties.filter(
    (p): p is PropertyEntry => typeof p?.id === 'string' && typeof p?.label === 'string',
  );
}

const ENRICH_SYSTEM_PROMPT = (properties: ReturnType<typeof loadProperties>) => `You are a structured data extraction assistant. Given a list of claims about an entity, decompose each claim into structured fields where possible.

AVAILABLE PROPERTIES (use these when they fit):
${properties.map(p => `  "${p.id}" — ${p.description} (${p.value_type}${p.value_unit ? ', unit: ' + p.value_unit : ''})`).join('\n')}

If no predefined property fits but the claim has a clear measurable/structured value, create a descriptive snake_case property (e.g. "monthly_active_users", "board_seat_count", "safety_level").

For each claim, return:
- "id": the claim ID (integer, from input)
- "subjectEntity": lowercase slug of the entity this claim is about (e.g. "anthropic", "dario-amodei")
- "property": snake_case property identifier
- "structuredValue": normalized value as string (e.g. "30000000" for $30M, "2021" for year, "san-francisco" for city)
- "valueUnit": one of "USD", "percent", "count", "tokens", "year", or null for strings
- "valueDate": YYYY-MM-DD or YYYY-MM when this value was true/measured, or null
- "qualifiers": object with extra context (e.g. {"round": "Series B"}) or null

RULES:
- ONLY return claims that CAN be structured — skip evaluative opinions, causal assertions, and vague statements
- A claim like "Anthropic raised $124M in Series A" → {"property": "funding_round_amount", "structuredValue": "124000000", "valueUnit": "USD", "qualifiers": {"round": "Series A"}}
- A claim like "Anthropic was founded in 2021" → {"property": "founded_date", "structuredValue": "2021", "valueUnit": "year"}
- A claim like "Claude 3 Opus scored 86.8% on MMLU" → {"property": "benchmark_score", "structuredValue": "86.8", "valueUnit": "percent", "qualifiers": {"benchmark": "MMLU"}}
- A claim like "Critics argue Anthropic is too cautious" → SKIP (not structurable)
- Always normalize numbers: "$7.3 billion" → "7300000000", "42%" → "42"

Respond ONLY with JSON:
{"enriched": [{"id": 123, "subjectEntity": "anthropic", "property": "funding_round_amount", "structuredValue": "124000000", "valueUnit": "USD", "valueDate": "2023-05", "qualifiers": {"round": "Series A"}}]}`;

interface EnrichedClaim {
  id: number;
  subjectEntity: string;
  property: string;
  structuredValue: string;
  valueUnit?: string | null;
  valueDate?: string | null;
  qualifiers?: Record<string, string> | null;
}

async function enrichBatch(
  claims: ClaimRow[],
  properties: ReturnType<typeof loadProperties>,
  opts: { model?: string },
): Promise<EnrichedClaim[]> {
  const claimList = claims.map(c => ({
    id: c.id,
    claimText: c.claimText,
    claimType: c.claimType,
    entityId: c.entityId,
  }));

  const userPrompt = `Here are ${claims.length} claims to analyze. For each one that can be decomposed into structured subject/property/value fields, return the structured data. Skip claims that can't be structured.

${JSON.stringify(claimList, null, 2)}`;

  const raw = await callOpenRouter(
    ENRICH_SYSTEM_PROMPT(properties),
    userPrompt,
    {
      model: opts.model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 4000,
      title: 'LongtermWiki Claims Structured Enrichment',
    },
  );

  const json = stripCodeFences(raw);
  const parsed = parseJsonWithRepair<{ enriched?: unknown[] }>(json);

  if (!Array.isArray(parsed.enriched)) return [];

  return parsed.enriched
    .filter((e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null &&
      typeof (e as Record<string, unknown>).id === 'number' &&
      typeof (e as Record<string, unknown>).property === 'string' &&
      typeof (e as Record<string, unknown>).subjectEntity === 'string'
    )
    .map(e => ({
      id: e.id as number,
      subjectEntity: (e.subjectEntity as string).toLowerCase(),
      property: e.property as string,
      structuredValue: typeof e.structuredValue === 'number'
        ? String(e.structuredValue)
        : (e.structuredValue as string) ?? '',
      valueUnit: typeof e.valueUnit === 'string' ? e.valueUnit : null,
      valueDate: typeof e.valueDate === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(e.valueDate)
        ? normalizeDate(e.valueDate) : null,
      qualifiers: typeof e.qualifiers === 'object' && e.qualifiers !== null
        ? Object.fromEntries(Object.entries(e.qualifiers as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : null,
    }));
}

export async function runEnrichStructured(): Promise<void> {
  const c = getColors();
  const args = parseCliArgs(process.argv.slice(2));
  const pageId = args._positional[0];
  const dryRun = args['dry-run'] === true;
  const model = typeof args.model === 'string' ? args.model : undefined;

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error('  Usage: pnpm crux claims enrich-structured <page-id> [--dry-run] [--model=M]');
    process.exit(1);
  }

  console.log(`\n${c.bold}${c.blue}Claims Enrich Structured: ${pageId}${c.reset}\n`);

  if (!await isServerAvailable()) {
    console.error(`${c.red}Error: wiki-server not available${c.reset}`);
    process.exit(1);
  }

  // Fetch existing claims
  const result = await getClaimsByEntity(pageId);
  if (!result.ok) {
    console.error(`${c.red}Error fetching claims: ${result.error}${c.reset}`);
    process.exit(1);
  }

  const allClaims = result.data.claims;
  // Filter to claims that don't already have structured fields
  const unenriched = allClaims.filter(cl => !cl.property);
  // Focus on types that are likely structurable
  const candidates = unenriched.filter(cl =>
    ['factual', 'numeric', 'historical', 'relational'].includes(cl.claimType)
  );

  console.log(`  Total claims: ${allClaims.length}`);
  console.log(`  Already structured: ${allClaims.length - unenriched.length}`);
  console.log(`  Candidates for enrichment: ${candidates.length}`);
  if (dryRun) console.log(`  ${c.yellow}DRY RUN — no changes will be saved${c.reset}`);
  console.log();

  if (candidates.length === 0) {
    console.log(`${c.green}No candidates to enrich.${c.reset}`);
    return;
  }

  // Load property vocabulary
  const properties = loadProperties();
  console.log(`  Property vocabulary: ${properties.length} properties loaded`);

  // Process in batches of 30 claims
  const BATCH_SIZE = 30;
  const allEnriched: EnrichedClaim[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);
    process.stdout.write(`  ${c.dim}Enriching batch ${batchNum}/${totalBatches} (${batch.length} claims)...${c.reset} `);

    try {
      const enriched = await enrichBatch(batch, properties, { model });
      allEnriched.push(...enriched);
      console.log(`${c.green}${enriched.length} structured${c.reset}`);
    } catch (err) {
      console.log(`${c.red}failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`);
    }
  }

  // Display results
  console.log(`\n${c.bold}Results:${c.reset}`);
  console.log(`  ${c.green}${allEnriched.length}${c.reset} claims enriched out of ${candidates.length} candidates`);

  // Property distribution
  const propCounts: Record<string, number> = {};
  for (const e of allEnriched) {
    propCounts[e.property] = (propCounts[e.property] ?? 0) + 1;
  }
  if (Object.keys(propCounts).length > 0) {
    console.log(`\n${c.bold}By property:${c.reset}`);
    for (const [prop, cnt] of Object.entries(propCounts).sort((a, b) => b[1] - a[1])) {
      const known = properties.find(p => p.id === prop);
      const tag = known ? '' : ` ${c.yellow}(custom)${c.reset}`;
      console.log(`  ${prop.padEnd(28)} ${cnt}${tag}`);
    }
  }

  // Show samples
  console.log(`\n${c.bold}Sample enrichments:${c.reset}`);
  for (const e of allEnriched.slice(0, 10)) {
    const claim = candidates.find(cl => cl.id === e.id);
    const qualStr = e.qualifiers ? ` ${JSON.stringify(e.qualifiers)}` : '';
    console.log(`  [${e.subjectEntity}.${e.property}=${e.structuredValue}${e.valueUnit ? ' ' + e.valueUnit : ''}${e.valueDate ? ' @' + e.valueDate : ''}${qualStr}]`);
    console.log(`    ${c.dim}${claim?.claimText?.slice(0, 100) ?? '?'}${c.reset}`);
  }

  if (dryRun) {
    console.log(`\n${c.green}Dry run complete. Remove --dry-run to save.${c.reset}\n`);
    return;
  }

  // Save to database
  console.log(`\n  Saving ${allEnriched.length} enrichments to database...`);
  const items = allEnriched.map(e => ({
    id: e.id,
    subjectEntity: e.subjectEntity,
    property: e.property,
    structuredValue: e.structuredValue,
    valueUnit: e.valueUnit,
    valueDate: e.valueDate,
    qualifiers: e.qualifiers,
  }));

  const SAVE_BATCH = 100;
  let saved = 0;
  for (let i = 0; i < items.length; i += SAVE_BATCH) {
    const batch = items.slice(i, i + SAVE_BATCH);
    const saveResult = await batchUpdateStructuredFields(batch);
    if (saveResult.ok) {
      saved += saveResult.data.updated;
    } else {
      console.error(`  ${c.red}Batch save failed: ${saveResult.error} — ${saveResult.message}${c.reset}`);
    }
  }

  console.log(`  ${c.green}${saved} claims updated in database${c.reset}\n`);
}

runEnrichStructured().catch((err) => {
  console.error('Enrich-structured failed:', err);
  process.exit(1);
});
