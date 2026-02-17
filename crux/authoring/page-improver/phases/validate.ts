/**
 * Validate Phase
 *
 * Runs validation rules in-process and applies auto-fixes.
 * Much faster than the previous subprocess-per-rule approach.
 */

import fs from 'fs';
import { execSync } from 'child_process';
import { validateSingleFile } from '../../../lib/validation-engine.ts';
import { allRules } from '../../../lib/rules/index.ts';
import type { PageData, ValidationResult, PipelineOptions } from '../types.ts';
import { ROOT, NODE_TSX, CRITICAL_RULES, QUALITY_RULES, log, getFilePath, writeTemp } from '../utils.ts';

export async function validatePhase(page: PageData, improvedContent: string, _options: PipelineOptions): Promise<ValidationResult> {
  log('validate', 'Running validation checks (in-process)...');

  const filePath = getFilePath(page.path);
  const originalContent = fs.readFileSync(filePath, 'utf-8');
  let fixedContent = improvedContent;

  // Write improved content to the actual file so validators check the new version
  fs.writeFileSync(filePath, improvedContent);

  const issues: { critical: Array<{ rule: string; count?: number; output?: string; error?: string }>; quality: Array<{ rule: string; count?: number; output?: string; error?: string }> } = {
    critical: [],
    quality: []
  };

  try {
    // Run validation rules in-process (much faster than subprocess per rule)
    const result = await validateSingleFile(
      filePath,
      CRITICAL_RULES,
      QUALITY_RULES,
      allRules,
    );

    for (const { rule, count, issues: ruleIssues } of result.critical) {
      if (count > 0) {
        issues.critical.push({
          rule,
          count,
          output: ruleIssues.map(i => i.toString()).join('\n'),
        });
        log('validate', `  x ${rule}: ${count} error(s)`);
      } else {
        log('validate', `  ok ${rule}`);
      }
    }

    // Log passing critical rules (those with no issues)
    for (const ruleId of CRITICAL_RULES) {
      if (!result.critical.some(r => r.rule === ruleId)) {
        log('validate', `  ok ${ruleId}`);
      }
    }

    for (const { rule, count, issues: ruleIssues } of result.quality) {
      if (count > 0) {
        issues.quality.push({
          rule,
          count,
          output: ruleIssues.map(i => i.toString()).join('\n'),
        });
        log('validate', `  warn ${rule}: ${count} warning(s)`);
      }
    }

    // Apply auto-fixes from the engine if available
    const fixableIssues = [...result.critical.flatMap(r => r.issues), ...result.quality.flatMap(r => r.issues)]
      .filter(i => i.isFixable);
    if (fixableIssues.length > 0) {
      log('validate', `  Applying ${fixableIssues.length} auto-fix(es) in-process...`);
      result.engine.applyFixes(fixableIssues);
      fixedContent = fs.readFileSync(filePath, 'utf-8');
      log('validate', '  ok auto-fixes applied');
    }

    // Also run auto-fix commands for fixes not covered by the engine
    log('validate', 'Running supplemental auto-fixes (escaping, markdown)...');
    try {
      execSync(
        `${NODE_TSX} crux/crux.mjs fix escaping 2>&1`,
        { cwd: ROOT, encoding: 'utf-8', timeout: 60000 }
      );
      execSync(
        `${NODE_TSX} crux/crux.mjs fix markdown 2>&1`,
        { cwd: ROOT, encoding: 'utf-8', timeout: 60000 }
      );
      fixedContent = fs.readFileSync(filePath, 'utf-8');
      log('validate', '  ok supplemental fixes applied');
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('validate', `  warn supplemental auto-fix failed: ${error.message?.slice(0, 100)}`);
    }

    // Check MDX compilation
    log('validate', 'Checking MDX compilation...');
    try {
      execSync(`${NODE_TSX} crux/crux.mjs validate compile --quick`, {
        cwd: ROOT,
        stdio: 'pipe',
        timeout: 60000
      });
      log('validate', '  ok MDX compiles');
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      issues.critical.push({ rule: 'compile', error: `MDX compilation failed: ${error.message?.slice(0, 200)}` });
      log('validate', `  x MDX compilation failed: ${error.message?.slice(0, 100)}`);
    }
  } finally {
    // Restore original content
    fs.writeFileSync(filePath, originalContent);
  }

  writeTemp(page.id, 'validation-results.json', issues);

  const hasCritical: boolean = issues.critical.length > 0;
  log('validate', `Complete (critical: ${issues.critical.length}, quality: ${issues.quality.length})`);

  return { issues, hasCritical, improvedContent: fixedContent };
}
