/**
 * Rule: Component Import Validation
 *
 * Checks that all JSX components used in MDX content are properly imported.
 * This catches missing imports before CI fails with "Expected component to be defined".
 *
 * Common wiki components that need imports:
 * - EntityLink, DataInfoBox, InfoBox, Backlinks, Mermaid, R, DataExternalLinks
 */

import { createRule, Issue, Severity, FixType, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { isInCodeBlock } from '../mdx-utils.ts';
import { COMPONENT_USAGE_RE, WIKI_IMPORT_RE } from '../patterns.ts';

// Components from @components/wiki that are commonly used.
// Must match actual exports from app/src/components/wiki/index.ts
const WIKI_COMPONENTS = [
  'EntityLink',
  'MultiEntityLinks',
  'R',
  'InfoBox',
  'DataInfoBox',
  'Backlinks',
  'DataExternalLinks',
  'ExternalLinks',
  'Mermaid',
  'CredibilityBadge',
  'ResourceTags',
  'F',
  'SquiggleEstimate',
];

// Pattern to find any import that includes a component name
const ANY_IMPORT_PATTERN = (component: string) => new RegExp(`import.*\\b${component}\\b.*from`);

export const componentImportsRule = createRule({
  id: 'component-imports',
  name: 'Component Import Validation',
  description: 'Ensure all used JSX components are imported',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const lines = content.body.split('\n');

    // Find all component usages in the body (not in code blocks)
    const usedComponents = new Set<string>();
    let position = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match: RegExpExecArray | null;
      const regex = new RegExp(COMPONENT_USAGE_RE.source, 'g');

      while ((match = regex.exec(line)) !== null) {
        const absolutePos = position + match.index;
        if (!isInCodeBlock(content.body, absolutePos)) {
          const componentName = match[1];
          // Only track wiki components we know about
          if (WIKI_COMPONENTS.includes(componentName)) {
            usedComponents.add(componentName);
          }
        }
      }
      position += line.length + 1;
    }

    if (usedComponents.size === 0) {
      return issues;
    }

    // Check what's imported from @components/wiki
    const wikiImportMatch = content.raw.match(WIKI_IMPORT_RE);
    const importedComponents = new Set<string>();

    if (wikiImportMatch) {
      const importList = wikiImportMatch[1];
      // Parse the import list, handling spaces and commas
      const components = importList.split(',').map(c => c.trim()).filter(Boolean);
      components.forEach(c => importedComponents.add(c));
    }

    // Also check for individual imports of each component
    for (const component of usedComponents) {
      if (ANY_IMPORT_PATTERN(component).test(content.raw)) {
        importedComponents.add(component);
      }
    }

    // Find missing imports
    const missingComponents = [...usedComponents].filter(c => !importedComponents.has(c));

    if (missingComponents.length === 0) {
      return issues;
    }

    // Generate a single issue with fix for all missing components
    const missingList = missingComponents.join(', ');

    // Determine the fix - either add to existing import or create new one
    if (wikiImportMatch) {
      // Add to existing import
      const existingImports = wikiImportMatch[1].trim();
      const newImports = `${existingImports}, ${missingComponents.join(', ')}`;
      const quoteChar = wikiImportMatch[0].includes("'") ? "'" : '"';

      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: 1, // Import issues are at the top
        message: `Missing import(s) for: ${missingList}`,
        severity: Severity.ERROR,
        fix: {
          type: 'custom', // Custom fix type - handled by the fixer
          action: 'add-to-existing-import',
          components: missingComponents,
          existingImports,
          quoteChar,
        },
      }));
    } else {
      // Create new import
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: 1,
        message: `Missing import(s) for: ${missingList}`,
        severity: Severity.ERROR,
        fix: {
          type: 'custom',
          action: 'create-new-import',
          components: missingComponents,
        },
      }));
    }

    return issues;
  },

  /**
   * Custom fix function for this rule
   * Called by the fix command with the file content and issue
   */
  fix(content: string, issue: Issue): string | null {
    if (!issue.fix || issue.fix.type !== 'custom') {
      return null;
    }

    const { action, components } = issue.fix;

    if (action === 'add-to-existing-import') {
      // Add components to existing @components/wiki import
      const { quoteChar } = issue.fix;
      return content.replace(
        WIKI_IMPORT_RE,
        (match: string, imports: string) => {
          const trimmedImports = imports.trim();
          const newImports = `${trimmedImports}, ${components.join(', ')}`;
          return `import {${newImports}} from ${quoteChar}@components/wiki${quoteChar}`;
        }
      );
    }

    if (action === 'create-new-import') {
      // Add new import after frontmatter
      const importStatement = `import { ${components.join(', ')} } from '@components/wiki';`;
      const lines = content.split('\n');

      // Find end of frontmatter
      let fmCount = 0;
      let insertIdx = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '---') {
          fmCount++;
          if (fmCount === 2) {
            insertIdx = i + 1;
            break;
          }
        }
      }

      // Insert import after frontmatter
      lines.splice(insertIdx, 0, importStatement);
      return lines.join('\n');
    }

    return null;
  },
});

export default componentImportsRule;
