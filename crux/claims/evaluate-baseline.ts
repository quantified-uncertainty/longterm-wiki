/**
 * Evaluate extracted claims quality baseline.
 *
 * Reads dry-run log files from /tmp/claims-baseline/, evaluates a sample
 * of claims from each page using Claude Sonnet, and produces a summary report.
 *
 * Usage:
 *   pnpm crux claims evaluate-baseline
 *
 * Requires: ANTHROPIC_API_KEY, dry-run logs in /tmp/claims-baseline/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { createClient, callClaude, MODELS } from '../lib/anthropic.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { getColors } from '../lib/output.ts';

const LOG_DIR = '/tmp/claims-baseline';

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

/**
 * Parse claims from a dry-run extraction log.
 * Extracts from both "Multi-entity claims:" and "Sample claims:" sections.
 */
function parseClaimsFromLog(logPath: string): { claimText: string; claimType: string }[] {
  const log = readFileSync(logPath, 'utf-8');
  const claims: { claimText: string; claimType: string }[] = [];
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
      // Match [type/category ...] or [type/category [date] [=val] ...] lines
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

function readPageContent(pageId: string): string {
  const filePath = findPageFile(pageId);
  if (!filePath) return '';
  const raw = readFileSync(filePath, 'utf-8');
  return stripFrontmatter(raw);
}

async function evaluatePage(
  client: ReturnType<typeof createClient>,
  page: PageConfig,
  claims: { claimText: string; claimType: string }[],
  pageContent: string,
): Promise<ClaimEval[]> {
  const sample = claims.slice(0, 15);

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
      // Use the claim number from response for proper alignment (1-based)
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

export async function runEvaluation() {
  const c = getColors();
  const client = createClient();
  const allEvals: ClaimEval[] = [];

  console.log(`\n${c.bold}${c.blue}Claims Extraction Quality Baseline${c.reset}\n`);

  for (const page of PAGES) {
    const logPath = join(LOG_DIR, `${page.id}-extract.log`);
    if (!existsSync(logPath)) {
      console.log(`  ${c.yellow}Skipping ${page.id} — no log file at ${logPath}${c.reset}`);
      continue;
    }

    const claims = parseClaimsFromLog(logPath);
    if (claims.length === 0) {
      console.log(`  ${c.yellow}Skipping ${page.id} — no claims parsed${c.reset}`);
      continue;
    }

    const pageContent = readPageContent(page.id);
    if (!pageContent) {
      console.log(`  ${c.yellow}Skipping ${page.id} — page not found${c.reset}`);
      continue;
    }

    process.stdout.write(`  Evaluating ${page.id} (${page.type}, ${claims.length} claims)... `);

    const evals = await evaluatePage(client, page, claims, pageContent);
    console.log(`${c.green}${evals.length} evaluated${c.reset}`);
    allEvals.push(...evals);
  }

  // Write raw results
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(join(LOG_DIR, 'evaluation-results.json'), JSON.stringify(allEvals, null, 2));

  // ═══════════════════════════════════════════════════
  // Summary by page type
  // ═══════════════════════════════════════════════════
  console.log(`\n${c.bold}Summary by Page Type${c.reset}\n`);

  const grouped = new Map<string, ClaimEval[]>();
  for (const e of allEvals) {
    const key = e.pageType;
    grouped.set(key, [...(grouped.get(key) || []), e]);
  }

  // Also group by broader category
  const broader = new Map<string, ClaimEval[]>();
  for (const e of allEvals) {
    let cat = 'other';
    if (e.pageType.includes('org')) cat = 'organizations';
    else if (e.pageType.includes('person')) cat = 'people';
    else if (e.pageType === 'concept') cat = 'concepts';
    broader.set(cat, [...(broader.get(cat) || []), e]);
  }

  function pct(n: number, d: number): string {
    return d > 0 ? `${((n / d) * 100).toFixed(0)}%` : 'n/a';
  }

  function printRow(label: string, evals: ClaimEval[]) {
    const n = evals.length;
    const acc = evals.filter(e => e.accurate === 'yes' || e.accurate === 'partial').length;
    const useful = evals.filter(e => e.useful === 'yes').length;
    const type = evals.filter(e => e.correctType === 'yes').length;
    const atom = evals.filter(e => e.atomic === 'yes').length;
    const scope = evals.filter(e => e.wellScoped === 'yes').length;

    console.log(
      `  ${label.padEnd(22)} ${String(n).padStart(3)}  ${pct(acc, n).padStart(5)}  ${pct(useful, n).padStart(5)}  ${pct(type, n).padStart(5)}  ${pct(atom, n).padStart(5)}  ${pct(scope, n).padStart(5)}`
    );
  }

  console.log(`  ${'Type'.padEnd(22)} ${'N'.padStart(3)}  ${'Accur'.padStart(5)}  ${'Usefl'.padStart(5)}  ${'Type'.padStart(5)}  ${'Atom'.padStart(5)}  ${'Scope'.padStart(5)}`);
  console.log(`  ${'─'.repeat(22)} ${'───'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}`);

  for (const [type, evals] of [...grouped.entries()].sort()) {
    printRow(type, evals);
  }

  console.log(`  ${'─'.repeat(22)} ${'───'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}`);

  console.log(`\n${c.bold}Summary by Broad Category${c.reset}\n`);
  console.log(`  ${'Category'.padEnd(22)} ${'N'.padStart(3)}  ${'Accur'.padStart(5)}  ${'Usefl'.padStart(5)}  ${'Type'.padStart(5)}  ${'Atom'.padStart(5)}  ${'Scope'.padStart(5)}`);
  console.log(`  ${'─'.repeat(22)} ${'───'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}  ${'─────'}`);
  for (const [cat, evals] of [...broader.entries()].sort()) {
    printRow(cat, evals);
  }
  printRow('OVERALL', allEvals);

  // ═══════════════════════════════════════════════════
  // Failure analysis
  // ═══════════════════════════════════════════════════
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

  console.log(`\nResults: ${join(LOG_DIR, 'evaluation-results.json')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEvaluation().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
