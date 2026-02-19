/**
 * Fact Extraction Script
 *
 * Scans wiki pages for volatile numbers that should be canonical facts
 * but are not yet in data/facts/*.yaml. Proposes new fact entries for
 * human review.
 *
 * Usage:
 *   pnpm crux facts extract <page-id>              # Analyze, propose facts (dry run)
 *   pnpm crux facts extract <page-id> --apply      # Write proposed facts to YAML
 *   pnpm crux facts extract --all [--limit=N]      # Scan all pages
 *   pnpm crux facts extract --all --report         # Scan all pages, generate report
 *
 * Implements issue #202 (Pass 2: Fact Extraction).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { randomBytes } from 'crypto';
import { parse as parseYaml } from 'yaml';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { createClient, MODELS, parseJsonResponse } from '../lib/anthropic.ts';
import { callClaude } from '../lib/anthropic.ts';
import { getColors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FactCandidateValue {
  min?: number;
  max?: number;
}

interface FactCandidate {
  /** Unique ID generated for this candidate (8-char hex) */
  id: string;
  /** Kebab-case entity ID, e.g. "openai", "anthropic" */
  entity: string;
  /** Suggested human-readable fact ID for the YAML comment */
  factId: string;
  /** Human-readable label */
  label: string;
  /** The numeric value or range */
  value: number | string | number[] | FactCandidateValue;
  /** When this value was current, e.g. "2025-10" or "2025" */
  asOf: string;
  /** Citation URL if visible in the source content */
  source?: string;
  /** Measure type, e.g. "valuation", "revenue" */
  measure?: string;
  /** Optional clarifying note */
  note?: string;
  /** Confidence in this being a good canonical fact */
  confidence: 'low' | 'medium' | 'high';
  /** Why this is a good fact candidate */
  reason: string;
  /** Surrounding text where the number appeared */
  rawContext: string;
}

interface LlmResponse {
  candidates?: Partial<FactCandidate>[];
}

interface ExistingFactEntry {
  entity: string;
  factId: string;
  value: unknown;
  note?: string;
  measure?: string;
}

// ---------------------------------------------------------------------------
// Fact ID generation
// ---------------------------------------------------------------------------

