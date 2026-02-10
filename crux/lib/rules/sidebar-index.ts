/**
 * Rule: Sidebar Index Configuration
 *
 * Validates that all index.mdx files have consistent sidebar configuration:
 * - sidebar.label should be "Overview"
 * - sidebar.order should be 0
 *
 * This ensures index pages appear first in their section with a consistent label.
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.js';

export const sidebarIndexRule = createRule({
  id: 'sidebar-index',
  name: 'Sidebar Index Configuration',
  description: 'Index files should have sidebar.label="Overview" and sidebar.order=0',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only check index files
    if (!content.isIndex) {
      return issues;
    }

    // Only check knowledge-base content
    if (!content.relativePath.includes('knowledge-base')) {
      return issues;
    }

    // Skip deeply nested index files (sub-sections can have custom labels)
    // Count path segments after knowledge-base
    const afterKb = content.relativePath.split('knowledge-base/')[1] || '';
    const segments = afterKb.split('/').filter(s => s && s !== 'index.mdx');
    if (segments.length > 2) {
      // This is a sub-section (e.g., responses/epistemic-tools/projects)
      // Allow custom labels for these
      return issues;
    }

    const sidebar = content.frontmatter.sidebar || {};
    const label = sidebar.label;
    const order = sidebar.order;

    // Check label
    if (label !== 'Overview') {
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        message: label === undefined
          ? 'Missing sidebar.label (should be "Overview")'
          : `sidebar.label is "${label}" (should be "Overview")`,
        severity: Severity.ERROR,
      }));
    }

    // Check order
    if (order !== 0) {
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        message: order === undefined
          ? 'Missing sidebar.order (should be 0)'
          : `sidebar.order is ${order} (should be 0)`,
        severity: Severity.ERROR,
      }));
    }

    return issues;
  },
});

export default sidebarIndexRule;
