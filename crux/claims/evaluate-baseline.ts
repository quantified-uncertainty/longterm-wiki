/**
 * Evaluate extracted claims quality baseline.
 *
 * Two modes:
 *   --from-db (default): Read stored claims from the wiki-server database
 *   --from-logs:         Read from dry-run log files in /tmp/claims-baseline/
 *
 * Evaluates a random sample of claims from each page using Claude Sonnet,
 * and produces a summary report.
 *
 * Usage:
 *   pnpm crux claims evaluate-baseline              # from database
 *   pnpm crux claims evaluate-baseline --from-logs   # from dry-run logs
 *   pnpm crux claims evaluate-baseline --sample=20   # 20 claims per page
 *
 * Requires: ANTHROPIC_API_KEY
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { createClient, callClaude, MODELS } from '../lib/anthropic.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { getColors } from '../lib/output.ts';
import { getClaimsByEntity } from '../lib/wiki-server/claims.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { parseCliArgs } from '../lib/cli.ts';

const BASE_LOG_DIR = '/tmp/claims-baseline';
const DEFAULT_SAMPLE_SIZE = 15;

interface ClaimEval {
  claimText: string;
  claimType: string;
  pageId: string;
  pageType: string;
  accurate: string;
  useful: string;
  correctType: string;
  atomic: string;
  wellScoped: string;
  notes: string;
}

interface PageConfig {
  id: string;
  type: string;
}

const PAGES: PageConfig[] = [
  { id: 'kalshi', type: 'commercial-org' },
  { id: 'anthropic', type: 'major-org' },
  { id: 'miri', type: 'research-org' },
  { id: 'redwood-research', type: 'research-org' },
  { id: 'dario-amodei', type: 'person-prominent' },
  { id: 'stuart-russell', type: 'person-academic' },
  { id: 'neel-nanda', type: 'person-researcher' },
  { id: 'paul-christiano', type: 'person-researcher' },
  { id: 'rlhf', type: 'concept' },
  { id: 'interpretability', type: 'concept' },
];

// ---------------------------------------------------------------------------
// Claim sources: database or log files
// ---------------------------------------------------------------------------

interface ClaimInput {
  claimText: string;
  claimType: string;
}

/** Fetch claims for a page from the wiki-server database. */
async function fetchClaimsFromDb(pageId: string): Promise<ClaimInput[]> {
  const result = await getClaimsByEntity(pageId);
  if (!result.ok || !result.data) return [];
  return result.data.claims.map((c) => ({
    claimText: c.claimText,
    claimType: c.claimType,
  }));
}

/** Parse claims from a dry-run extraction log (legacy mode). */
function parseClaimsFromLog(logPath: string): ClaimInput[] {
  const log = readFileSync(logPath, 'utf-8');
  const claims: ClaimInput[] = [];
  const seen = new Set<string>();

  // Strip ANSI escape codes for reliable parsing
  const clean = log.replace(/\x1b\[[0-9;]*m/g, '');

  // Parse multi-entity claims: [type] Text → {entities}
  const multiMatch = clean.match(/Multi-entity claims:[\s\S]*?(?=\nSample claims:|\n\n)/);
  if (multiMatch) {
    for (const line of multiMatch[0].split('\n')) {
      const m = line.trim().match(/^\[(\w+)\]\s+(.+?)(?:\s+→\s+\{.*?\})?$/);
      if (m) {
        const text = m[2].trim();
        if (!seen.has(text)) {
          claims.push({ claimType: m[1], claimText: text });
          seen.add(text);
        }
      }
    }
  }

  // Parse sample claims: [type/category ...] Text [^refs] or (unsourced)
  const sampleMatch = clean.match(/Sample claims:[\s\S]*?(?=\.\.\. and \d+ more|Dry run complete)/);
  if (sampleMatch) {
    for (const line of sampleMatch[0].split('\n')) {
      const m = line.trim().match(/^\[(\w+)\/\w+(?:\s+[^\]]*?)?\]\s+(.+?)(?:\s+\[\^[^\]]*\]|\s+\(unsourced\))?$/);
      if (m) {
        const text = m[2].trim();
        if (!seen.has(text)) {
          claims.push({ claimType: m[1], claimText: text });
          seen.add(text);
        }
      }
    }
  }

  return claims;
}

/** Pick a random sample of N items from an array. */
function randomSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function readPageContent(pageId: string): string {
  const filePath = findPageFile(pageId);
  if (!filePath) return '';
  const raw = readFileSync(filePath, 'utf-8');
  return stripFrontmatter(raw);
}

