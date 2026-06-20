#!/usr/bin/env node

/**
 * QA Sweep — Deterministic checks for adversarial quality assurance
 *
 * Three tiers of checks, from fastest to most thorough:
 *
 * 1. **Basic** (<5s) — duplicate IDs, broken refs, markers, wrong domains
 * 2. **Data integrity** (<15s) — entity cross-refs, financial staleness,
 *    quality discrepancies, people role mismatches, broken internal links,
 *    temporal invariants, content staleness, YAML field consistency
 * 3. **Slow** (<3min) — content gate, test suite, orphan entity detection (PG)
 *
 * The `/qa-sweep` Claude Code skill calls this for the deterministic layer,
 * then adds LLM-driven agents on top (production site audit, code review).
 *
 * Usage:
 *   crux qa-sweep              Full sweep report (all tiers)
 *   crux qa-sweep recent       Show recent changes only
 *   crux qa-sweep checks       Basic checks only (fast)
 *   crux qa-sweep deep         Basic + data integrity (no tests/gate)
 *   crux qa-sweep diff         Compare latest two saved results
 *   crux qa-sweep --save       Save results after the sweep
 *   crux qa-sweep --compare    Run sweep + save + show diff vs previous
 *   crux qa-sweep --json       JSON output for scripting
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import {
  saveResult,
  loadLatest,
  diffResults,
  formatDiff,
  listResultFiles,
  loadResult,
  type CheckResult,
  type RecentChange,
  type SweepReport,
} from './sweep-persistence.ts';

// Validator imports
import { runCheck as checkData } from '../validate/validate-data.ts';
import { runCheck as checkFinancials } from '../validate/validate-financials.ts';
import { runCheck as checkQuality } from '../validate/validate-quality.ts';
import { runCheck as checkStaleness } from '../validate/check-staleness.ts';
import { crossCheckPeopleRoles } from '../validate/cross-check-people.ts';
import { runTemporalValidation } from '../validate/validate-temporal.ts';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const SAVE_MODE = args.includes('--save') || args.includes('--compare');
const COMPARE_MODE = args.includes('--compare');
const SUB_COMMAND = args.find((a) => !a.startsWith('--')) ?? 'full';

const c = getColors();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      timeout: opts?.timeout ?? 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function silenced<T>(fn: () => T): T {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { return fn(); } finally { console.log = origLog; console.warn = origWarn; }
}

// CheckResult, RecentChange, and SweepReport are imported from ./sweep-persistence.ts

function wrapValidator(name: string, result: { passed: boolean; errors: number; warnings: number; infos?: number }, tier: CheckResult['tier']): CheckResult {
  const parts: string[] = [];
  if (result.errors > 0) parts.push(`${result.errors} errors`);
  if (result.warnings > 0) parts.push(`${result.warnings} warnings`);
  if (result.infos && result.infos > 0) parts.push(`${result.infos} info`);
  if (result.errors === 0 && result.warnings === 0) return { name, status: 'pass', message: parts.length > 0 ? parts.join(', ') : 'Clean', tier };
  if (result.errors > 0) return { name, status: 'fail', message: parts.join(', '), tier };
  return { name, status: 'warn', message: parts.join(', '), tier };
}

function safeCheck(name: string, tier: CheckResult['tier'], fn: () => CheckResult): CheckResult {
  try { return fn(); } catch (e) { return { name, status: 'skip', message: `Error: ${e instanceof Error ? e.message : String(e)}`, tier }; }
}

// ─── Recent changes ──────────────────────────────────────────────────────────

function getRecentChanges(): RecentChange[] {
  const changes: RecentChange[] = [];
  const prOutput = run(`gh pr list --state merged --limit 15 --json number,title,mergedAt --jq '.[] | "\\(.number)\\t\\(.mergedAt[:10])\\t\\(.title)"'`);
  if (prOutput) {
    for (const line of prOutput.split('\n')) {
      const [num, date, ...titleParts] = line.split('\t');
      if (num && date) changes.push({ type: 'pr', id: `#${num}`, title: titleParts.join('\t'), date });
    }
  }
  return changes;
}

function getChangedFiles(): string[] {
  const output = run(`git log --since="3 days ago" --name-only --pretty=format: -- '*.ts' '*.tsx' '*.yaml' '*.mdx' | sort -u`);
  return output ? output.split('\n').filter(Boolean) : [];
}

// ─── Tier 1: Basic checks (<5s) ─────────────────────────────────────────────

function checkDuplicateWikiIds(): CheckResult {
  const entitiesDir = join(PROJECT_ROOT, 'data/entities');
  const contentDir = join(PROJECT_ROOT, 'content/docs');
  const yamlIds = new Map<string, number>();
  const mdxIds = new Map<string, number>();

  try {
    let grepOut = '';
    try {
      grepOut = execFileSync('grep', ['-rh', 'wikiId:', entitiesDir], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { /* grep exits non-zero when no matches */ }
    for (const line of grepOut.split('\n')) {
      const m = line.match(/wikiId:\s*"?(E\d+)"?/);
      if (m) yamlIds.set(m[1], (yamlIds.get(m[1]) ?? 0) + 1);
    }
  } catch { /* empty */ }

  try {
    let findOut = '';
    try {
      findOut = execFileSync('find', [contentDir, '-type', 'f', '(', '-name', '*.mdx', '-o', '-name', '*.md', ')'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { /* find may exit non-zero */ }
    for (const fp of findOut.split('\n').filter(Boolean)) {
      try {
        const fm = readFileSync(fp, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
        if (!fm) continue;
        for (const line of fm[1].split('\n')) {
          const m = line.match(/^wikiId:\s*"?(E\d+)"?/);
          if (m) mdxIds.set(m[1], (mdxIds.get(m[1]) ?? 0) + 1);
        }
      } catch { /* skip */ }
    }
  } catch { /* empty */ }

  const dupes: string[] = [];
  for (const [id, n] of yamlIds) if (n > 1) dupes.push(`${id}: ${n}x in YAML`);
  for (const [id, n] of mdxIds) if (n > 1) dupes.push(`${id}: ${n}x in MDX`);
  const total = new Set([...yamlIds.keys(), ...mdxIds.keys()]).size;

  return dupes.length === 0
    ? { name: 'Duplicate wikiIds', status: 'pass', message: `${total} unique, no duplicates`, tier: 'basic' }
    : { name: 'Duplicate wikiIds', status: 'fail', message: `${dupes.length} duplicates`, details: dupes, tier: 'basic' };
}

function checkBrokenEntityRefs(): CheckResult {
  const DELETED = ['E8', 'E252'];
  const issues: string[] = [];
  for (const eid of DELETED) {
    const refs = run(`grep -rn 'id="${eid}"' content/docs/ apps/web/src/ 2>/dev/null || true`);
    if (refs) for (const line of refs.split('\n').filter(Boolean)) issues.push(`Ref to ${eid}: ${line.split(':').slice(0, 2).join(':')}`);
  }
  return issues.length === 0
    ? { name: 'Broken entity refs', status: 'pass', message: `No refs to ${DELETED.join(', ')}`, tier: 'basic' }
    : { name: 'Broken entity refs', status: 'fail', message: `${issues.length} broken refs`, details: issues, tier: 'basic' };
}

function checkNeedsCitation(): CheckResult {
  const output = run(`grep -rn 'NEEDS CITATION' content/docs/ --include='*.mdx' 2>/dev/null || true`);
  const lines = output ? output.split('\n').filter(Boolean) : [];
  if (lines.length === 0) return { name: 'NEEDS CITATION', status: 'pass', message: 'None', tier: 'basic' };
  const fileMap = new Map<string, number>();
  for (const l of lines) { const f = l.split(':')[0].replace(PROJECT_ROOT + '/', ''); fileMap.set(f, (fileMap.get(f) ?? 0) + 1); }
  return { name: 'NEEDS CITATION', status: 'warn', message: `${lines.length} in ${fileMap.size} files`, details: [...fileMap.entries()].map(([f, n]) => `${f}: ${n}`), tier: 'basic' };
}

function checkTodos(): CheckResult {
  const lines = (run(`grep -rn 'TODO' content/docs/ --include='*.mdx' 2>/dev/null || true`) || '').split('\n').filter(Boolean);
  return lines.length <= 5
    ? { name: 'TODO markers', status: 'pass', message: `${lines.length} (ok)`, tier: 'basic' }
    : { name: 'TODO markers', status: 'warn', message: `${lines.length} TODOs`, details: lines.slice(0, 10).map((l) => l.split(':').slice(0, 2).join(':')), tier: 'basic' };
}

function checkWrongDomainRefs(): CheckResult {
  const issues: string[] = [];
  for (const d of ['longterm.wiki', 'longtermwiki.org']) {
    const refs = run(`grep -rn '${d}' apps/web/src/ content/docs/ 2>/dev/null || true`);
    if (refs) for (const l of refs.split('\n').filter(Boolean)) issues.push(`'${d}': ${l.split(':').slice(0, 2).join(':')}`);
  }
  return issues.length === 0
    ? { name: 'Wrong domain refs', status: 'pass', message: 'None', tier: 'basic' }
    : { name: 'Wrong domain refs', status: 'fail', message: `${issues.length} refs`, details: issues, tier: 'basic' };
}

// ─── Tier 2: Data integrity (<15s) ──────────────────────────────────────────

function checkEntityDataIntegrity(): CheckResult {
  return safeCheck('Entity data integrity', 'data-integrity', () => wrapValidator('Entity data integrity', silenced(() => checkData({ ci: true })), 'data-integrity'));
}

function checkFinancialStaleness(): CheckResult {
  return safeCheck('Financial staleness', 'data-integrity', () => wrapValidator('Financial staleness', silenced(() => checkFinancials({ ci: true })), 'data-integrity'));
}

function checkQualityDiscrepancies(): CheckResult {
  return safeCheck('Quality discrepancies', 'data-integrity', () => wrapValidator('Quality discrepancies', silenced(() => checkQuality({ ci: true })), 'data-integrity'));
}

function checkPeopleRoles(): CheckResult {
  return safeCheck('People role consistency', 'data-integrity', () => {
    const mm = crossCheckPeopleRoles(PROJECT_ROOT);
    const w = mm.filter((m) => m.severity === 'warning').length;
    const i = mm.filter((m) => m.severity === 'info').length;
    if (mm.length === 0) return { name: 'People role consistency', status: 'pass', message: 'YAML ↔ FactBase match', tier: 'data-integrity' };
    const details = mm.filter((m) => m.severity === 'warning').slice(0, 8).map((m) => `${m.personName}: "${m.entityRole ?? 'none'}" vs "${m.currentFactbaseRole ?? 'none'}"`);
    return { name: 'People role consistency', status: w > 0 ? 'warn' : 'pass', message: `${w} mismatches, ${i} stale`, details: details.length > 0 ? details : undefined, tier: 'data-integrity' };
  });
}

function checkTemporal(): CheckResult {
  return safeCheck('Temporal invariants', 'data-integrity', () => {
    const r = silenced(() => runTemporalValidation());
    const e = r.violations.filter((v: { severity: string }) => v.severity === 'error').length;
    const w = r.violations.filter((v: { severity: string }) => v.severity === 'warning').length;
    if (r.passed && e === 0) return { name: 'Temporal invariants', status: 'pass', message: `Clean${w > 0 ? `, ${w} warnings` : ''}`, tier: 'data-integrity' };
    const details = r.violations.filter((v: { severity: string }) => v.severity === 'error').slice(0, 5).map((v: { entityId: string; message: string }) => `${v.entityId}: ${v.message}`);
    return { name: 'Temporal invariants', status: e > 0 ? 'fail' : 'warn', message: `${e} errors, ${w} warnings`, details, tier: 'data-integrity' };
  });
}

function checkStaleContent(): CheckResult {
  return safeCheck('Content staleness', 'data-integrity', () => wrapValidator('Content staleness', silenced(() => checkStaleness({ ci: true })), 'data-integrity'));
}

function checkYamlFields(): CheckResult {
  return safeCheck('YAML field consistency', 'data-integrity', () => {
    const entitiesDir = join(PROJECT_ROOT, 'data/entities');
    const issues: string[] = [];
    for (const file of readdirSync(entitiesDir).filter((f) => f.endsWith('.yaml'))) {
      let entities: unknown;
      try { entities = parseYaml(readFileSync(join(entitiesDir, file), 'utf-8')); } catch { continue; }
      if (!Array.isArray(entities)) continue;

      for (const entity of entities) {
        if (!entity || typeof entity !== 'object') continue;
        const e = entity as Record<string, unknown>;
        const id = (e.id ?? '?') as string;
        const type = (e.type ?? e.entityType ?? '?') as string;

        if (type === 'policy' && !e.policyStatus) issues.push(`${id} (policy): missing policyStatus`);

        if (Array.isArray(e.relatedEntries)) {
          for (const rel of e.relatedEntries as Array<Record<string, unknown>>) {
            if (rel?.type && rel?.id) {
              const target = (entities as Array<Record<string, unknown>>).find((t) => t?.id === rel.id);
              if (target) {
                const actual = target.type ?? target.entityType;
                if (actual && rel.type !== actual) issues.push(`${id}: relatedEntry ${rel.id} typed '${rel.type}' but is '${actual}'`);
              }
            }
          }
        }

        for (const field of ['introduced', 'founded', 'releaseDate', 'trainingCutoff']) {
          const val = e[field] ?? (e.customFields as Record<string, unknown> | undefined)?.[field];
          if (val && typeof val === 'string' && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(val)) issues.push(`${id}: ${field} non-standard: "${val}"`);
        }

        if (e.description && e.title && (e.description as string).trim() === (e.title as string).trim()) issues.push(`${id}: description = title`);
      }
    }

    if (issues.length === 0) return { name: 'YAML field consistency', status: 'pass', message: 'Clean', tier: 'data-integrity' };
    return { name: 'YAML field consistency', status: issues.some((i) => i.includes('relatedEntry')) ? 'fail' : 'warn', message: `${issues.length} issues`, details: issues.slice(0, 10), tier: 'data-integrity' };
  });
}

function checkCrossEntity(): CheckResult {
  return safeCheck('Cross-entity consistency', 'data-integrity', () => {
    const output = run('npx tsx crux/validate/cross-entity-consistency.ts --ci 2>&1 | tail -5', { timeout: 30_000 });
    if (!output) return { name: 'Cross-entity consistency', status: 'skip', message: 'Timeout', tier: 'data-integrity' };
    try {
      const result = JSON.parse(output.split('\n').filter(Boolean).pop() ?? '');
      return wrapValidator('Cross-entity consistency', result, 'data-integrity');
    } catch {
      if (output.includes('No issues')) return { name: 'Cross-entity consistency', status: 'pass', message: 'Clean', tier: 'data-integrity' };
      return { name: 'Cross-entity consistency', status: 'skip', message: 'Parse error', tier: 'data-integrity' };
    }
  });
}

// ─── Tier 3: Slow checks ────────────────────────────────────────────────────

function checkTestStatus(): CheckResult {
  const output = run('pnpm test 2>&1 | tail -15', { timeout: 180_000 });
  if (!output) return { name: 'Test suite', status: 'skip', message: 'Timed out', tier: 'slow' };
  if (output.includes('failed')) {
    return { name: 'Test suite', status: 'fail', message: `${output.match(/(\d+)\s+failed/)?.[1] ?? '?'} failed, ${output.match(/(\d+)\s+passed/)?.[1] ?? '?'} passed`, details: output.split('\n').filter((l) => l.includes('FAIL') || l.includes('failed')).slice(0, 5), tier: 'slow' };
  }
  if (output.includes('passed')) return { name: 'Test suite', status: 'pass', message: `${output.match(/(\d+)\s+passed/)?.[1] ?? 'All'} passed`, tier: 'slow' };
  return { name: 'Test suite', status: 'skip', message: 'Unknown', tier: 'slow' };
}

function checkGateContent(): CheckResult {
  const output = run('pnpm crux validate gate --scope=content --fix 2>&1 | tail -20', { timeout: 60_000 });
  if (output.includes('All') && output.includes('passed')) return { name: 'Content gate', status: 'pass', message: 'All pass', tier: 'slow' };
  if (output.includes('FAIL') || output.includes('failed')) return { name: 'Content gate', status: 'fail', message: 'Failed', details: [output], tier: 'slow' };
  return { name: 'Content gate', status: 'pass', message: 'Completed', tier: 'slow' };
}

function checkOrphanEntities(): CheckResult {
  return safeCheck('Orphan PG entities', 'slow', () => {
    const output = run('WIKI_SERVER_ENV=prod npx tsx crux/validate/validate-orphan-entities.ts --ci 2>&1 | tail -10', { timeout: 45_000 });
    if (!output || output.includes('unavailable') || output.includes('ECONNREFUSED')) return { name: 'Orphan PG entities', status: 'skip', message: 'Server unavailable', tier: 'slow' };
    try {
      const result = JSON.parse(output.split('\n').filter(Boolean).pop() ?? '');
      return wrapValidator('Orphan PG entities', result, 'slow');
    } catch {
      if (output.includes('No orphan')) return { name: 'Orphan PG entities', status: 'pass', message: 'None', tier: 'slow' };
      return { name: 'Orphan PG entities', status: 'skip', message: 'Parse error', tier: 'slow' };
    }
  });
}

// ─── Report ──────────────────────────────────────────────────────────────────

// SweepReport is imported from sweep-persistence.ts (shared type definition).

function printReport(report: SweepReport): void {
  if (JSON_MODE) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`\n${c.bold}QA Sweep Report — ${report.timestamp}${c.reset}\n`);

  if (report.recentChanges.length > 0) {
    console.log(`${c.bold}Recent Changes (last 3 days)${c.reset}`);
    for (const ch of report.recentChanges.slice(0, 10)) console.log(`  ${c.dim}${ch.date}${c.reset}  ${ch.id}  ${ch.title}`);
    if (report.recentChanges.length > 10) console.log(`  ${c.dim}... and ${report.recentChanges.length - 10} more${c.reset}`);
    console.log();
  }

  if (report.changedFiles.length > 0) {
    console.log(`${c.bold}Changed Files${c.reset}: ${report.changedFiles.length} modified`);
    const byDir = new Map<string, number>();
    for (const f of report.changedFiles) { const d = f.split('/').slice(0, 3).join('/'); byDir.set(d, (byDir.get(d) ?? 0) + 1); }
    for (const [d, n] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${d}: ${n} files`);
    console.log();
  }

  const icon = { pass: `${c.green}✓${c.reset}`, fail: `${c.red}✗${c.reset}`, warn: `${c.yellow}⚠${c.reset}`, skip: `${c.dim}○${c.reset}` };
  for (const { label, key } of [{ label: 'Basic Checks', key: 'basic' as const }, { label: 'Data Integrity', key: 'data-integrity' as const }, { label: 'Slow Checks', key: 'slow' as const }]) {
    const tier = report.checks.filter((ch) => ch.tier === key);
    if (tier.length === 0) continue;
    console.log(`${c.bold}${label}${c.reset}`);
    for (const ch of tier) {
      console.log(`  ${icon[ch.status]} ${ch.name}: ${ch.message}`);
      if (ch.details && ch.status !== 'pass') {
        for (const d of ch.details.slice(0, 5)) console.log(`    ${c.dim}${d}${c.reset}`);
        if (ch.details.length > 5) console.log(`    ${c.dim}... and ${ch.details.length - 5} more${c.reset}`);
      }
    }
    console.log();
  }

  const fails = report.checks.filter((ch) => ch.status === 'fail').length;
  const warns = report.checks.filter((ch) => ch.status === 'warn').length;
  const skips = report.checks.filter((ch) => ch.status === 'skip').length;
  const total = report.checks.length;
  if (fails > 0) console.log(`${c.red}${fails} failed${c.reset}${warns > 0 ? `, ${warns} warnings` : ''}${skips > 0 ? `, ${skips} skipped` : ''} (${total} checks)`);
  else if (warns > 0) console.log(`${c.green}All passed${c.reset}, ${c.yellow}${warns} warnings${c.reset}${skips > 0 ? `, ${skips} skipped` : ''} (${total} checks)`);
  else console.log(`${c.green}All ${total} checks passed${c.reset}${skips > 0 ? ` (${skips} skipped)` : ''}`);
  console.log(`\n${c.dim}For LLM-driven analysis, run /qa-sweep in Claude Code${c.reset}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const timestamp = new Date().toISOString().slice(0, 10);

  // ── diff subcommand: compare the two most recently saved results ──────────
  if (SUB_COMMAND === 'diff') {
    const files = listResultFiles();

    if (files.length === 0) {
      console.error(
        `${c.red}No saved sweep results found.${c.reset}\n` +
        `Run a sweep with ${c.bold}--save${c.reset} first:\n` +
        `  pnpm crux qa-sweep --save\n` +
        `  pnpm crux qa-sweep checks --save`,
      );
      process.exit(1);
    }

    if (files.length === 1) {
      console.error(
        `${c.yellow}Only one saved result found — need at least two to diff.${c.reset}\n` +
        `Run another sweep with ${c.bold}--save${c.reset} to get a second result.`,
      );
      process.exit(1);
    }

    const prevResult = loadResult(files[files.length - 2]);
    const currResult = loadResult(files[files.length - 1]);

    if (!prevResult || !currResult) {
      console.error(`${c.red}Could not read saved results.${c.reset}`);
      process.exit(1);
    }

    const diff = diffResults(prevResult, currResult);

    if (JSON_MODE) {
      console.log(JSON.stringify(diff, null, 2));
    } else {
      console.log(formatDiff(diff));
    }

    // Exit with failure if there are regressions
    if (diff.regressions.length > 0) process.exit(1);
    return;
  }

  // ── recent subcommand ─────────────────────────────────────────────────────
  if (SUB_COMMAND === 'recent') {
    printReport({ timestamp, recentChanges: getRecentChanges(), changedFiles: getChangedFiles(), checks: [] });
    return;
  }

  // ── checks / deep / full subcommands ──────────────────────────────────────
  const checks: CheckResult[] = [];
  const runData = SUB_COMMAND === 'deep' || SUB_COMMAND === 'full';
  const runSlow = SUB_COMMAND === 'full';

  if (!JSON_MODE) console.log(`${c.dim}Running${runData ? ' basic + data integrity' : ' basic'}${runSlow ? ' + slow' : ''} checks...${c.reset}`);

  // Tier 1
  checks.push(checkDuplicateWikiIds());
  checks.push(checkBrokenEntityRefs());
  checks.push(checkNeedsCitation());
  checks.push(checkTodos());
  checks.push(checkWrongDomainRefs());

  // Tier 2
  if (runData) {
    checks.push(checkEntityDataIntegrity());
    checks.push(checkFinancialStaleness());
    checks.push(checkQualityDiscrepancies());
    checks.push(checkPeopleRoles());
    checks.push(checkTemporal());
    checks.push(checkStaleContent());
    checks.push(checkYamlFields());
    checks.push(checkCrossEntity());
  }

  // Tier 3
  if (runSlow) {
    checks.push(checkGateContent());
    checks.push(checkTestStatus());
    checks.push(checkOrphanEntities());
  }

  const recentChanges = runData ? getRecentChanges() : [];
  const changedFiles = runData ? getChangedFiles() : [];
  const report: SweepReport = { timestamp, recentChanges, changedFiles, checks };
  printReport(report);

  // ── persistence ──────────────────────────────────────────────────────────
  if (SAVE_MODE) {
    const previousResult = COMPARE_MODE ? loadLatest() : null;

    const savedPath = saveResult(report);
    if (!JSON_MODE) {
      console.log(`\n${c.dim}Results saved: ${savedPath}${c.reset}`);
    }

    if (COMPARE_MODE) {
      if (previousResult) {
        const currentResult = loadLatest();
        if (currentResult) {
          const diff = diffResults(previousResult, currentResult);
          if (JSON_MODE) {
            console.log(JSON.stringify(diff, null, 2));
          } else {
            console.log('\n' + formatDiff(diff));
          }
          const hasFail = checks.some((ch) => ch.status === 'fail') || diff.regressions.length > 0;
          if (hasFail) process.exit(1);
          return;
        }
      } else if (!JSON_MODE) {
        console.log(
          `${c.dim}No previous result to compare against — this is the first saved run.${c.reset}`,
        );
      }
    }
  }

  if (checks.some((ch) => ch.status === 'fail')) process.exit(1);
}

main().catch((err) => { console.error('QA Sweep failed:', err); process.exit(1); });
