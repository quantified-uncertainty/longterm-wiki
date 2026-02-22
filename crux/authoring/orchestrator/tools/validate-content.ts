/**
 * Tool: validate_content
 *
 * Runs validation checks on the current content: MDX syntax, dollar-sign
 * escaping, comparison operators, frontmatter schema, EntityLink IDs.
 * Auto-fixes what it can.
 * Cost: $0 (no LLM calls).
 */

import { ValidationEngine, ContentFile } from '../../../lib/validation-engine.ts';
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
      // SIGKILL-safe: inject current content into the engine's in-memory map
      // so the real file on disk is never touched. Mirrors the approach used
      // in the page-improver validate phase (see phases/validate.ts).
      const engine = new ValidationEngine();
      await engine.load();

      engine.content.set(ctx.filePath, new ContentFile(ctx.filePath, ctx.currentContent));

      const allRuleIds = [...CRITICAL_RULES, ...QUALITY_RULES];
      const ruleMap = new Map(allRules.map(r => [r.id, r]));
      for (const id of allRuleIds) {
        const rule = ruleMap.get(id);
        if (rule) engine.addRule(rule);
      }

      const allIssues = await engine.validate({ files: [ctx.filePath] });

      const criticalSet = new Set(CRITICAL_RULES);
      const qualitySet = new Set(QUALITY_RULES);

      const criticalByRule = new Map<string, typeof allIssues>();
      const qualityByRule = new Map<string, typeof allIssues>();
      for (const issue of allIssues) {
        if (criticalSet.has(issue.rule)) {
          if (!criticalByRule.has(issue.rule)) criticalByRule.set(issue.rule, []);
          criticalByRule.get(issue.rule)!.push(issue);
        } else if (qualitySet.has(issue.rule)) {
          if (!qualityByRule.has(issue.rule)) qualityByRule.set(issue.rule, []);
          qualityByRule.get(issue.rule)!.push(issue);
        }
      }

      // Apply auto-fixes to the content string (no disk writes)
      const fixableIssues = allIssues.filter(i => i.isFixable);
      if (fixableIssues.length > 0) {
        ctx.currentContent = engine.applyFixesToContentString(ctx.currentContent, allIssues);
        // Invalidate section cache
        ctx.splitPage = null;
        ctx.sections = null;
      }

      return JSON.stringify({
        criticalIssues: [...criticalByRule.entries()]
          .filter(([, issues]) => issues.filter(i => i.severity === 'error').length > 0)
          .map(([rule, issues]) => ({
            rule,
            count: issues.filter(i => i.severity === 'error').length,
            details: issues.slice(0, 3).map(i => i.toString()),
          })),
        qualityWarnings: [...qualityByRule.entries()]
          .filter(([, issues]) => issues.length > 0)
          .map(([rule, issues]) => ({ rule, count: issues.length })),
        autoFixesApplied: fixableIssues.length,
      }, null, 2);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Validation failed: ${error.message}` });
    }
  },
};
