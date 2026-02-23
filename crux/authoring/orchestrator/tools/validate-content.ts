/**
 * Tool: validate_content
 *
 * Runs validation checks on the current content: MDX syntax, dollar-sign
 * escaping, comparison operators, frontmatter schema, EntityLink IDs.
 * Auto-fixes what it can.
 * Cost: $0 (no LLM calls).
 */

import { ValidationEngine } from '../../../lib/validation-engine.ts';
import { allRules } from '../../../lib/rules/index.ts';
import type { ToolRegistration } from './types.ts';

const CRITICAL_RULES = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'prefer-entitylink',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls',
];

const QUALITY_RULES = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts',
];

export const tool: ToolRegistration = {
  name: 'validate_content',
  cost: 0,
  definition: {
    name: 'validate_content',
    description:
      'Run validation checks on the current content: MDX syntax, dollar-sign escaping, comparison operators, frontmatter schema, EntityLink IDs. Auto-fixes what it can. Returns critical and quality issues. Cost: $0 (no LLM).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    try {
      const fs = await import('fs');
      const originalContent = fs.readFileSync(ctx.filePath, 'utf-8');

      // Temporarily write current content to disk for validation
      fs.writeFileSync(ctx.filePath, ctx.currentContent);

      try {
        // Set up engine with only the relevant rules
        const relevantRuleIds = new Set([...CRITICAL_RULES, ...QUALITY_RULES]);
        const relevantRules = allRules.filter((r) => relevantRuleIds.has(r.id));
        const engine = new ValidationEngine();
        engine.addRules(relevantRules);
        await engine.load();

        // Run validation on just this file
        const issues = await engine.validate({ files: [ctx.filePath] });

        // Group issues by rule category
        const groupByRule = (ruleIds: string[]) =>
          ruleIds
            .map((ruleId) => {
              const ruleIssues = issues.filter((i) => i.rule === ruleId);
              return { rule: ruleId, count: ruleIssues.length, issues: ruleIssues };
            })
            .filter((r) => r.count > 0);

        const critical = groupByRule(CRITICAL_RULES);
        const quality = groupByRule(QUALITY_RULES);

        // Apply auto-fixes
        const fixableIssues = [
          ...critical.flatMap((r) => r.issues),
          ...quality.flatMap((r) => r.issues),
        ].filter((i) => i.isFixable);

        if (fixableIssues.length > 0) {
          engine.applyFixes(fixableIssues);
          ctx.currentContent = fs.readFileSync(ctx.filePath, 'utf-8');
          // Invalidate section cache
          ctx.splitPage = null;
          ctx.sections = null;
        }

        return JSON.stringify(
          {
            criticalIssues: critical.map((r) => ({
              rule: r.rule,
              count: r.count,
              details: r.issues.slice(0, 3).map((i) => i.toString()),
            })),
            qualityWarnings: quality.map((r) => ({
              rule: r.rule,
              count: r.count,
            })),
            autoFixesApplied: fixableIssues.length,
          },
          null,
          2,
        );
      } finally {
        // Restore original file content
        fs.writeFileSync(ctx.filePath, originalContent);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Validation failed: ${error.message}` });
    }
  },
};
