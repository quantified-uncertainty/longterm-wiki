/**
 * Sprint 2 Experiment Runner
 *
 * Runs all extraction variants across all 10 test pages in dry-run mode,
 * capturing output logs. Then runs evaluation on each variant.
 *
 * Usage:
 *   pnpm crux claims run-experiments                    # Run all variants
 *   pnpm crux claims run-experiments --variant=page-type  # Run one variant
 *   pnpm crux claims run-experiments --evaluate-only    # Skip extraction, just evaluate
 *   pnpm crux claims run-experiments --sample=20        # Evaluation sample size
 *
 * Requires: OPENROUTER_API_KEY, ANTHROPIC_API_KEY
 */

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { VARIANT_NAMES, inferPageType, type VariantName } from './experiment-variants.ts';

const BASE_LOG_DIR = '/tmp/claims-baseline';
const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

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

function getLogDir(variant: string): string {
  return variant === 'baseline' ? BASE_LOG_DIR : join(BASE_LOG_DIR, variant);
}

function runExtraction(page: PageConfig, variant: VariantName, c: ReturnType<typeof getColors>): { claims: number; ok: boolean } {
  const logDir = getLogDir(variant);
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${page.id}-extract.log`);

  const variantFlags = variant === 'baseline'
    ? ''
    : variant === 'page-type'
      ? ` --variant=${variant} --page-type=${inferPageType(page.type)}`
      : ` --variant=${variant}`;

  const cmd = `pnpm crux claims extract ${page.id} --dry-run${variantFlags}`;

  try {
    const output = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 300_000,
      env: { ...process.env },
    });
    writeFileSync(logFile, output);

    // Parse claim count from output (strip ANSI codes first)
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
    const match = clean.match(/Total extracted:\s*(\d+)/);
    const claims = match ? parseInt(match[1], 10) : 0;
    return { claims, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${c.red}FAILED: ${page.id} / ${variant}: ${msg.slice(0, 100)}${c.reset}`);
    writeFileSync(logFile, `ERROR: ${msg}`);
    return { claims: 0, ok: false };
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const evaluateOnly = args['evaluate-only'] === true;
  const sampleSize = typeof args.sample === 'string' ? args.sample : '15';
  const variantFilter = typeof args.variant === 'string' ? args.variant : null;
  const c = getColors(false);

  const variants = variantFilter
    ? [variantFilter as VariantName]
    : [...VARIANT_NAMES];

  console.log(`\n${c.bold}${c.blue}Sprint 2 Experiment Runner${c.reset}\n`);
  console.log(`  Variants: ${variants.join(', ')}`);
  console.log(`  Pages: ${PAGES.length}`);
  console.log(`  Evaluation sample: ${sampleSize}/page`);
  if (evaluateOnly) {
    console.log(`  ${c.yellow}Evaluate only — skipping extraction${c.reset}`);
  }
  console.log('');

  // Phase 1: Run extractions
  if (!evaluateOnly) {
    const results: Array<{ variant: string; page: string; claims: number; ok: boolean }> = [];

    for (const variant of variants) {
      console.log(`${c.bold}=== Variant: ${variant} ===${c.reset}`);

      for (const page of PAGES) {
        process.stdout.write(`  ${page.id.padEnd(20)}`);
        const result = runExtraction(page, variant, c);
        results.push({ variant, page: page.id, claims: result.claims, ok: result.ok });
        console.log(result.ok
          ? `${c.green}${String(result.claims).padStart(4)} claims${c.reset}`
          : `${c.red}FAILED${c.reset}`);
      }

      const totalClaims = results.filter(r => r.variant === variant).reduce((s, r) => s + r.claims, 0);
      console.log(`  ${c.dim}Total: ${totalClaims} claims${c.reset}\n`);
    }

    // Summary table
    console.log(`${c.bold}Extraction Summary${c.reset}\n`);
    const header = `  ${'Page'.padEnd(22)} ${variants.map(v => v.padStart(12)).join(' ')}`;
    console.log(header);
    console.log(`  ${'─'.repeat(22)} ${variants.map(() => '─'.repeat(12)).join(' ')}`);

    for (const page of PAGES) {
      const cols = variants.map(v => {
        const r = results.find(r2 => r2.variant === v && r2.page === page.id);
        return r?.ok ? String(r.claims).padStart(12) : '     FAILED'.padStart(12);
      });
      console.log(`  ${page.id.padEnd(22)} ${cols.join(' ')}`);
    }

    const totals = variants.map(v =>
      String(results.filter(r => r.variant === v).reduce((s, r) => s + r.claims, 0)).padStart(12)
    );
    console.log(`  ${'─'.repeat(22)} ${variants.map(() => '─'.repeat(12)).join(' ')}`);
    console.log(`  ${'TOTAL'.padEnd(22)} ${totals.join(' ')}`);
    console.log('');

    // Save extraction summary
    writeFileSync(
      join(BASE_LOG_DIR, 'extraction-summary.json'),
      JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2),
    );
  }

  // Phase 2: Run evaluations
  console.log(`${c.bold}=== Running Evaluations ===${c.reset}\n`);

  for (const variant of variants) {
    const logDir = getLogDir(variant);
    const hasLogs = PAGES.some(p => existsSync(join(logDir, `${p.id}-extract.log`)));
    if (!hasLogs) {
      console.log(`  ${c.yellow}Skipping ${variant} — no extraction logs found${c.reset}`);
      continue;
    }

    console.log(`  Evaluating variant: ${c.bold}${variant}${c.reset}`);
    const evalCmd = `pnpm crux claims evaluate-baseline --from-logs --sample=${sampleSize} --variant=${variant}`;

    try {
      const output = execSync(evalCmd, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 600_000,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Save raw output
      writeFileSync(join(getLogDir(variant), 'evaluation-output.log'), output);

      // Print the summary portion (from "Summary by" onwards)
      const summaryStart = output.indexOf('Summary by');
      if (summaryStart >= 0) {
        console.log(output.slice(summaryStart));
      } else {
        console.log(output.slice(-500));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${c.red}Evaluation failed for ${variant}: ${msg.slice(0, 150)}${c.reset}`);
    }
  }

  // Phase 3: Cross-variant comparison
  console.log(`\n${c.bold}=== Cross-Variant Comparison ===${c.reset}\n`);

  const allResults: Array<{ variant: string; evals: Array<Record<string, string>> }> = [];

  for (const variant of variants) {
    const resultsFile = join(getLogDir(variant), 'evaluation-results.json');
    if (existsSync(resultsFile)) {
      try {
        const evals = JSON.parse(readFileSync(resultsFile, 'utf-8'));
        allResults.push({ variant, evals });
      } catch {
        // skip
      }
    }
  }

  if (allResults.length > 1) {
    // Compare key metrics
    const compHeader = `  ${'Variant'.padEnd(16)} ${'N'.padStart(4)}  ${'Accur'.padStart(6)}  ${'Usefl'.padStart(6)}  ${'Type'.padStart(6)}  ${'Atom'.padStart(6)}  ${'Scope'.padStart(6)}`;
    console.log(compHeader);
    console.log(`  ${'─'.repeat(16)} ${'────'}  ${'──────'}  ${'──────'}  ${'──────'}  ${'──────'}  ${'──────'}`);

    for (const { variant, evals } of allResults) {
      const n = evals.length;
      const pct = (field: string, pass: string) =>
        n > 0 ? `${((evals.filter(e => e[field] === pass || e[field] === 'partial').length / n) * 100).toFixed(0)}%` : 'n/a';
      console.log(
        `  ${variant.padEnd(16)} ${String(n).padStart(4)}  ${pct('accurate', 'yes').padStart(6)}  ${pct('useful', 'yes').padStart(6)}  ${pct('correctType', 'yes').padStart(6)}  ${pct('atomic', 'yes').padStart(6)}  ${pct('wellScoped', 'yes').padStart(6)}`
      );
    }

    // Concept pages comparison (the key metric)
    console.log(`\n${c.bold}Concept Pages Only:${c.reset}`);
    console.log(compHeader);
    console.log(`  ${'─'.repeat(16)} ${'────'}  ${'──────'}  ${'──────'}  ${'──────'}  ${'──────'}  ${'──────'}`);

    for (const { variant, evals } of allResults) {
      const conceptEvals = evals.filter(e => e.pageType === 'concept');
      const n = conceptEvals.length;
      const pct = (field: string, pass: string) =>
        n > 0 ? `${((conceptEvals.filter(e => e[field] === pass || e[field] === 'partial').length / n) * 100).toFixed(0)}%` : 'n/a';
      console.log(
        `  ${variant.padEnd(16)} ${String(n).padStart(4)}  ${pct('accurate', 'yes').padStart(6)}  ${pct('useful', 'yes').padStart(6)}  ${pct('correctType', 'yes').padStart(6)}  ${pct('atomic', 'yes').padStart(6)}  ${pct('wellScoped', 'yes').padStart(6)}`
      );
    }

    // Person pages comparison
    console.log(`\n${c.bold}Person Pages Only:${c.reset}`);
    console.log(compHeader);
    console.log(`  ${'─'.repeat(16)} ${'────'}  ${'──────'}  ${'──────'}  ${'──────'}  ${'──────'}  ${'──────'}`);

    for (const { variant, evals } of allResults) {
      const personEvals = evals.filter(e => e.pageType?.includes('person'));
      const n = personEvals.length;
      const pct = (field: string, pass: string) =>
        n > 0 ? `${((personEvals.filter(e => e[field] === pass || e[field] === 'partial').length / n) * 100).toFixed(0)}%` : 'n/a';
      console.log(
        `  ${variant.padEnd(16)} ${String(n).padStart(4)}  ${pct('accurate', 'yes').padStart(6)}  ${pct('useful', 'yes').padStart(6)}  ${pct('correctType', 'yes').padStart(6)}  ${pct('atomic', 'yes').padStart(6)}  ${pct('wellScoped', 'yes').padStart(6)}`
      );
    }

    // Save comparison
    writeFileSync(
      join(BASE_LOG_DIR, 'comparison-results.json'),
      JSON.stringify(allResults.map(({ variant, evals }) => ({
        variant,
        overall: {
          n: evals.length,
          accurate: evals.filter(e => e.accurate === 'yes' || e.accurate === 'partial').length,
          useful: evals.filter(e => e.useful === 'yes').length,
          correctType: evals.filter(e => e.correctType === 'yes').length,
          atomic: evals.filter(e => e.atomic === 'yes').length,
          wellScoped: evals.filter(e => e.wellScoped === 'yes').length,
        },
      })), null, 2),
    );
  }

  console.log(`\n${c.green}Done. Results in ${BASE_LOG_DIR}/${c.reset}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
