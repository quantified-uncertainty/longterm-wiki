/**
 * Tool: validate_content
 *
 * Runs validation checks on the current content: MDX syntax, dollar-sign
 * escaping, comparison operators, frontmatter schema, EntityLink IDs.
 * Auto-fixes what it can.
 * Cost: $0 (no LLM calls).
 *
 * SIGKILL-safe: operates entirely in-memory. The real MDX file on disk is
 * never written to. This mirrors the V1 validate phase approach (see
 * page-improver/phases/validate.ts).
 */

import { ValidationEngine, ContentFile } from '../../../lib/validation-engine.ts';
import { allRules } from '../../../lib/rules/index.ts';
import { CRITICAL_RULES } from '../../page-improver/utils.ts';
import type { ToolRegistration } from './types.ts';

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
      // Set up engine with only the relevant rules
      const relevantRuleIds = new Set([...CRITICAL_RULES, ...QUALITY_RULES]);
      const relevantRules = allRules.filter((r) => relevantRuleIds.has(r.id));
      const engine = new ValidationEngine();
      engine.addRules(relevantRules);

      // Load all content from disk (builds path registry, entities, etc.)
      await engine.load();

      // Inject the current in-memory content under the real file path.
      // This means validators see the orchestrator's working copy while
      // the real MDX file on disk is never touched. If the process is
      // SIGKILLed, the real file remains at its original state.
      engine.content.set(ctx.filePath, new ContentFile(ctx.filePath, ctx.currentContent));

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

      // Apply auto-fixes in-memory (no disk writes)
      const allFoundIssues = [
        ...critical.flatMap((r) => r.issues),
        ...quality.flatMap((r) => r.issues),
      ];
      const fixableCount = allFoundIssues.filter((i) => i.isFixable).length;

      if (fixableCount > 0) {
        ctx.currentContent = engine.applyFixesToContentString(ctx.currentContent, allFoundIssues);
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
          autoFixesApplied: fixableCount,
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Validation failed: ${error.message}` });
    }
  },
};
