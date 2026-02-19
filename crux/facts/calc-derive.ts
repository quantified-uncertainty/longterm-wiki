/**
 * Calc Derivation Script — Pass 3
 *
 * Scans wiki pages for hardcoded derived quantities (ratios, multiples, growth
 * rates, differences) and replaces them with <Calc> expressions that compute
 * from canonical facts. This keeps derived numbers in sync when source facts
 * are updated.
 *
 * Usage:
 *   pnpm crux facts calc <page-id>              # Preview replacements (dry run)
 *   pnpm crux facts calc <page-id> --apply      # Write changes to file
 *   pnpm crux facts calc --all [--limit=N]      # Run across multiple pages
 *
 * Implements issue #203 (Pass 3: Calc Derivation).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { createClient, MODELS, callClaude } from '../lib/anthropic.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';
import { getColors } from '../lib/output.ts';
import { evalCalcExpr } from '../lib/calc-evaluator.ts';
import { entityDisplayNames } from '../lib/entity-names.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FactEntry {
  label?: string;
  value: number | string | number[] | { min?: number; max?: number };
  numeric?: number;
  asOf?: string;
  note?: string;
  source?: string;
  noCompute?: boolean;
  compute?: string;
  measure?: string;
}

export interface FactFile {
  entity: string;
  facts: Record<string, FactEntry>;
}

export interface DetectedPattern {
  /** The matched text (e.g. "≈27x") */
  match: string;
  /** Line number (1-based) */
  line: number;
  /** Surrounding context (~300 chars before and after) */
  context: string;
  /** Approximate numeric value extracted from the match (for validation) */
  approximateValue?: number;
  /** Pattern type description */
  patternType: string;
}

export interface CalcProposal {
  /** The exact text in the MDX file to replace */
  originalText: string;
  /** The <Calc> expression, e.g. "{anthropic.valuation} / {anthropic.revenue-run-rate}" */
  expr: string;
  /** Decimal places (e.g. 0 for integer multiples) */
  precision?: number;
  /** Suffix to append (e.g. "x" for multiples, "%" for percentages) */
  suffix?: string;
  /** Prefix to prepend (e.g. "≈") */
  prefix?: string;
  /** Format mode: "currency" | "percent" | "number" | undefined (auto) */
  format?: string;
  /** Confidence: "high" | "medium" | "low" */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable explanation */
  explanation: string;
  /** Computed value (filled by validator) */
  computedValue?: number;
  /** Whether the expression validated successfully */
  valid?: boolean;
  /** Validation error message (if invalid) */
  validationError?: string;
}

interface LlmProposalResponse {
  proposals?: Array<Partial<CalcProposal>>;
}

// ---------------------------------------------------------------------------
// Hardcoded pattern detection (mirrors hardcoded-calculations.ts patterns)
// ---------------------------------------------------------------------------

export const CALC_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  // "≈27x" or "~42x" — approximate multiples
  {
    regex: /[≈~∼][\s]*\d+(?:\.\d+)?x\b/g,
    description: 'approximate multiple (≈Nx)',
  },
  // "27x revenue" / "42x earnings" / "15x multiple" — named multiples
  {
    regex: /\b\d+(?:\.\d+)?x\s+(?:revenue|earnings|multiple|valuation|salary|cost|faster|cheaper|more|growth|increase)/gi,
    description: 'named multiple (Nx revenue/cost/...)',
  },
  // "390x cost reduction" / "500-fold" / "300-fold" — fold changes
  {
    regex: /\b\d+(?:\.\d+)?(?:x|-fold)\s+(?:reduction|expansion|increase|improvement|growth|decrease|drop)/gi,
    description: 'fold change',
  },
  // "N:1 ratio" or "N:1 gap"
  {
    regex: /\b\d+(?:\.\d+)?:\d+\s+(?:ratio|gap|split)/gi,
    description: 'ratio (N:1)',
  },
];

/** Skip matches inside <Calc> or <F> tags */
export function isInsideCalcOrF(body: string, matchIndex: number): boolean {
  const before = body.slice(Math.max(0, matchIndex - 500), matchIndex);
  if (before.includes('<Calc ') && !before.includes('/>') && !before.includes('</Calc>')) return true;
  const lastF = before.lastIndexOf('<F ');
  if (lastF !== -1) {
    const afterF = before.slice(lastF);
    if (!afterF.includes('</F>') && !afterF.includes('/>')) return true;
  }
  return false;
}

