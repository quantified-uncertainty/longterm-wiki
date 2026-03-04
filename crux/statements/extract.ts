/**
 * Statement Extraction — extract well-formed statements from wiki page prose.
 *
 * Uses LLM to extract factual statements from each section of a wiki page,
 * assigns properties from the controlled vocabulary, extracts typed values,
 * and maps each statement to [^rc-XXXX] footnotes.
 *
 * Statements are stored in the `statements` table with:
 *   subjectEntityId  = page entity slug (e.g., "anthropic")
 *   propertyId       = property from fact-measures.yaml vocabulary
 *   statementText    = human-readable claim text
 *   variety          = "structured" (has property+value) or "attributed" (reported speech)
 *   sourceFactKey    = hash for idempotent re-extraction
 *
 * Usage:
 *   pnpm crux statements extract <page-id>
 *   pnpm crux statements extract <page-id> --apply
 *   pnpm crux statements extract <page-id> --dry-run
 *   pnpm crux statements extract <page-id> --model=google/gemini-2.0-flash-001
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { callOpenRouter, stripCodeFences, parseJsonWithRepair, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  createStatementBatch,
  clearStatementsByEntity,
  getStatementsByEntity,
  getProperties,
  type CreateStatementInput,
} from '../lib/wiki-server/statements.ts';
import { cleanMdxForExtraction, splitIntoSections, type Section } from '../claims/extract.ts';
import { slugToDisplayName } from '../lib/claim-text-utils.ts';
import { getResourceById } from '../lib/search/resource-lookup.ts';
import { loadIdRegistry } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedStatement {
  statementText: string;
  variety: 'structured' | 'attributed';
  propertyId: string | null;
  valueNumeric: number | null;
  valueUnit: string | null;
  valueText: string | null;
  valueEntityId: string | null;
  valueDate: string | null;
  validStart: string | null;
  temporalGranularity: string | null;
  attributedTo: string | null;
  claimCategory: string;
  qualifierKey: string | null;
  footnoteRefs: string[];  // [^rc-XXXX] reference IDs
  section: string;
  inferenceType: string | null;
}

// ---------------------------------------------------------------------------
// rc- footnote parsing — extract [^rc-XXXX] markers from page content
// ---------------------------------------------------------------------------

/**
 * Parse [^rc-XXXX] inline citations from raw page content.
 * Returns a list of all rc- reference IDs found.
 */
export function parseRcFootnotes(body: string): string[] {
  const refs: string[] = [];
  const re = /\[\^(rc-[a-zA-Z0-9]+)\]/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    if (!refs.includes(match[1])) {
      refs.push(match[1]);
    }
  }
  return refs;
}

/**
 * Build a map from section heading to the [^rc-XXXX] references that appear in that section.
 */
