/**
 * Rule: EstimateBox Component Usage
 *
 * Discourages use of EstimateBox components in favor of markdown tables.
 * EstimateBox often results in incomplete, awkward presentations with cryptic notes.
 *
 * Policy: New content should use markdown tables with detailed reasoning columns.
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.js';

export const estimateBoxesRule = createRule({
  id: 'estimate-boxes',
  name: 'EstimateBox Usage',
  description: 'Discourage EstimateBox components (use markdown tables instead)',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal documentation (may have examples)
    if (content.relativePath.includes('/internal/')) {
      return issues;
    }

    const lines = content.body.split('\n');

    // Check for EstimateBox usage
    lines.forEach((line: string, idx: number) => {
      if (line.includes('<EstimateBox')) {
        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: idx + 1,
          message: 'EstimateBox component discouraged - use markdown tables with | Expert | Estimate | Reasoning | columns instead',
          severity: Severity.WARNING,
        }));
      }
    });

    // Check for unused EstimateBox import
    const hasImport: RegExpMatchArray | null = content.raw.match(/import\s*\{[^}]*EstimateBox[^}]*\}/);
    const hasUsage = content.raw.includes('<EstimateBox');
    if (hasImport && !hasUsage) {
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        message: 'EstimateBox imported but not used (dead import)',
        severity: Severity.ERROR,
      }));
    }

    return issues;
  },
});

export default estimateBoxesRule;