async function evaluatePage(
  client: ReturnType<typeof createClient>,
  page: PageConfig,
  claims: ClaimInput[],
  pageContent: string,
  sampleSize: number,
): Promise<ClaimEval[]> {
  const sample = randomSample(claims, sampleSize);

  const claimList = sample.map((c, i) =>
    `${i + 1}. [${c.claimType}] "${c.claimText}"`
  ).join('\n');

  const systemPrompt = `You evaluate the quality of claims extracted from wiki pages by an LLM.
For each claim, evaluate 5 dimensions:
- accurate: Does it faithfully represent what the page says? "yes" / "no" / "partial"
- useful: Would a reader find this standalone claim valuable? "yes" / "no" (no = trivially obvious, vague, tautological, or redundant)
- correctType: Is the claimType classification right? "yes" / "no"
- atomic: Is this one assertion? "yes" / "too-broad" / "too-narrow"
- wellScoped: Does the claim avoid adding info not in the source text? "yes" / "no"

Return ONLY a JSON array: [{"claim": 1, "accurate": "yes", "useful": "yes", "correctType": "yes", "atomic": "yes", "wellScoped": "yes", "notes": "brief note"}]`;

  const userPrompt = `PAGE CONTENT (first 12,000 chars):
${pageContent.slice(0, 12000)}

CLAIMS TO EVALUATE:
${claimList}`;

  const response = await callClaude(client, {
    model: MODELS.sonnet,
    systemPrompt,
    userPrompt,
    maxTokens: 4000,
  });

  const jsonMatch = response.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const evals = JSON.parse(jsonMatch[0]) as Array<Record<string, string>>;
    return evals.map((e) => {
      const idx = e.claim ? Number(e.claim) - 1 : -1;
      const src = idx >= 0 && idx < sample.length ? sample[idx] : null;
      return {
        claimText: src?.claimText ?? '',
        claimType: src?.claimType ?? '',
        pageId: page.id,
        pageType: page.type,
        accurate: e.accurate ?? 'unknown',
        useful: e.useful ?? 'unknown',
        correctType: e.correctType ?? 'unknown',
        atomic: e.atomic ?? 'unknown',
        wellScoped: e.wellScoped ?? 'unknown',
        notes: e.notes ?? '',
      };
    }).filter(e => e.claimText !== '');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(0)}%` : 'n/a';
}

function printRow(label: string, evals: ClaimEval[]) {
  const n = evals.length;
  const acc = evals.filter(e => e.accurate === 'yes' || e.accurate === 'partial').length;
  const useful = evals.filter(e => e.useful === 'yes').length;
  const correctType = evals.filter(e => e.correctType === 'yes').length;
  const atom = evals.filter(e => e.atomic === 'yes').length;
  const scope = evals.filter(e => e.wellScoped === 'yes').length;

  console.log(
    `  ${label.padEnd(22)} ${String(n).padStart(3)}  ${pct(acc, n).padStart(5)}  ${pct(useful, n).padStart(5)}  ${pct(correctType, n).padStart(5)}  ${pct(atom, n).padStart(5)}  ${pct(scope, n).padStart(5)}`
  );
}

const SEPARATOR = `  ${'─'.repeat(22)} ${'───'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}`;
const HEADER = `  ${'Type'.padEnd(22)} ${'N'.padStart(3)}  ${'Accur'.padStart(5)}  ${'Usefl'.padStart(5)}  ${'Type'.padStart(5)}  ${'Atom'.padStart(5)}  ${'Scope'.padStart(5)}`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runEvaluation() {
  const c = getColors();
  const args = parseCliArgs(process.argv.slice(2));
  const fromLogs = args['from-logs'] === true;
  const variantArg = typeof args.variant === 'string' ? args.variant : 'baseline';
  const sampleSize = typeof args['sample'] === 'string' ? parseInt(args['sample'], 10) || DEFAULT_SAMPLE_SIZE : DEFAULT_SAMPLE_SIZE;
  const LOG_DIR = variantArg !== 'baseline' ? `${BASE_LOG_DIR}/${variantArg}` : BASE_LOG_DIR;
  const client = createClient();
  const allEvals: ClaimEval[] = [];

  const source = fromLogs ? 'dry-run logs' : 'database';
  const variantLabel = variantArg !== 'baseline' ? ` [variant: ${variantArg}]` : '';
  console.log(`\n${c.bold}${c.blue}Claims Extraction Quality Baseline${c.reset} (source: ${source}, sample: ${sampleSize}/page)${variantLabel}\n`);

  if (!fromLogs) {
    const serverOk = await isServerAvailable();
    if (!serverOk) {
      console.error(`${c.red}Wiki server not available. Use --from-logs to read from dry-run log files.${c.reset}`);
      process.exit(1);
    }
  }

  for (const page of PAGES) {
    let claims: ClaimInput[];

    if (fromLogs) {
      const logPath = join(LOG_DIR, `${page.id}-extract.log`);
      if (!existsSync(logPath)) {
        console.log(`  ${c.yellow}Skipping ${page.id} — no log file at ${logPath}${c.reset}`);
        continue;
      }
      claims = parseClaimsFromLog(logPath);
    } else {
      claims = await fetchClaimsFromDb(page.id);
    }

    if (claims.length === 0) {
      console.log(`  ${c.yellow}Skipping ${page.id} — no claims found${c.reset}`);
      continue;
    }

    const pageContent = readPageContent(page.id);
    if (!pageContent) {
      console.log(`  ${c.yellow}Skipping ${page.id} — page not found${c.reset}`);
      continue;
    }

    process.stdout.write(`  Evaluating ${page.id} (${page.type}, ${claims.length} total, sampling ${Math.min(sampleSize, claims.length)})... `);

    const evals = await evaluatePage(client, page, claims, pageContent, sampleSize);
    console.log(`${c.green}${evals.length} evaluated${c.reset}`);
    allEvals.push(...evals);
  }

  if (allEvals.length === 0) {
    console.log(`\n${c.yellow}No claims evaluated. Ensure claims exist in the database or log files.${c.reset}`);
    return;
  }

  // Write raw results
  const outputDir = variantArg !== 'baseline' ? `${BASE_LOG_DIR}/${variantArg}` : BASE_LOG_DIR;
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'evaluation-results.json'), JSON.stringify(allEvals, null, 2));

  // Summary by page type
  console.log(`\n${c.bold}Summary by Page Type${c.reset}\n`);

  const grouped = new Map<string, ClaimEval[]>();
  for (const e of allEvals) {
    const list = grouped.get(e.pageType) || [];
    list.push(e);
    grouped.set(e.pageType, list);
  }

  const broader = new Map<string, ClaimEval[]>();
  for (const e of allEvals) {
    let cat = 'other';
    if (e.pageType.includes('org')) cat = 'organizations';
    else if (e.pageType.includes('person')) cat = 'people';
    else if (e.pageType === 'concept') cat = 'concepts';
    const list = broader.get(cat) || [];
    list.push(e);
    broader.set(cat, list);
  }

  console.log(HEADER);
  console.log(SEPARATOR);
  for (const [type, evals] of [...grouped.entries()].sort()) {
    printRow(type, evals);
  }
  console.log(SEPARATOR);

  console.log(`\n${c.bold}Summary by Broad Category${c.reset}\n`);
  console.log(HEADER.replace('Type'.padEnd(22), 'Category'.padEnd(22)));
  console.log(SEPARATOR);
  for (const [cat, evals] of [...broader.entries()].sort()) {
    printRow(cat, evals);
  }
  printRow('OVERALL', allEvals);

  // Failure analysis
  console.log(`\n${c.bold}Notable Failures${c.reset}\n`);
  const failures = allEvals.filter(e =>
    e.accurate === 'no' || e.useful === 'no' || e.wellScoped === 'no'
  );

  const failuresByType = new Map<string, number>();
  for (const f of failures) {
    if (f.accurate === 'no') failuresByType.set('inaccurate', (failuresByType.get('inaccurate') || 0) + 1);
    if (f.useful === 'no') failuresByType.set('not useful', (failuresByType.get('not useful') || 0) + 1);
    if (f.wellScoped === 'no') failuresByType.set('hallucinated/overscoped', (failuresByType.get('hallucinated/overscoped') || 0) + 1);
    if (f.atomic === 'too-broad') failuresByType.set('too broad', (failuresByType.get('too broad') || 0) + 1);
    if (f.correctType === 'no') failuresByType.set('wrong type', (failuresByType.get('wrong type') || 0) + 1);
  }

  for (const [type, count] of [...failuresByType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count} claims`);
  }

  console.log(`\n${c.bold}Example Failures (first 15)${c.reset}\n`);
  for (const f of failures.slice(0, 15)) {
    const issues = [];
    if (f.accurate === 'no') issues.push('INACCURATE');
    if (f.useful === 'no') issues.push('NOT USEFUL');
    if (f.wellScoped === 'no') issues.push('OVERSCOPED');
    if (f.atomic === 'too-broad') issues.push('TOO BROAD');
    console.log(`  [${f.pageId}] ${issues.join(', ')}`);
    console.log(`    "${f.claimText.slice(0, 100)}"`);
    if (f.notes) console.log(`    → ${f.notes}`);
    console.log();
  }

  console.log(`\nResults: ${join(outputDir, 'evaluation-results.json')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEvaluation().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