export function buildSectionFootnoteMap(
  cleanBody: string,
  rawBody: string,
  sections: Section[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  // For each section, find the corresponding raw content and extract rc- refs
  for (const section of sections) {
    // Find the section in the raw body by matching the heading
    const headingPattern = section.level === 2
      ? `## ${section.heading}`
      : `### ${section.heading}`;

    const headingIdx = rawBody.indexOf(headingPattern);
    if (headingIdx < 0) {
      result.set(section.heading, []);
      continue;
    }

    // Find the end of this section (next heading of same or higher level)
    const afterHeading = rawBody.slice(headingIdx);
    const nextHeading = section.level === 2
      ? afterHeading.slice(headingPattern.length).search(/\n## /)
      : afterHeading.slice(headingPattern.length).search(/\n##[# ]?/);

    const sectionRawContent = nextHeading >= 0
      ? afterHeading.slice(0, headingPattern.length + nextHeading)
      : afterHeading;

    const refs: string[] = [];
    const re = /\[\^(rc-[a-zA-Z0-9]+)\]/g;
    let match;
    while ((match = re.exec(sectionRawContent)) !== null) {
      if (!refs.includes(match[1])) {
        refs.push(match[1]);
      }
    }
    result.set(section.heading, refs);
  }

  // Handle "Introduction" section (content before first heading)
  const firstHeadingIdx = rawBody.search(/\n## /);
  if (firstHeadingIdx >= 0) {
    const introContent = rawBody.slice(0, firstHeadingIdx);
    const refs: string[] = [];
    const re = /\[\^(rc-[a-zA-Z0-9]+)\]/g;
    let match;
    while ((match = re.exec(introContent)) !== null) {
      if (!refs.includes(match[1])) {
        refs.push(match[1]);
      }
    }
    result.set('Introduction', refs);
  }

  return result;
}

// ---------------------------------------------------------------------------
// LLM extraction prompt
// ---------------------------------------------------------------------------

function buildExtractionPrompt(propertyList: string): string {
  return `You are a statement-extraction assistant for a wiki knowledge base. Given a section of a wiki article, extract well-formed STATEMENTS that capture the key factual content.

A STATEMENT is a self-contained factual claim with optional structured data. Every statement needs:
1. "statementText" (required): A complete, self-contained sentence. Include the full entity name — never use "the company", "it", "they".
2. Optional structured fields: property, value, unit, date

PROPERTY VOCABULARY (use these exact IDs when they match):
${propertyList}

STATEMENT TYPES:
- "structured": Has a clear property+value from the vocabulary above. Most statements.
- "attributed": Reports what someone else said/claimed. Requires "attributedTo".

For each statement, provide:
- "statementText": Self-contained sentence (must include entity name, end with period)
- "variety": "structured" or "attributed"
- "propertyId": Property ID from vocabulary (null if no match — DO assign when possible)
- "valueNumeric": Numeric value as number (e.g., 14000000000 for $14B, 0.92 for 92%)
- "valueUnit": Unit — "USD", "percent", "count", "tokens", or null
- "valueText": Text value when not numeric (role names, qualitative descriptions)
- "valueEntityId": Entity slug when the value is another entity (e.g., "jan-leike")
- "validStart": Date when fact was true: "YYYY", "YYYY-MM", or "YYYY-MM-DD"
- "temporalGranularity": "year", "quarter", "month", or "day"
- "attributedTo": Entity slug of who said it (only for attributed variety)
- "claimCategory": "factual", "analytical", "speculative", "relational", or "opinion"
- "qualifierKey": Additional context key like "round:series-g" for funding rounds
- "footnoteRefs": Array of [^rc-XXXX] reference IDs from the text near this claim. CRITICAL: look for patterns like [^rc-1068] and include the full "rc-XXXX" string.
- "inferenceType": "direct_assertion", "derived", "aggregated", "interpreted", or "editorial"

GROUPING RULES:
- A statement should contain facts that can be VERIFIED TOGETHER against the same source(s)
- If two facts come from the same source and you'd check them together, they belong in ONE statement
- If they need different sources, make separate statements
- Aim for 5-12 statements per section (fewer but higher quality)

SELF-CONTAINMENT (critical):
- Every statement MUST be a complete, self-contained assertion
- Always include the full entity name (e.g., "Anthropic" not "the company")
- Each statement must end with a period

Respond ONLY with JSON:
{"statements": [{"statementText": "...", "variety": "structured", "propertyId": "revenue", ...}]}`;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export async function extractStatementsFromSection(
  section: Section,
  sectionFootnoteRefs: string[],
  opts: {
    model?: string;
    systemPrompt: string;
    entityName: string;
    subjectEntityId: string;
  },
): Promise<ExtractedStatement[]> {
  const userPrompt = `ENTITY: ${opts.entityName} (ID: ${opts.subjectEntityId})
SECTION: ${section.heading}
AVAILABLE FOOTNOTE REFS IN THIS SECTION: ${sectionFootnoteRefs.length > 0 ? sectionFootnoteRefs.join(', ') : '(none)'}

${section.content}

Extract statements from this section. Return JSON only.`;

  const finalSystemPrompt = `${opts.systemPrompt}

CRITICAL REMINDER: Every statement MUST include the full entity name — "${opts.entityName}" — not "the company", "it", "they", or any pronoun.`;

  try {
    const raw = await callOpenRouter(finalSystemPrompt, userPrompt, {
      model: opts.model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 3000,
      title: 'LongtermWiki Statement Extraction',
    });

    const json = stripCodeFences(raw);
    const parsed = parseJsonWithRepair<{ statements?: unknown[] }>(json);

    if (!Array.isArray(parsed.statements)) return [];

    return parsed.statements
      .filter((s): s is Record<string, unknown> =>
        typeof s === 'object' && s !== null &&
        typeof (s as Record<string, unknown>).statementText === 'string' &&
        ((s as Record<string, unknown>).statementText as string).length > 10
      )
      .map(s => ({
        statementText: (s.statementText as string).trim(),
        variety: s.variety === 'attributed' ? 'attributed' as const : 'structured' as const,
        propertyId: typeof s.propertyId === 'string' && s.propertyId.length > 0
          ? s.propertyId : null,
        valueNumeric: typeof s.valueNumeric === 'number' ? s.valueNumeric : null,
        valueUnit: typeof s.valueUnit === 'string' && s.valueUnit.length > 0
          ? s.valueUnit : null,
        valueText: typeof s.valueText === 'string' && s.valueText.length > 0
          ? s.valueText : null,
        valueEntityId: typeof s.valueEntityId === 'string' && s.valueEntityId.length > 0
          ? s.valueEntityId.toLowerCase() : null,
        valueDate: typeof s.valueDate === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s.valueDate)
          ? s.valueDate : null,
        validStart: typeof s.validStart === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s.validStart)
          ? s.validStart : null,
        temporalGranularity: typeof s.temporalGranularity === 'string'
          && ['year', 'quarter', 'month', 'day'].includes(s.temporalGranularity)
          ? s.temporalGranularity : null,
        attributedTo: typeof s.attributedTo === 'string' && s.attributedTo.length > 0
          ? s.attributedTo.toLowerCase() : null,
        claimCategory: typeof s.claimCategory === 'string'
          && ['factual', 'analytical', 'speculative', 'relational', 'opinion'].includes(s.claimCategory)
          ? s.claimCategory : 'factual',
        qualifierKey: typeof s.qualifierKey === 'string' && s.qualifierKey.length > 0
          ? s.qualifierKey : null,
        footnoteRefs: Array.isArray(s.footnoteRefs)
          ? (s.footnoteRefs as unknown[])
              .map(String)
              .filter(ref => /^rc-[a-zA-Z0-9]+$/.test(ref))
          : [],
        section: section.heading,
        inferenceType: typeof s.inferenceType === 'string'
          && ['direct_assertion', 'derived', 'aggregated', 'interpreted', 'editorial'].includes(s.inferenceType)
          ? s.inferenceType : null,
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Section "${section.heading}" — extraction failed: ${msg.slice(0, 120)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source fact key generation — for idempotent re-extraction
// ---------------------------------------------------------------------------

/**
 * Generate a stable source fact key from statement text + entity ID.
 * Used for idempotent re-extraction: same text = same key = skip duplicate.
 */
export function generateSourceFactKey(entityId: string, statementText: string): string {
  const hash = createHash('sha256')
    .update(`${entityId}:${statementText}`)
    .digest('hex')
    .slice(0, 8);
  return `${entityId}.${hash}`;
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

function extractFrontmatter(raw: string): {
  title: string | undefined;
  entityType: string | undefined;
  numericId: string | undefined;
} {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { title: undefined, entityType: undefined, numericId: undefined };
  const fm = fmMatch[1];
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const entityTypeMatch = fm.match(/^entityType:\s*["']?(.+?)["']?\s*$/m);
  const numericIdMatch = fm.match(/^numericId:\s*["']?(E?\d+)["']?\s*$/m);
  return {
    title: titleMatch ? titleMatch[1] : undefined,
    entityType: entityTypeMatch ? entityTypeMatch[1] : undefined,
    numericId: numericIdMatch ? numericIdMatch[1] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Property vocabulary loading
// ---------------------------------------------------------------------------

async function loadPropertyVocabulary(): Promise<{ list: string; ids: Set<string> }> {
  const result = await getProperties();
  if (!result.ok) {
    return { list: '(could not load properties)', ids: new Set() };
  }

  const ids = new Set<string>();
  const lines: string[] = [];

  // Group by category
  const byCategory = new Map<string, typeof result.data.properties>();
  for (const p of result.data.properties) {
    ids.add(p.id);
    const cat = p.category ?? 'other';
    const group = byCategory.get(cat) ?? [];
    group.push(p);
    byCategory.set(cat, group);
  }

  for (const [cat, props] of byCategory) {
    lines.push(`  ${cat}:`);
    for (const p of props) {
      const unit = p.defaultUnit ? ` (${p.defaultUnit})` : '';
      lines.push(`    "${p.id}" — ${p.label}${unit}`);
    }
  }

  return { list: lines.join('\n'), ids };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = !args.apply;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements extract <page-id> [--apply] [--model=X]`);
    process.exit(1);
  }

  // Check server availability
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`);
    process.exit(1);
  }

  // Find and read page
  const filePath = findPageFile(pageId);
  if (!filePath) {
    console.error(`${c.red}Error: page "${pageId}" not found${c.reset}`);
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const { title, numericId } = extractFrontmatter(raw);
  const body = stripFrontmatter(raw);
  const cleanBody = cleanMdxForExtraction(body);
  const sections = splitIntoSections(cleanBody);

  // Parse page integer ID for page references — try frontmatter first, then ID registry
  let pageIdInt = numericId
    ? parseInt(numericId.replace(/^E/, ''), 10)
    : null;
  if (!pageIdInt) {
    const registry = loadIdRegistry();
    const eId = registry.bySlug[pageId]; // e.g. "E42"
    if (eId) {
      pageIdInt = parseInt(eId.replace(/^E/, ''), 10);
    }
  }

  const entityName = title ?? slugToDisplayName(pageId);

  // Load property vocabulary
  const { list: propertyList, ids: propertyIds } = await loadPropertyVocabulary();

  // Load valid entity IDs from the ID registry (for FK validation)
  const registry = loadIdRegistry();
  const validEntityIds = new Set(Object.keys(registry.bySlug));

  // Build footnote map: section heading -> [^rc-XXXX] references
  const sectionFootnoteMap = buildSectionFootnoteMap(cleanBody, body, sections);

  console.log(`\n${c.bold}${c.blue}Statement Extraction: ${pageId}${c.reset}\n`);
  console.log(`  Page: ${entityName}`);
  console.log(`  Sections: ${sections.length}`);
  console.log(`  Page ID (int): ${pageIdInt ?? 'unknown'}`);
  console.log(`  Properties loaded: ${propertyIds.size}`);
  if (model) console.log(`  Model: ${model}`);
  if (dryRun) console.log(`  ${c.yellow}DRY RUN — use --apply to store${c.reset}`);
  console.log('');

  // Build extraction prompt
  const systemPrompt = buildExtractionPrompt(propertyList);

  // Extract statements from each section
  const allStatements: ExtractedStatement[] = [];

  for (const section of sections) {
    if (section.content.trim().length < 50) continue;
    const sectionRefs = sectionFootnoteMap.get(section.heading) ?? [];
    process.stdout.write(`  ${c.dim}Extracting: ${section.heading.slice(0, 50)}...${c.reset}`);
    const extracted = await extractStatementsFromSection(section, sectionRefs, {
      model,
      systemPrompt,
      entityName,
      subjectEntityId: pageId,
    });
    allStatements.push(...extracted);
    console.log(` ${c.green}${extracted.length} statements${c.reset}`);
  }

  console.log(`\n  Total extracted: ${c.bold}${allStatements.length}${c.reset} statements`);

  // Validate property IDs against vocabulary
  let withProperty = 0;
  let invalidProperties = 0;
  const unknownProperties = new Set<string>();

  for (const stmt of allStatements) {
    if (stmt.propertyId) {
      if (propertyIds.has(stmt.propertyId)) {
        withProperty++;
      } else {
        unknownProperties.add(stmt.propertyId);
        invalidProperties++;
        // Don't reject — just clear the invalid property
        stmt.propertyId = null;
      }
    }
  }

  // Statistics
  const structured = allStatements.filter(s => s.variety === 'structured').length;
  const attributed = allStatements.filter(s => s.variety === 'attributed').length;
  const withFootnotes = allStatements.filter(s => s.footnoteRefs.length > 0).length;
  const withNumeric = allStatements.filter(s => s.valueNumeric !== null).length;

  console.log(`\n${c.bold}Statistics:${c.reset}`);
  console.log(`  Structured: ${c.green}${structured}${c.reset}`);
  console.log(`  Attributed: ${c.yellow}${attributed}${c.reset}`);
  console.log(`  With property: ${c.green}${withProperty}${c.reset} (${allStatements.length > 0 ? Math.round(withProperty / allStatements.length * 100) : 0}%)`);
  console.log(`  With footnotes: ${c.green}${withFootnotes}${c.reset} (${allStatements.length > 0 ? Math.round(withFootnotes / allStatements.length * 100) : 0}%)`);
  console.log(`  With numeric value: ${c.green}${withNumeric}${c.reset}`);
  if (invalidProperties > 0) {
    console.log(`  ${c.yellow}Invalid properties (cleared): ${invalidProperties}${c.reset}`);
    console.log(`    Unknown IDs: ${[...unknownProperties].join(', ')}`);
  }

  // Count how many entity FK fields will be sanitized
  const invalidValueEntities = allStatements.filter(s => s.valueEntityId && !validEntityIds.has(s.valueEntityId)).length;
  const invalidAttributedTo = allStatements.filter(s => s.attributedTo && !validEntityIds.has(s.attributedTo)).length;
  if (invalidValueEntities > 0 || invalidAttributedTo > 0) {
    console.log(`  ${c.yellow}FK sanitization:${c.reset}`);
    if (invalidValueEntities > 0) console.log(`    valueEntityId cleared: ${invalidValueEntities}`);
    if (invalidAttributedTo > 0) console.log(`    attributedTo cleared: ${invalidAttributedTo}`);
  }

  if (dryRun) {
    // Show sample statements
    console.log(`\n${c.bold}Sample statements:${c.reset}`);
    for (const stmt of allStatements.slice(0, 10)) {
      const propTag = stmt.propertyId ? ` [${stmt.propertyId}]` : '';
      const valTag = stmt.valueNumeric !== null ? ` = ${stmt.valueNumeric}` : '';
      const refsTag = stmt.footnoteRefs.length > 0 ? ` {${stmt.footnoteRefs.join(', ')}}` : '';
      const attrTag = stmt.attributedTo ? ` [by: ${stmt.attributedTo}]` : '';
      console.log(`  [${stmt.variety}${propTag}${valTag}${attrTag}${refsTag}]`);
      console.log(`    ${stmt.statementText.slice(0, 100)}${stmt.statementText.length > 100 ? '...' : ''}`);
    }
    if (allStatements.length > 10) {
      console.log(`  ... and ${allStatements.length - 10} more`);
    }

    // Section breakdown
    const bySectionMap = new Map<string, number>();
    for (const stmt of allStatements) {
      bySectionMap.set(stmt.section, (bySectionMap.get(stmt.section) ?? 0) + 1);
    }
    console.log(`\n${c.bold}By section:${c.reset}`);
    for (const [sec, cnt] of bySectionMap) {
      console.log(`  ${sec.slice(0, 40).padEnd(40)} ${cnt}`);
    }

    console.log(`\n${c.green}Dry run complete. Use --apply to store in database.${c.reset}\n`);
    return;
  }

  // Clear existing extracted statements and re-insert (idempotent re-extraction)
  console.log(`\n  Clearing existing extracted statements for ${pageId}...`);
  const clearResult = await clearStatementsByEntity(pageId);
  if (clearResult.ok) {
    console.log(`  ${c.dim}Cleared ${clearResult.data.deleted} existing statements${c.reset}`);
  }

  // Convert to CreateStatementInput and batch insert
  console.log(`  Inserting ${allStatements.length} statements...`);

  const BATCH_SIZE = 50;
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < allStatements.length; i += BATCH_SIZE) {
    const batch = allStatements.slice(i, i + BATCH_SIZE);
    const items: CreateStatementInput[] = batch.map(stmt => {
      const sfk = generateSourceFactKey(pageId, stmt.statementText);
      // Only set propertyId if it exists in the DB (FK constraint)
      const validPropertyId = stmt.propertyId && propertyIds.has(stmt.propertyId) ? stmt.propertyId : null;
      // Validate entity FK fields — LLM may generate slugs that don't exist in entities table
      const validValueEntityId = stmt.valueEntityId && validEntityIds.has(stmt.valueEntityId) ? stmt.valueEntityId : null;
      const validAttributedTo = stmt.attributedTo && validEntityIds.has(stmt.attributedTo) ? stmt.attributedTo : null;
      // Sanitize numeric values — NaN/Infinity cause Postgres errors
      const safeNumeric = stmt.valueNumeric != null && Number.isFinite(stmt.valueNumeric) ? stmt.valueNumeric : null;
      return {
        variety: stmt.variety,
        statementText: stmt.statementText,
        subjectEntityId: pageId,
        propertyId: validPropertyId,
        qualifierKey: stmt.qualifierKey,
        valueNumeric: safeNumeric,
        valueUnit: stmt.valueUnit,
        valueText: stmt.valueText,
        valueEntityId: validValueEntityId,
        valueDate: stmt.valueDate,
        validStart: stmt.validStart,
        temporalGranularity: stmt.temporalGranularity,
        attributedTo: validAttributedTo,
        note: stmt.inferenceType ? `inference: ${stmt.inferenceType}` : null,
        sourceFactKey: sfk,
        claimCategory: stmt.claimCategory,
        citations: stmt.footnoteRefs.map((ref, idx) => {
          const resource = getResourceById(ref);
          return {
            // Don't set resourceId — rc-XXXX IDs are local YAML identifiers,
            // not entries in the wiki-server resources table (FK constraint).
            // Store the URL instead for display and verification.
            resourceId: null,
            url: resource?.url ?? null,
            sourceQuote: null,
            locationNote: `footnote: ${ref}`,
            isPrimary: idx === 0,
          };
        }),
        pageReferences: pageIdInt
          ? stmt.footnoteRefs.map(ref => ({
              pageIdInt,
              footnoteResourceId: ref,
              section: stmt.section,
            }))
          : [],
      };
    });

    const result = await createStatementBatch(items);
    if (result.ok) {
      inserted += result.data.inserted;
    } else {
      failed += batch.length;
      console.error(`  ${c.red}Batch insert failed: ${result.message}${c.reset}`);
      // Log first item for debugging
      if (items.length > 0) {
        const sample = items[0];
        console.error(`  ${c.dim}Sample item: variety=${sample.variety}, text="${(sample.statementText ?? '').slice(0, 60)}...", prop=${sample.propertyId}, valueNum=${sample.valueNumeric}, valueEntity=${sample.valueEntityId}, attributedTo=${sample.attributedTo}${c.reset}`);
      }
    }
  }

  console.log(`\n${c.bold}Done:${c.reset}`);
  console.log(`  Inserted: ${c.green}${inserted}${c.reset} statements`);
  console.log(`  With property: ${c.green}${withProperty}${c.reset} (${allStatements.length > 0 ? Math.round(withProperty / allStatements.length * 100) : 0}%)`);
  console.log(`  With citations: ${c.green}${withFootnotes}${c.reset}`);
  if (failed > 0) {
    console.log(`  Failed: ${c.red}${failed}${c.reset}`);
  }
  console.log(`\n  Next steps:`);
  console.log(`    pnpm crux statements verify ${pageId}    # Verify against sources`);
  console.log(`    pnpm crux statements quality ${pageId}   # Coverage report`);
  console.log('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement extraction failed:', err);
    process.exit(1);
  });
}