/** Generate an 8-char hex fact ID, matching the style used in data/facts/*.yaml */
function generateFactId(): string {
  return randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Existing facts loader
// ---------------------------------------------------------------------------

/** Load all facts currently in data/facts/*.yaml */
function loadExistingFacts(root: string): ExistingFactEntry[] {
  const factsDir = join(root, 'data/facts');
  if (!existsSync(factsDir)) return [];

  const results: ExistingFactEntry[] = [];
  const files = readdirSync(factsDir).filter(f => f.endsWith('.yaml'));

  for (const file of files) {
    try {
      const raw = readFileSync(join(factsDir, file), 'utf-8');
      const parsed = parseYaml(raw) as {
        entity: string;
        facts: Record<string, { value: unknown; note?: string; measure?: string }>;
      };
      if (parsed?.entity && parsed?.facts) {
        for (const [factId, fact] of Object.entries(parsed.facts)) {
          if (fact && typeof fact === 'object') {
            results.push({
              entity: parsed.entity,
              factId,
              value: fact.value,
              note: fact.note,
              measure: fact.measure,
            });
          }
        }
      }
    } catch {
      // Skip malformed YAML
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Content preprocessing
// ---------------------------------------------------------------------------

/**
 * Strip content that is already factually covered:
 * - Code blocks
 * - <F> tag references (already canonical facts)
 * - <Calc> tag references (computed facts)
 * - MDX import statements
 */
function stripAlreadyCoveredContent(content: string): string {
  // Remove fenced code blocks
  let stripped = content.replace(/```[\s\S]*?```/g, '[CODE_BLOCK]');
  // Remove inline code
  stripped = stripped.replace(/`[^`]+`/g, '[INLINE_CODE]');
  // Remove <F .../> self-closing tags
  stripped = stripped.replace(/<F\s[^>]*\/>/g, '[FACT_REF]');
  // Remove <F ...>...</F> tags
  stripped = stripped.replace(/<F(\s[^>]*)?>[\s\S]*?<\/F>/g, '[FACT_REF]');
  // Remove <Calc .../> self-closing tags
  stripped = stripped.replace(/<Calc\s[^>]*\/>/g, '[CALC_REF]');
  // Remove <Calc ...>...</Calc> tags
  stripped = stripped.replace(/<Calc(\s[^>]*)?>[\s\S]*?<\/Calc>/g, '[CALC_REF]');
  // Remove MDX import lines
  stripped = stripped.replace(/^import\s+.*$/gm, '');
  return stripped;
}

/** Find the absolute path of a page MDX file by its page-id */
function findPageFile(pageId: string): string | null {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  for (const f of files) {
    if (basename(f, '.mdx') === pageId) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM classification
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a fact extraction specialist for an AI safety wiki. Your task is to identify volatile, entity-attributable numbers in wiki pages that should become canonical facts.

A GOOD fact candidate must satisfy ALL of these criteria:
1. VOLATILE — likely to change over time (revenue, headcount, valuation, funding raised, benchmark scores). NOT founding dates, historical events, or static properties.
2. ENTITY-ATTRIBUTABLE — tied to a specific named organization or person (e.g. OpenAI, Anthropic, Meta AI). NOT vague industry-wide statistics.
3. MULTI-PAGE POTENTIAL — could reasonably appear on 2+ wiki pages (e.g. a company's valuation appears on its own page and on competitor comparison pages).
4. SOURCED — either has a citation in the content or is well-known enough to be verifiable.

ALWAYS EXCLUDE:
- Numbers already wrapped in <F> or <Calc> tags
- Historical/founding dates ("founded in 2015", "released in 2020")
- Projections without any source citation
- Vague statistics ("most AI systems", "researchers estimate")
- General benchmarks without entity attribution

For each candidate, return:
- entity: kebab-case entity ID (e.g. "openai", "anthropic", "meta-ai", "google-deepmind", "xai")
- factId: short kebab-case identifier (e.g. "valuation-2025", "revenue-arr", "employee-count-2024")
- label: human-readable label (e.g. "OpenAI valuation (October 2025)")
- value: the numeric value as a number, or a range as [min, max] array, or {"min": X} for lower bounds
- asOf: when this was current as "YYYY" or "YYYY-MM"
- source: URL if explicitly cited in the content (omit if not present)
- measure: one of: valuation, revenue, total-funding, funding-round, user-count, employee-count, model-parameters, benchmark-score, market-share, compute-cost, cash-burn, product-revenue, retention-rate, customer-count, equity-stake-percent, infrastructure-investment
- note: brief clarifying note (max 100 chars)
- confidence: "high" (clear number, named entity, sourced), "medium" (plausible but less certain), or "low" (uncertain)
- reason: one sentence explaining why this should be a canonical fact
- rawContext: the exact sentence(s) containing the number (max 200 chars)

Return a JSON object: {"candidates": [...]} — return empty array if no good candidates found.`;

async function classifyWithLlm(
  pageId: string,
  content: string,
  existingFacts: ExistingFactEntry[],
): Promise<FactCandidate[]> {
  const client = createClient({ required: false });
  if (!client) {
    console.warn('[facts] ANTHROPIC_API_KEY not found — skipping LLM classification');
    return [];
  }

  // Build a summary of existing facts to help the LLM avoid duplicates
  const contentLower = content.toLowerCase();
  const relevantExisting = existingFacts
    .filter(f => {
      const entityName = f.entity.replace(/-/g, ' ');
      return contentLower.includes(entityName) || contentLower.includes(f.entity);
    })
    .map(f => `${f.entity} (${f.factId}): ${JSON.stringify(f.value)}${f.note ? ` — ${f.note}` : ''}`)
    .slice(0, 30);

  const existingNote =
    relevantExisting.length > 0
      ? `\n\nEXISTING FACTS ALREADY IN DATABASE (do NOT propose duplicates):\n${relevantExisting.join('\n')}`
      : '';

  const prompt = `Analyze this wiki page (ID: ${pageId}) and extract volatile fact candidates.

PAGE CONTENT (numbers already in <F>/<Calc> tags have been replaced with placeholders):
---
${content.slice(0, 9000)}
---
${existingNote}

Return JSON with "candidates" array. Focus on high-confidence candidates only.`;

  const result = await callClaude(client, {
    model: MODELS.sonnet,
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    userPrompt: prompt,
    maxTokens: 3000,
    temperature: 0,
  });

  let parsed: LlmResponse;
  try {
    parsed = parseJsonResponse(result.text) as LlmResponse;
  } catch {
    console.error('[facts] Failed to parse LLM JSON response');
    return [];
  }

  const rawCandidates = parsed?.candidates || [];

  // Assign stable IDs and validate required fields
  return rawCandidates
    .filter(
      (c): c is Partial<FactCandidate> & { entity: string; label: string; value: unknown; asOf: string } =>
        typeof c.entity === 'string' &&
        typeof c.label === 'string' &&
        c.value !== undefined &&
        typeof c.asOf === 'string',
    )
    .map(c => ({
      id: generateFactId(),
      entity: c.entity,
      factId: c.factId || 'auto-extracted',
      label: c.label,
      value: c.value as FactCandidate['value'],
      asOf: c.asOf,
      source: c.source,
      measure: c.measure,
      note: c.note,
      confidence: c.confidence || 'medium',
      reason: c.reason || '',
      rawContext: c.rawContext || '',
    }));
}

// ---------------------------------------------------------------------------
// YAML block generation
// ---------------------------------------------------------------------------

/** Format a fact candidate as a YAML block to append to a facts file */
function generateYamlBlock(candidate: FactCandidate): string {
  const lines: string[] = [
    `  # ${candidate.factId}`,
    `  # AUTO-EXTRACTED — needs human review (confidence: ${candidate.confidence})`,
    `  ${candidate.id}:`,
  ];

  if (candidate.label) {
    lines.push(`    label: "${candidate.label}"`);
  }
  if (candidate.measure) {
    lines.push(`    measure: ${candidate.measure}`);
  }

  // Format value
  const val = candidate.value;
  if (Array.isArray(val)) {
    lines.push(`    value:`);
    for (const v of val) {
      lines.push(`      - ${v}`);
    }
  } else if (typeof val === 'object' && val !== null) {
    const range = val as FactCandidateValue;
    lines.push(`    value:`);
    if (range.min !== undefined) lines.push(`      min: ${range.min}`);
    if (range.max !== undefined) lines.push(`      max: ${range.max}`);
  } else if (typeof val === 'string') {
    lines.push(`    value: "${val}"`);
  } else {
    lines.push(`    value: ${val}`);
  }

  lines.push(`    asOf: "${candidate.asOf}"`);

  if (candidate.note) {
    // Escape any quotes in the note
    const safeNote = candidate.note.replace(/"/g, "'");
    lines.push(`    note: "${safeNote}"`);
  }
  if (candidate.source) {
    lines.push(`    source: ${candidate.source}`);
  }

  return lines.join('\n');
}

/**
 * Append candidates to the entity's YAML file.
 * Creates the file if it doesn't exist.
 */
function applyToYamlFile(entity: string, candidates: FactCandidate[], root: string): void {
  const factsDir = join(root, 'data/facts');
  mkdirSync(factsDir, { recursive: true });
  const yamlPath = join(factsDir, `${entity}.yaml`);

  const newBlocks = candidates.map(c => generateYamlBlock(c));

  let output: string;
  if (existsSync(yamlPath)) {
    const existing = readFileSync(yamlPath, 'utf-8').trimEnd();
    output = existing + '\n\n' + newBlocks.join('\n\n') + '\n';
  } else {
    output = `entity: ${entity}\nfacts:\n\n${newBlocks.join('\n\n')}\n`;
  }

  writeFileSync(yamlPath, output, 'utf-8');
  console.log(`  ✓ Appended ${candidates.length} candidate(s) to data/facts/${entity}.yaml`);
}

// ---------------------------------------------------------------------------
// Single page processing
// ---------------------------------------------------------------------------

async function processPage(
  pageId: string,
  existingFacts: ExistingFactEntry[],
  apply: boolean,
  colors: ReturnType<typeof getColors>,
): Promise<FactCandidate[]> {
  const pageFile = findPageFile(pageId);
  if (!pageFile) {
    console.error(`${colors.red}✗${colors.reset} Page not found: ${pageId}`);
    return [];
  }

  const raw = readFileSync(pageFile, 'utf-8');
  const body = stripFrontmatter(raw);
  const strippedContent = stripAlreadyCoveredContent(body);

  console.log(`\n${colors.cyan}📄 ${pageId}${colors.reset}`);

  // Classify with LLM
  let candidates: FactCandidate[];
  try {
    candidates = await classifyWithLlm(pageId, strippedContent, existingFacts);
  } catch (err) {
    console.error(
      `  ${colors.red}✗ LLM error: ${err instanceof Error ? err.message : String(err)}${colors.reset}`,
    );
    return [];
  }

  if (candidates.length === 0) {
    console.log(`  ${colors.dim}No fact candidates found.${colors.reset}`);
    return [];
  }

  // Group by entity for organized output
  const byEntity = new Map<string, FactCandidate[]>();
  for (const c of candidates) {
    if (!byEntity.has(c.entity)) byEntity.set(c.entity, []);
    byEntity.get(c.entity)!.push(c);
  }

  console.log(`  Found ${candidates.length} candidate(s):\n`);

  for (const [entity, entityCandidates] of byEntity) {
    console.log(`  ${colors.bold}Entity: ${entity}${colors.reset}`);
    for (const c of entityCandidates) {
      const confidenceIcon = c.confidence === 'high' ? '✓' : c.confidence === 'medium' ? '~' : '?';
      const confidenceColor =
        c.confidence === 'high' ? colors.green : c.confidence === 'medium' ? colors.yellow : colors.red;

      console.log(
        `  [${confidenceColor}${confidenceIcon}${colors.reset}] ${c.label} (${c.asOf}) = ${JSON.stringify(c.value)}`,
      );
      if (c.measure) console.log(`      measure: ${c.measure}`);
      console.log(`      reason: ${c.reason}`);
      if (c.rawContext) console.log(`      context: "${c.rawContext.slice(0, 120)}"`);
      console.log(`\n      YAML block:`);
      const yamlBlock = generateYamlBlock(c);
      console.log(
        yamlBlock
          .split('\n')
          .map(l => `        ${l}`)
          .join('\n'),
      );
      console.log();
    }

    if (apply) {
      applyToYamlFile(entity, entityCandidates, PROJECT_ROOT);
    }
  }

  if (!apply && candidates.length > 0) {
    console.log(`  ${colors.dim}(Dry run — use --apply to write to data/facts/ files)${colors.reset}\n`);
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const all = args.all === true;
  const report = args.report === true;
  const limit = parseInt((args.limit as string) || '20', 10);

  const colors = getColors();

  console.log(`${colors.bold}🔍 Fact Extraction Pipeline${colors.reset}`);
  console.log(
    `Mode: ${apply ? `${colors.yellow}APPLY${colors.reset} (will write to data/facts/ YAML files)` : `${colors.green}DRY RUN${colors.reset} (no files written)`}\n`,
  );

  const existingFacts = loadExistingFacts(PROJECT_ROOT);
  console.log(`Loaded ${existingFacts.length} existing facts from data/facts/\n`);

  if (all) {
    // Scan multiple pages
    const files = findMdxFiles(CONTENT_DIR_ABS);
    const pageIds = files
      .filter(f => !basename(f).startsWith('index.') && f.includes('/knowledge-base/'))
      .map(f => basename(f, '.mdx'))
      .slice(0, limit);

    console.log(`Scanning ${pageIds.length} knowledge-base pages (limit: ${limit})...\n`);

    const allResults: Array<{ pageId: string; candidates: FactCandidate[] }> = [];

    for (const pageId of pageIds) {
      const candidates = await processPage(pageId, existingFacts, apply, colors);
      if (candidates.length > 0) {
        allResults.push({ pageId, candidates });
      }
    }

    if (report || all) {
      console.log(`\n${colors.bold}📊 SUMMARY REPORT${colors.reset}`);
      console.log('='.repeat(50));
      console.log(`Pages scanned:          ${pageIds.length}`);
      console.log(`Pages with candidates:  ${allResults.length}`);
      const totalCandidates = allResults.reduce((s, r) => s + r.candidates.length, 0);
      console.log(`Total candidates found: ${totalCandidates}`);

      if (allResults.length > 0) {
        const highConf = allResults.flatMap(r =>
          r.candidates.filter(c => c.confidence === 'high'),
        );
        console.log(`High-confidence:        ${highConf.length}`);

        console.log('\nTop pages by candidate count:');
        const sorted = [...allResults].sort((a, b) => b.candidates.length - a.candidates.length);
        for (const { pageId, candidates } of sorted.slice(0, 10)) {
          console.log(`  ${pageId}: ${candidates.length} candidate(s)`);
        }
      }
    }
  } else {
    // Single page
    const pageId = args._positional[0] as string | undefined;
    if (!pageId) {
      console.error('Usage: crux facts extract <page-id> [--apply]');
      console.error('       crux facts extract --all [--apply] [--report] [--limit=N]');
      process.exit(1);
    }

    await processPage(pageId, existingFacts, apply, colors);
  }
}

main().catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