/** Skip matches inside fenced code blocks */
export function isInCodeBlock(body: string, index: number): boolean {
  const before = body.slice(0, index);
  const fenceCount = (before.match(/^```/gm) || []).length;
  return fenceCount % 2 !== 0;
}

/** Extract approximate numeric value from a pattern match for validation */
export function extractNumericValue(matchText: string): number | undefined {
  const numMatch = matchText.match(/(\d+(?:\.\d+)?)/);
  if (!numMatch) return undefined;
  return parseFloat(numMatch[1]);
}

/**
 * Detect all hardcoded derived patterns in MDX body text.
 */
export function detectPatterns(body: string): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const lines = body.split('\n');
  const seen = new Set<string>(); // Deduplicate by line+text

  for (const { regex, description } of CALC_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(body)) !== null) {
      if (isInCodeBlock(body, match.index)) continue;
      if (isInsideCalcOrF(body, match.index)) continue;

      // Find line number
      const beforeMatch = body.slice(0, match.index);
      const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

      // Skip table separator rows
      const line = lines[lineNum - 1] || '';
      if (/^\|[\s-|]+\|$/.test(line)) continue;

      const key = `${lineNum}:${match[0].trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Gather context (300 chars before and after)
      const contextStart = Math.max(0, match.index - 300);
      const contextEnd = Math.min(body.length, match.index + match[0].length + 300);
      const context = body.slice(contextStart, contextEnd);

      patterns.push({
        match: match[0].trim(),
        line: lineNum,
        context: context.replace(/\n/g, ' ').slice(0, 600),
        approximateValue: extractNumericValue(match[0]),
        patternType: description,
      });
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Facts loader
// ---------------------------------------------------------------------------

/** Load all facts from data/facts/*.yaml, returning a flat lookup map */
function loadAllFacts(root: string): Map<string, FactFile> {
  const factsDir = join(root, 'data/facts');
  if (!existsSync(factsDir)) return new Map();

  const result = new Map<string, FactFile>();
  const files = readdirSync(factsDir).filter(f => f.endsWith('.yaml'));

  for (const file of files) {
    try {
      const raw = readFileSync(join(factsDir, file), 'utf-8');
      const parsed = parseYaml(raw) as FactFile;
      if (parsed?.entity && parsed?.facts) {
        result.set(parsed.entity, parsed);
      }
    } catch {
      // Skip malformed YAML
    }
  }

  return result;
}

/** Extract a single numeric value from a fact entry (handles range objects) */
function extractNumericFromFact(entry: FactEntry): number | null {
  if (typeof entry.numeric === 'number') return entry.numeric;
  if (typeof entry.value === 'number') return entry.value;
  // Handle range objects like { min: 500000000000 } or { min: N, max: M }
  if (entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)) {
    const range = entry.value as { min?: number; max?: number };
    if (typeof range.min === 'number' && typeof range.max === 'number') {
      return (range.min + range.max) / 2;
    }
    if (typeof range.min === 'number') return range.min;
    if (typeof range.max === 'number') return range.max;
  }
  return null;
}

/** Build a lookup function for evalCalcExpr given the facts map */
function buildFactLookup(
  factsMap: Map<string, FactFile>
): (entity: string, factId: string) => number | undefined {
  return (entity: string, factId: string) => {
    const factFile = factsMap.get(entity);
    if (!factFile) return undefined;
    const entry = factFile.facts[factId];
    if (!entry) return undefined;
    const val = extractNumericFromFact(entry);
    return val !== null ? val : undefined;
  };
}

/** Format facts as a compact table for the LLM prompt */
function formatFactsForPrompt(factsMap: Map<string, FactFile>, relevantEntities: Set<string>): string {
  const sections: string[] = [];

  for (const [entity, factFile] of factsMap) {
    if (!relevantEntities.has(entity)) continue;

    const rows: string[] = [];
    for (const [factId, fact] of Object.entries(factFile.facts)) {
      // Skip computed facts and facts with no numeric value
      if (fact.compute) continue;
      const numericVal = extractNumericFromFact(fact);
      if (numericVal === null) continue;

      const ref = `{${entity}.${factId}}`;
      const parts = [`${ref} = ${numericVal}`];
      if (fact.asOf) parts.push(`(as of ${fact.asOf})`);
      if (fact.label) parts.push(`"${fact.label}"`);
      else if (fact.note) parts.push(`— ${fact.note.slice(0, 80)}`);
      rows.push(parts.join(' '));
    }

    if (rows.length > 0) {
      sections.push(`## ${entity}\n${rows.join('\n')}`);
    }
  }

  return sections.join('\n\n');
}

/** Determine which entities are relevant to the page content */
function findRelevantEntities(content: string, factsMap: Map<string, FactFile>): Set<string> {
  const contentLower = content.toLowerCase();
  const relevant = new Set<string>();

  // Simple heuristic: check if entity name appears in content
  for (const entity of factsMap.keys()) {
    const names = entityDisplayNames[entity] || [entity];
    for (const name of names) {
      if (contentLower.includes(name.toLowerCase())) {
        relevant.add(entity);
        break;
      }
    }
  }

  return relevant;
}

// ---------------------------------------------------------------------------
// LLM proposal generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a wiki editor specializing in replacing hardcoded derived numbers with \`<Calc>\` components that compute from canonical facts.

A \`<Calc>\` component renders a math expression using canonical fact references like:
\`<Calc expr="{anthropic.6796e194} / {anthropic.0ed4db9e}" precision={0} suffix="x" prefix="≈" />\`

The fact references use the format \`{entity.factId}\` where both entity and factId are shown in the facts table.

## Your task

For each hardcoded derived pattern provided:
1. Determine if it can be computed from two or more facts in the provided facts table
2. If yes, generate the appropriate \`<Calc>\` expression
3. Choose correct props: precision, suffix, prefix, format
4. Provide the EXACT original text to replace — keep it as narrow as possible

## CRITICAL: originalText must be narrow and JSX-free

The \`originalText\` field is the exact substring that will be removed and replaced with the \`<Calc>\` tag. Rules:
- It MUST be the **match string itself** (exactly as given in "Match: ...")
- It MUST NOT contain any JSX/MDX tags (\`<F\`, \`<Calc\`, \`<EntityLink\`, etc.)
- It MUST NOT contain any markdown table pipe characters (\`|\`) — EVER, under any circumstances
- It MUST NOT span multiple words beyond the immediate number phrase
- It MAY add at most 20 extra characters of plain text for disambiguation (e.g. "(current)" to distinguish identical matches)
- **PREFERRED: When the match string uniquely or approximately identifies the location, use ONLY the match string itself** — never add disambiguation text unless absolutely necessary
- If multiple identical matches exist on the page, use the exact match string — the tool replaces the first occurrence per run, and you can process the rest in subsequent runs
- It MUST appear verbatim in the page content (character-for-character)
- The \`suffix\` prop must be a short unit or symbol only (e.g. "x", "%", " pp", "x/yr") — NEVER include prose words

Examples:
- BAD: \`"≈39x multiple at the previous <F e=\\"anthropic\\" ...>$350B</F> valuation..."\` (JSX tags)
- BAD: \`"OpenAI's ≈25x. The valuation itself"\` (too wide — 28 chars of extra prose)
- BAD: \`"≈25x | [i10x]"\` (contains table pipe — ABSOLUTELY FORBIDDEN)
- BAD: \`"≈25x |"\` (contains table pipe — ABSOLUTELY FORBIDDEN even if just one char)
- BAD: \`suffix="x multiple at the previous"\` (prose in suffix)
- GOOD: \`"≈39x"\` (just the match — preferred)
- GOOD: \`"≈25x"\` (just the match even if there are multiple occurrences — first one gets replaced)
- GOOD: \`"≈25x (current)"\` (match + ≤20 chars disambiguation when needed)
- GOOD: \`"39x multiple"\` (exact match for the detected pattern)

## <Calc> props guide

- \`expr\`: math expression with \`{entity.factId}\` references
- \`precision\`: decimal places (0 for whole numbers like "27x", 1 for "27.1x")
- \`suffix\`: appended to result (e.g. \`suffix="x"\` for multiples, \`suffix=" percentage points"\`)
- \`prefix\`: prepended to result (e.g. \`prefix="≈"\` for approximate values)
- \`format\`: "currency" for dollar amounts, "percent" for 0-1 fractions as %, "number" for plain numbers, omit for auto

## Common derivations

| Pattern | Operation | Example |
|---------|-----------|---------|
| "≈27x revenue" | valuation / revenue | \`{entity.valuation} / {entity.revenue}\` |
| "300% growth" | (new/old - 1) * 100 | \`({entity.revenue-new} / {entity.revenue-old} - 1) * 100\` |
| "+12 pp" | rate difference | \`{entity.rate-a} - {entity.rate-b}\` |
| "raised $Xm more" | dollar difference | \`{entity.funding-a} - {entity.funding-b}\` |

## Handling named-multiple patterns (e.g. "39x multiple", "27x revenue")

For patterns like "≈39x multiple" or "27x revenue", replace ONLY the number portion — do not include the trailing word in \`originalText\` or \`suffix\`:
- The detected match "39x multiple" appears in text like "≈39x multiple at the previous..."
- Set \`originalText = "≈39x"\` (just the approximation symbol + number)
- Set \`suffix = "x"\`, NOT \`suffix = "x multiple"\`
- This keeps the trailing word "multiple" in the surrounding prose unchanged

## Rules

- ONLY propose a replacement if you are confident in the fact references AND the math
- The computed result should be within 15% of the hardcoded number
- If the pattern is NOT derivable from available facts, return null for that proposal
- Return valid JSON only`;

async function proposeCalcReplacements(
  pageId: string,
  patterns: DetectedPattern[],
  factsTable: string,
  pageContent: string,
): Promise<CalcProposal[]> {
  const client = createClient({ required: false });
  if (!client) {
    console.warn('[calc-derive] ANTHROPIC_API_KEY not found — skipping LLM proposals');
    return [];
  }

  const patternList = patterns
    .map((p, i) => `${i + 1}. Match: "${p.match}" (line ${p.line}, ${p.patternType})\n   Context: "...${p.context.slice(0, 400)}..."`)
    .join('\n\n');

  const prompt = `Page ID: ${pageId}

## Available Canonical Facts
${factsTable || '(No numeric facts available for relevant entities)'}

## Detected Hardcoded Patterns
${patternList}

## Instructions
For each pattern above, determine if it can be computed from the available facts.
Return a JSON object with a "proposals" array. Each proposal must have:
- "originalText": the exact text to replace (must match the "Match" string or a slightly wider phrase)
- "expr": the calc expression using {entity.factId} references
- "precision": integer (0 for whole numbers)
- "suffix": string or null
- "prefix": string or null
- "format": "currency" | "percent" | "number" | null
- "confidence": "high" | "medium" | "low"
- "explanation": brief explanation of which facts are used

If a pattern is NOT derivable from available facts, still include it with "expr": null.

Return exactly ${patterns.length} proposals (one per pattern, in order).`;

  const result = await callClaude(client, {
    model: MODELS.sonnet,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: prompt,
    maxTokens: 4000,
    temperature: 0,
  });

  const parsed = parseJsonFromLlm<LlmProposalResponse>(
    result.text,
    'calc-derive',
    () => ({ proposals: [] }),
  );

  const rawProposals = parsed?.proposals || [];

  return rawProposals
    .filter((p): p is CalcProposal & { expr: string } =>
      typeof p.originalText === 'string' &&
      typeof p.expr === 'string' &&
      typeof p.confidence === 'string'
    )
    .map(p => ({
      originalText: p.originalText,
      expr: p.expr,
      precision: typeof p.precision === 'number' ? p.precision : undefined,
      suffix: p.suffix || undefined,
      prefix: p.prefix || undefined,
      format: p.format || undefined,
      confidence: p.confidence as CalcProposal['confidence'],
      explanation: p.explanation || '',
    }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Check that originalText doesn't contain JSX tags, isn't too wide, and suffix is a unit */
export function validateOriginalText(proposal: CalcProposal, matchedPattern: DetectedPattern): string | null {
  // Reject if originalText contains JSX/MDX tags
  if (/<[A-Z]|<\/|<F |<Calc |<Entity/i.test(proposal.originalText)) {
    return 'originalText contains JSX/MDX tags — must be plain text only';
  }
  // Reject if originalText is much wider than the detected pattern match.
  // Allow up to 20 extra characters for disambiguation parentheticals like "(current)".
  const excess = proposal.originalText.length - matchedPattern.match.length;
  if (excess > 20) {
    return `originalText is ${excess} chars wider than the pattern match "${matchedPattern.match}" — keep it narrow`;
  }
  // Reject if originalText contains a table pipe (would corrupt markdown table)
  if (/\|/.test(proposal.originalText)) {
    return 'originalText contains a table pipe character — would corrupt markdown table';
  }
  // Reject if suffix contains spaces followed by a word of 4+ chars (prose leaked in)
  if (proposal.suffix && /\s\w{4,}/.test(proposal.suffix)) {
    return `suffix "${proposal.suffix}" contains prose — must be a unit symbol only (e.g. "x", "%", " pp")`;
  }
  return null;
}

/**
 * Validate a proposed <Calc> expression against current facts.
 * Checks that the result is within 20% of the expected hardcoded value.
 * Auto-fallbacks: if originalText fails due to table pipe or excess width,
 * retry with just the pattern match string.
 */
function validateProposal(
  proposal: CalcProposal,
  pattern: DetectedPattern,
  factsMap: Map<string, FactFile>,
): CalcProposal {
  // Structural validation — with auto-fallback to match string for recoverable errors
  let structuralError = validateOriginalText(proposal, pattern);
  if (structuralError) {
    // If the issue is a table pipe or too-wide text, try falling back to the bare match string
    const isRecoverable = /table pipe|chars wider/.test(structuralError);
    if (isRecoverable && proposal.originalText !== pattern.match) {
      proposal.originalText = pattern.match;
      structuralError = validateOriginalText(proposal, pattern);
      if (!structuralError) {
        console.log(
          `      [auto-fix] originalText narrowed to match string: "${pattern.match}"`,
        );
      }
    }
  }
  if (structuralError) {
    proposal.valid = false;
    proposal.validationError = structuralError;
    return proposal;
  }

  const lookup = buildFactLookup(factsMap);

  try {
    const computedValue = evalCalcExpr(proposal.expr, lookup);
    proposal.computedValue = computedValue;

    // If we have an expected value, check within 20% tolerance
    if (pattern.approximateValue !== undefined && pattern.approximateValue !== 0) {
      const expected = pattern.approximateValue;
      const ratio = Math.abs(computedValue - expected) / Math.abs(expected);

      if (ratio > 0.20) {
        proposal.valid = false;
        proposal.validationError =
          `Result ${computedValue.toFixed(2)} differs >20% from expected ≈${expected}`;
      } else {
        proposal.valid = true;
      }
    } else {
      // No expected value to compare against — just ensure it evaluates
      proposal.valid = true;
    }
  } catch (err) {
    proposal.valid = false;
    proposal.validationError = err instanceof Error ? err.message : String(err);
  }

  return proposal;
}

// ---------------------------------------------------------------------------
// MDX transformation
// ---------------------------------------------------------------------------

/**
 * Check if the file already imports Calc from @components/facts.
 * Returns the updated content with the import added if needed.
 */
export function ensureCalcImport(content: string): string {
  // Match: import { ..., Calc, ... } from '@components/facts'
  // or: import { Calc } from '@components/facts'
  if (/import\s+\{[^}]*\bCalc\b[^}]*\}\s+from\s+['"]@components\/facts['"]/m.test(content)) {
    return content; // Already imported
  }

  // Check if there's already an import from @components/facts (without Calc)
  const factsImportMatch = content.match(/^(import\s+\{)([^}]+)(\}\s+from\s+['"]@components\/facts['"])/m);
  if (factsImportMatch) {
    // Add Calc to the existing import
    const [full, open, names, close] = factsImportMatch;
    const updatedImport = `${open}${names.trim()}, Calc${close}`;
    return content.replace(full, updatedImport);
  }

  // Check if there's already an import from @components/wiki
  const wikiImportMatch = content.match(/^(import\s+\{[^}]*\}\s+from\s+['"]@components\/wiki['"])/m);
  if (wikiImportMatch) {
    // Add a new import line after the wiki import
    return content.replace(wikiImportMatch[0], `${wikiImportMatch[0]}\nimport {Calc} from '@components/facts';`);
  }

  // Add as first import in the file (after frontmatter)
  // Find end of frontmatter
  const frontmatterEnd = content.indexOf('---', 3);
  if (frontmatterEnd !== -1) {
    const insertPos = frontmatterEnd + 3;
    const before = content.slice(0, insertPos);
    const after = content.slice(insertPos);
    return `${before}\nimport {Calc} from '@components/facts';\n${after}`;
  }

  // Prepend to content
  return `import {Calc} from '@components/facts';\n\n${content}`;
}

/** Build the <Calc> component string from a proposal */
export function buildCalcComponent(proposal: CalcProposal): string {
  const props: string[] = [`expr="${proposal.expr}"`];
  if (proposal.precision !== undefined) props.push(`precision={${proposal.precision}}`);
  if (proposal.format) props.push(`format="${proposal.format}"`);
  if (proposal.prefix) props.push(`prefix="${proposal.prefix}"`);
  if (proposal.suffix) props.push(`suffix="${proposal.suffix}"`);
  return `<Calc ${props.join(' ')} />`;
}

/**
 * Apply validated proposals to the page content.
 * Returns the modified content.
 */
function applyProposals(
  content: string,
  proposals: CalcProposal[],
): { content: string; applied: number; skipped: number } {
  let modified = content;
  let applied = 0;
  let skipped = 0;

  for (const proposal of proposals) {
    if (!proposal.valid) {
      skipped++;
      continue;
    }

    if (!modified.includes(proposal.originalText)) {
      skipped++;
      continue;
    }

    const replacement = buildCalcComponent(proposal);
    // Replace first occurrence only (to be safe)
    modified = modified.replace(proposal.originalText, replacement);
    applied++;
  }

  if (applied > 0) {
    modified = ensureCalcImport(modified);
  }

  return { content: modified, applied, skipped };
}

// ---------------------------------------------------------------------------
// Page file finder
// ---------------------------------------------------------------------------

function findPageFile(pageId: string): string | null {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  for (const f of files) {
    if (basename(f, '.mdx') === pageId) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Single page processor
// ---------------------------------------------------------------------------

async function processPage(
  pageId: string,
  factsMap: Map<string, FactFile>,
  apply: boolean,
  colors: ReturnType<typeof getColors>,
): Promise<{ proposed: number; applied: number }> {
  const pageFile = findPageFile(pageId);
  if (!pageFile) {
    console.error(`${colors.red}✗${colors.reset} Page not found: ${pageId}`);
    return { proposed: 0, applied: 0 };
  }

  const raw = readFileSync(pageFile, 'utf-8');
  const body = stripFrontmatter(raw);

  console.log(`\n${colors.cyan}📄 ${pageId}${colors.reset}`);

  // Detect patterns
  const patterns = detectPatterns(body);

  if (patterns.length === 0) {
    console.log(`  ${colors.dim}No hardcoded derived patterns detected.${colors.reset}`);
    return { proposed: 0, applied: 0 };
  }

  console.log(`  Found ${patterns.length} hardcoded pattern(s):`);
  for (const p of patterns) {
    console.log(`    Line ${p.line}: "${p.match}" (${p.patternType})`);
  }

  // Find relevant entities
  const relevantEntities = findRelevantEntities(body, factsMap);
  const factsTable = formatFactsForPrompt(factsMap, relevantEntities);

  if (relevantEntities.size === 0 || !factsTable) {
    console.log(`  ${colors.dim}No relevant facts found for entities in this page.${colors.reset}`);
    return { proposed: 0, applied: 0 };
  }

  console.log(`  Relevant entities: ${[...relevantEntities].join(', ')}`);
  console.log(`\n  Calling LLM to generate <Calc> proposals...`);

  // Get LLM proposals
  let proposals: CalcProposal[];
  try {
    proposals = await proposeCalcReplacements(pageId, patterns, factsTable, body);
  } catch (err) {
    console.error(
      `  ${colors.red}✗ LLM error: ${err instanceof Error ? err.message : String(err)}${colors.reset}`,
    );
    return { proposed: 0, applied: 0 };
  }

  if (proposals.length === 0) {
    console.log(`  ${colors.dim}LLM found no derivable patterns.${colors.reset}`);
    return { proposed: 0, applied: 0 };
  }

  // Validate proposals — match each proposal to its source pattern by originalText,
  // not by index (LLM may omit null proposals, causing index drift).
  const validatedProposals: CalcProposal[] = [];
  for (const proposal of proposals) {
    // Find the pattern whose match string is contained in the proposal's originalText
    const matchedPattern = patterns.find(p =>
      proposal.originalText.includes(p.match) || p.match.includes(proposal.originalText)
    ) ?? patterns[0];
    const validated = validateProposal(proposal, matchedPattern, factsMap);
    validatedProposals.push(validated);
  }

  // Display proposals
  console.log(`\n  ${colors.bold}Proposals:${colors.reset}\n`);
  for (const p of validatedProposals) {
    const statusIcon = p.valid ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    const confColor = p.confidence === 'high' ? colors.green : p.confidence === 'medium' ? colors.yellow : colors.red;

    console.log(`  [${statusIcon}] Replace: "${p.originalText}"`);
    console.log(`      Expr: ${p.expr}`);

    const props: string[] = [];
    if (p.precision !== undefined) props.push(`precision={${p.precision}}`);
    if (p.suffix) props.push(`suffix="${p.suffix}"`);
    if (p.prefix) props.push(`prefix="${p.prefix}"`);
    if (p.format) props.push(`format="${p.format}"`);
    if (props.length) console.log(`      Props: ${props.join(', ')}`);

    if (p.computedValue !== undefined) {
      console.log(`      Result: ${p.computedValue.toFixed(2)}`);
    }
    if (!p.valid && p.validationError) {
      console.log(`      ${colors.red}Validation failed: ${p.validationError}${colors.reset}`);
    }
    console.log(`      [${confColor}${p.confidence}${colors.reset}] ${p.explanation}`);
    console.log();
  }

  const validCount = validatedProposals.filter(p => p.valid).length;
  console.log(`  Validated: ${validCount}/${validatedProposals.length} proposals`);

  if (apply && validCount > 0) {
    const { content: modified, applied, skipped } = applyProposals(raw, validatedProposals);
    writeFileSync(pageFile, modified, 'utf-8');
    console.log(`  ${colors.green}✓ Applied ${applied} replacement(s) to ${pageId}.mdx${colors.reset}`);
    if (skipped > 0) {
      console.log(`  ${colors.dim}Skipped ${skipped} proposals (validation failed or text not found)${colors.reset}`);
    }
    return { proposed: validatedProposals.length, applied };
  }

  if (!apply && validCount > 0) {
    console.log(`  ${colors.dim}(Dry run — use --apply to write changes)${colors.reset}\n`);
  }

  return { proposed: validatedProposals.length, applied: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const all = args.all === true;
  const limit = parseInt((args.limit as string) || '10', 10);

  const colors = getColors();

  console.log(`${colors.bold}🧮 Calc Derivation Pipeline (Pass 3)${colors.reset}`);
  console.log(
    `Mode: ${apply ? `${colors.yellow}APPLY${colors.reset} (will write to MDX files)` : `${colors.green}DRY RUN${colors.reset} (no files written)`}\n`,
  );

  // Load all facts
  const factsMap = loadAllFacts(PROJECT_ROOT);
  console.log(`Loaded facts for ${factsMap.size} entities\n`);

  if (all) {
    const files = findMdxFiles(CONTENT_DIR_ABS);
    const pageIds = files
      .filter(f => !basename(f).startsWith('index.') && f.includes('/knowledge-base/'))
      .map(f => basename(f, '.mdx'))
      .slice(0, limit);

    console.log(`Scanning ${pageIds.length} knowledge-base pages (limit: ${limit})...\n`);

    let totalProposed = 0;
    let totalApplied = 0;

    for (const pageId of pageIds) {
      const { proposed, applied } = await processPage(pageId, factsMap, apply, colors);
      totalProposed += proposed;
      totalApplied += applied;
    }

    console.log(`\n${colors.bold}📊 SUMMARY${colors.reset}`);
    console.log('='.repeat(50));
    console.log(`Pages scanned:        ${pageIds.length}`);
    console.log(`Total proposals:      ${totalProposed}`);
    if (apply) {
      console.log(`Total applied:        ${totalApplied}`);
    }
  } else {
    const pageId = args._positional[0] as string | undefined;
    if (!pageId) {
      console.error('Usage: crux facts calc <page-id> [--apply]');
      console.error('       crux facts calc --all [--apply] [--limit=N]');
      process.exit(1);
    }

    await processPage(pageId, factsMap, apply, colors);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
