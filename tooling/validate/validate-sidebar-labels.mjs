#!/usr/bin/env node

/**
 * Sidebar Label Validation Script
 *
 * Validates that all sidebar labels in astro.config.mjs use proper English names,
 * not kebab-case slugs (e.g., "Analysis Models" not "analysis-models").
 *
 * Usage: node scripts/validate/validate-sidebar-labels.mjs [--ci]
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Errors found
 */

import { readFileSync } from 'fs';
import { getColors } from '../lib/output.mjs';

const CONFIG_FILE = 'astro.config.mjs';
const CI_MODE = process.argv.includes('--ci');
const colors = getColors(CI_MODE);

/**
 * Check if a label appears to be kebab-case (lowercase with dashes)
 * @param {string} label - The label to check
 * @returns {boolean} True if label appears to be kebab-case
 */
function isKebabCase(label) {
  // Check if it contains dashes between lowercase letters
  // This pattern matches: word-word or word-word-word etc.
  return /^[a-z]+(-[a-z]+)+$/.test(label);
}

/**
 * Check if a label has improper casing (e.g., "analysis-Models" or "Analysis-models")
 * @param {string} label - The label to check
 * @returns {boolean} True if label has dashes (suggesting slug-like naming)
 */
function hasDashes(label) {
  // Labels shouldn't have dashes - proper English names use spaces
  // Exception list: hyphenated compound modifiers that are correct English
  const exceptions = ['Self-Regulation', 'Industry Self-Regulation', 'Long-term Lock-in'];
  return /-/.test(label) && !exceptions.includes(label);
}

/**
 * Extract all label values from the config file using regex
 * @param {string} content - Config file content
 * @returns {Array<{label: string, line: number}>}
 */
function extractLabels(content) {
  const labels = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: label: 'value' or label: "value"
    const match = line.match(/label:\s*['"]([^'"]+)['"]/);
    if (match) {
      labels.push({
        label: match[1],
        line: i + 1,
        context: line.trim(),
      });
    }
  }

  return labels;
}

/**
 * Suggest a proper English name for a kebab-case label
 * @param {string} label - The kebab-case label
 * @returns {string} Suggested proper name
 */
function suggestProperName(label) {
  return label
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Main function
 */
function main() {
  let content;
  try {
    content = readFileSync(CONFIG_FILE, 'utf-8');
  } catch (e) {
    console.error(`${colors.red}Error: Could not read ${CONFIG_FILE}${colors.reset}`);
    process.exit(1);
  }

  const labels = extractLabels(content);
  const issues = [];

  for (const { label, line, context } of labels) {
    if (isKebabCase(label)) {
      issues.push({
        label,
        line,
        context,
        severity: 'error',
        type: 'kebab-case',
        suggestion: suggestProperName(label),
      });
    } else if (hasDashes(label)) {
      // Check for dashes in labels (might be intentional like "Self-Regulation")
      // This is a warning, not an error
      issues.push({
        label,
        line,
        context,
        severity: 'warning',
        type: 'contains-dash',
        suggestion: label.replace(/-/g, ' '),
      });
    }
  }

  // Filter to only errors for exit code
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (CI_MODE) {
    console.log(JSON.stringify({
      file: CONFIG_FILE,
      labelsChecked: labels.length,
      errors: errors.length,
      warnings: warnings.length,
      issues,
    }, null, 2));
  } else {
    console.log(`${colors.blue}Checking sidebar labels in ${CONFIG_FILE}...${colors.reset}\n`);
    console.log(`${colors.dim}Labels checked: ${labels.length}${colors.reset}\n`);

    if (issues.length === 0) {
      console.log(`${colors.green}✓ All sidebar labels use proper English names${colors.reset}\n`);
    } else {
      if (errors.length > 0) {
        console.log(`${colors.red}Found ${errors.length} sidebar label error(s):${colors.reset}\n`);
        for (const issue of errors) {
          console.log(`  ${colors.red}✗ Line ${issue.line}: "${issue.label}"${colors.reset}`);
          console.log(`    ${colors.dim}Context: ${issue.context}${colors.reset}`);
          console.log(`    ${colors.green}Suggestion: "${issue.suggestion}"${colors.reset}`);
          console.log();
        }
      }

      if (warnings.length > 0) {
        console.log(`${colors.yellow}Found ${warnings.length} sidebar label warning(s):${colors.reset}\n`);
        for (const issue of warnings) {
          console.log(`  ${colors.yellow}⚠ Line ${issue.line}: "${issue.label}"${colors.reset}`);
          console.log(`    ${colors.dim}Context: ${issue.context}${colors.reset}`);
          console.log(`    ${colors.dim}Note: Label contains dashes. If intentional, add to exceptions.${colors.reset}`);
          console.log();
        }
      }

      console.log(`${colors.bold}Summary:${colors.reset}`);
      console.log(`  Labels checked: ${labels.length}`);
      if (errors.length > 0) {
        console.log(`  ${colors.red}${errors.length} error(s)${colors.reset}`);
      }
      if (warnings.length > 0) {
        console.log(`  ${colors.yellow}${warnings.length} warning(s)${colors.reset}`);
      }
      console.log();
      console.log(`${colors.dim}Sidebar labels should use proper English names (e.g., "Analysis Models")${colors.reset}`);
      console.log(`${colors.dim}not kebab-case slugs (e.g., "analysis-models")${colors.reset}`);
      console.log();
    }
  }

  // Only exit with error for actual errors, not warnings
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
