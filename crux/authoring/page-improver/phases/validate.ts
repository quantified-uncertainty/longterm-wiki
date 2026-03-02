/**
 * Validate Phase
 *
 * Runs validation rules in-process and applies auto-fixes.
 * Much faster than the previous subprocess-per-rule approach.
 *
 * SIGKILL-safe: improved content is never written to the real MDX file.
 * Instead, the ValidationEngine is loaded normally from disk, then the
 * in-memory content entry for the target file is replaced with the improved
 * version. Validation and fixes run entirely against this in-memory copy.
 */

import { compile } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import remarkMath from 'remark-math';
import { ValidationEngine, ContentFile } from '../../../lib/validation/validation-engine.ts';
import { allRules } from '../../../lib/rules/index.ts';
import type { PageData, ValidationResult, PipelineOptions } from '../types.ts';
import { CRITICAL_RULES, QUALITY_RULES, log, getFilePath, writeTemp } from '../utils.ts';

export async function validatePhase(page: PageData, improvedContent: string, _options: PipelineOptions): Promise<ValidationResult> {
  log('validate', 'Running validation checks (in-process)...');

  const filePath = getFilePath(page.path);
  let fixedContent = improvedContent;

  const issues: { critical: Array<{ rule: string; count?: number; output?: string; error?: string }>; quality: Array<{ rule: string; count?: number; output?: string; error?: string }> } = {
    critical: [],
    quality: []
  };

  try {
    // Build ValidationEngine, load all content from disk, then override the
    // target file's entry with the improved content. This means validators see
    // the improved version while the real MDX file on disk is never touched.
    // If the process is SIGKILLed, the real file remains at its original state.
    const engine = new ValidationEngine();
    await engine.load();

    // Inject improved content under the real file path so relativePath,
    // pathRegistry lookups, and cross-file rules all work correctly.
    engine.content.set(filePath, new ContentFile(filePath, improvedContent));

    // Register rules
    const allRuleIds = [...CRITICAL_RULES, ...QUALITY_RULES];
    const ruleMap = new Map(allRules.map(r => [r.id, r]));
    for (const id of allRuleIds) {
      const rule = ruleMap.get(id);
      if (rule) engine.addRule(rule);
    }

    // Run validation rules against the improved content
    const allIssues = await engine.validate({ files: [filePath] });

    const criticalSet = new Set(CRITICAL_RULES);
    const qualitySet = new Set(QUALITY_RULES);

    for (const issue of allIssues) {
      if (criticalSet.has(issue.rule) && issue.severity === 'error') {
        const existing = issues.critical.find(i => i.rule === issue.rule);
        if (existing) {
          existing.count = (existing.count ?? 0) + 1;
          existing.output = (existing.output ? existing.output + '\n' : '') + issue.toString();
        } else {
          issues.critical.push({ rule: issue.rule, count: 1, output: issue.toString() });
        }
      } else if (qualitySet.has(issue.rule)) {
        const existing = issues.quality.find(i => i.rule === issue.rule);
        if (existing) {
          existing.count = (existing.count ?? 0) + 1;
          existing.output = (existing.output ? existing.output + '\n' : '') + issue.toString();
        } else {
          issues.quality.push({ rule: issue.rule, count: 1, output: issue.toString() });
        }
      }
    }

    // Log results
    for (const { rule, count } of issues.critical) {
      log('validate', `  x ${rule}: ${count} error(s)`);
    }
    for (const ruleId of CRITICAL_RULES) {
      if (!issues.critical.some(r => r.rule === ruleId)) {
        log('validate', `  ok ${ruleId}`);
      }
    }
    for (const { rule, count } of issues.quality) {
      log('validate', `  warn ${rule}: ${count} warning(s)`);
    }

    // Apply auto-fixes to the content string (no disk writes).
    // applyFixesToContentString filters to fixable issues internally.
    const fixableCount = allIssues.filter(i => i.isFixable).length;
    if (fixableCount > 0) {
      log('validate', `  Applying ${fixableCount} auto-fix(es) in-process...`);
      fixedContent = engine.applyFixesToContentString(fixedContent, allIssues);
      log('validate', '  ok auto-fixes applied');
    }

    // Check MDX compilation in-process (no subprocess, no disk writes)
    log('validate', 'Checking MDX compilation...');
    try {
      await compile(fixedContent, {
        development: false,
        remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkMath],
        recmaPlugins: [],
      });
      log('validate', '  ok MDX compiles');
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      issues.critical.push({ rule: 'compile', error: `MDX compilation failed: ${error.message?.slice(0, 200)}` });
      log('validate', `  x MDX compilation failed: ${error.message?.slice(0, 100)}`);
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    issues.critical.push({ rule: 'validate-phase', error: `Validation phase error: ${error.message?.slice(0, 200)}` });
    log('validate', `  x Validation phase error: ${error.message?.slice(0, 100)}`);
  }

  // Check for NEEDS CITATION markers — these indicate incomplete content
  const needsCitationMatches = fixedContent.match(/\{\/\*\s*NEEDS CITATION\s*\*\/\}/g) ?? [];
  const needsCitationCount = needsCitationMatches.length;
  if (needsCitationCount > 0) {
    log('validate', `  warn needs-citation: ${needsCitationCount} marker(s) left in output`);
    issues.quality.push({
      rule: 'needs-citation',
      count: needsCitationCount,
      output: `${needsCitationCount} {/* NEEDS CITATION */} marker(s) remain — page looks unfinished. Add sources from research or remove the claims.`,
    });
    if (needsCitationCount > 3) {
      log('validate', `  x needs-citation: ${needsCitationCount} markers exceeds limit of 3 — treat as critical`);
      issues.critical.push({
        rule: 'needs-citation-excess',
        count: needsCitationCount,
        output: `${needsCitationCount} {/* NEEDS CITATION */} markers — too many unfinished claims. Max 3 allowed per page.`,
      });
    }
  }

  writeTemp(page.id, 'validation-results.json', issues);

  const hasCritical: boolean = issues.critical.length > 0;
  log('validate', `Complete (critical: ${issues.critical.length}, quality: ${issues.quality.length})`);

  return { issues, hasCritical, improvedContent: fixedContent };
}
