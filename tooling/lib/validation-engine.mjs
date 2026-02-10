/**
 * Unified Validation Engine
 *
 * A single-pass validation system that loads content once and runs multiple
 * validation rules against it. This replaces the pattern of having many
 * separate validator scripts that each re-read all files.
 *
 * Usage:
 *   import { ValidationEngine } from './validation-engine.mjs';
 *
 *   const engine = new ValidationEngine();
 *   await engine.load();
 *   engine.addRule(myRule);
 *   const issues = await engine.validate();
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative, dirname, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { findMdxFiles, findFiles } from './file-utils.mjs';
import { getColors } from './output.mjs';
import { parseFrontmatterAndBody } from './mdx-utils.mjs';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR, DATA_DIR_ABS as DATA_DIR } from './content-types.mjs';
import { parseSidebarConfig } from './sidebar-utils.mjs';

/**
 * Load JSON file safely
 */
function loadJSON(path) {
  const fullPath = join(PROJECT_ROOT, path);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Load YAML file safely
 */
function loadYAML(path) {
  const fullPath = join(PROJECT_ROOT, path);
  if (!existsSync(fullPath)) return null;
  try {
    return parseYaml(readFileSync(fullPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Issue severity levels
 */
export const Severity = {
  ERROR: 'error',     // Must fix - will fail CI
  WARNING: 'warning', // Should fix - won't fail CI by default
  INFO: 'info',       // Informational - suggestions
};

/**
 * Fix types for declarative fixes
 */
export const FixType = {
  INSERT_LINE_BEFORE: 'insert-line-before',  // Insert a line before the specified line
  INSERT_LINE_AFTER: 'insert-line-after',    // Insert a line after the specified line
  REPLACE_LINE: 'replace-line',              // Replace the entire line
  REPLACE_TEXT: 'replace-text',              // Replace specific text in the line
};

/**
 * Validation issue structure
 */
export class Issue {
  /**
   * @param {Object} options
   * @param {string} options.rule - Rule ID that generated this issue
   * @param {string} options.file - File path
   * @param {number} options.line - Line number (1-indexed, relative to body)
   * @param {string} options.message - Human-readable message
   * @param {string} options.severity - Severity level
   * @param {Object} options.fix - Optional fix specification
   * @param {string} options.fix.type - Fix type from FixType enum
   * @param {string} options.fix.content - Content to insert/replace
   * @param {string} options.fix.oldText - For REPLACE_TEXT: text to find
   * @param {string} options.fix.newText - For REPLACE_TEXT: replacement text
   */
  constructor({ rule, file, line, message, severity = Severity.ERROR, fix = null }) {
    this.rule = rule;
    this.file = file;
    this.line = line;
    this.message = message;
    this.severity = severity;
    this.fix = fix;
  }

  toString() {
    const loc = this.line ? `:${this.line}` : '';
    return `[${this.severity.toUpperCase()}] ${this.rule}: ${this.file}${loc} - ${this.message}`;
  }

  get isFixable() {
    return this.fix != null && this.fix.type != null;
  }
}

/**
 * Content file representation
 */
export class ContentFile {
  constructor(filePath, raw) {
    this.path = filePath;
    this.relativePath = relative(CONTENT_DIR, filePath);
    this.raw = raw;

    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    this.frontmatter = frontmatter;
    this.body = body;

    // Derived properties
    this.extension = filePath.split('.').pop();
    this.isIndex = basename(filePath).startsWith('index.');
    this.directory = dirname(this.relativePath);
    this.slug = this.relativePath.replace(/\.(mdx?|md)$/, '').replace(/\/index$/, '');
  }

  /**
   * Get URL path for this content
   */
  get urlPath() {
    let path = '/' + this.slug + '/';
    if (path === '//') path = '/';
    return path;
  }
}

/**
 * Main validation engine
 */
export class ValidationEngine {
  constructor(options = {}) {
    this.options = {
      contentDir: CONTENT_DIR,
      dataDir: DATA_DIR,
      ...options,
    };

    this.rules = new Map();
    this.content = new Map();
    this.loaded = false;

    // Shared data (loaded once)
    this.pathRegistry = null;
    this.entities = null;
    this.sidebarConfig = null;
  }

  /**
   * Load all content and shared data
   */
  async load() {
    if (this.loaded) return;

    // Load all MDX/MD files
    const files = findMdxFiles(this.options.contentDir);
    for (const filePath of files) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const contentFile = new ContentFile(filePath, raw);
        this.content.set(filePath, contentFile);
      } catch (err) {
        console.error(`Failed to load ${filePath}: ${err.message}`);
      }
    }

    // Load shared data
    this.pathRegistry = loadJSON('data/pathRegistry.json') || {};
    this.entities = loadYAML('data/entities.yaml') || {};

    // Build reverse path registry (path -> id)
    this.reversePathRegistry = {};
    for (const [id, path] of Object.entries(this.pathRegistry)) {
      const normalized = path.endsWith('/') ? path : path + '/';
      this.reversePathRegistry[normalized] = id;
      this.reversePathRegistry[path.replace(/\/$/, '')] = id;
    }

    // Parse sidebar config (returns empty data in Next.js — sidebar is in wiki-nav.ts)
    this.sidebarConfig = this._parseSidebarConfig();

    this.loaded = true;
  }

  /**
   * Parse sidebar configuration.
   * Returns empty data in Next.js — sidebar is managed by wiki-nav.ts.
   */
  _parseSidebarConfig() {
    return parseSidebarConfig();
  }

  /**
   * Register a validation rule
   */
  addRule(rule) {
    if (!rule.id || !rule.check) {
      throw new Error('Rule must have id and check function');
    }
    this.rules.set(rule.id, rule);
  }

  /**
   * Register multiple rules
   */
  addRules(rules) {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  /**
   * Get a registered rule by ID
   */
  getRule(id) {
    return this.rules.get(id);
  }

  /**
   * Run validation
   * @param {Object} options - Validation options
   * @param {string[]} options.ruleIds - Specific rules to run (null = all)
   * @param {string[]} options.files - Specific files to check (null = all)
   * @returns {Issue[]} Array of issues found
   */
  async validate(options = {}) {
    if (!this.loaded) {
      await this.load();
    }

    const { ruleIds = null, files = null } = options;
    const issues = [];

    // Determine which rules to run
    const rulesToRun = ruleIds
      ? ruleIds.map(id => this.rules.get(id)).filter(Boolean)
      : [...this.rules.values()];

    // Determine which files to check
    const filesToCheck = files
      ? files.map(f => this.content.get(f)).filter(Boolean)
      : [...this.content.values()];

    // Run file-level rules
    for (const contentFile of filesToCheck) {
      for (const rule of rulesToRun) {
        if (rule.scope === 'global') continue; // Skip global rules in file loop

        try {
          const ruleIssues = await rule.check(contentFile, this);
          if (Array.isArray(ruleIssues)) {
            issues.push(...ruleIssues);
          }
        } catch (err) {
          issues.push(new Issue({
            rule: rule.id,
            file: contentFile.path,
            message: `Rule threw error: ${err.message}`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    // Run global rules (operate on all content at once)
    for (const rule of rulesToRun) {
      if (rule.scope !== 'global') continue;

      try {
        const ruleIssues = await rule.check(filesToCheck, this);
        if (Array.isArray(ruleIssues)) {
          issues.push(...ruleIssues);
        }
      } catch (err) {
        issues.push(new Issue({
          rule: rule.id,
          file: 'global',
          message: `Rule threw error: ${err.message}`,
          severity: Severity.ERROR,
        }));
      }
    }

    return issues;
  }

  /**
   * Apply fixes to files
   * @param {Issue[]} issues - Issues with fix specifications
   * @returns {Object} Fix results { filesFixed, issuesFixed }
   */
  applyFixes(issues) {
    const fixableIssues = issues.filter(i => i.isFixable);
    const byFile = new Map();

    // Group by file
    for (const issue of fixableIssues) {
      if (!byFile.has(issue.file)) {
        byFile.set(issue.file, []);
      }
      byFile.get(issue.file).push(issue);
    }

    let filesFixed = 0;
    let issuesFixed = 0;

    for (const [filePath, fileIssues] of byFile) {
      const content = readFileSync(filePath, 'utf-8');
      const fixed = this._applyFixesToContent(content, fileIssues);

      if (fixed !== content) {
        writeFileSync(filePath, fixed);
        filesFixed++;
        issuesFixed += fileIssues.length;
      }
    }

    return { filesFixed, issuesFixed };
  }

  /**
   * Apply fixes to content string
   * @private
   */
  _applyFixesToContent(content, issues) {
    // Get frontmatter offset
    const frontmatterEndLine = this._getFrontmatterEndLine(content);
    const lines = content.split('\n');

    // Sort issues by line number descending (fix from bottom up)
    const sorted = [...issues].sort((a, b) => b.line - a.line);

    for (const issue of sorted) {
      const { fix, line } = issue;
      // Convert body line number to absolute line number
      const absLine = line + frontmatterEndLine;
      const lineIndex = absLine - 1;

      switch (fix.type) {
        case FixType.INSERT_LINE_BEFORE:
          lines.splice(lineIndex, 0, fix.content ?? '');
          break;

        case FixType.INSERT_LINE_AFTER:
          lines.splice(lineIndex + 1, 0, fix.content ?? '');
          break;

        case FixType.REPLACE_LINE:
          lines[lineIndex] = fix.content;
          break;

        case FixType.REPLACE_TEXT:
          if (fix.oldText && fix.newText !== undefined) {
            lines[lineIndex] = lines[lineIndex].replace(fix.oldText, fix.newText);
          }
          break;
      }
    }

    return lines.join('\n');
  }

  /**
   * Get the line index where frontmatter ends
   * @private
   */
  _getFrontmatterEndLine(content) {
    const lines = content.split('\n');
    if (lines[0] !== '---') return 0;

    let dashCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '---') {
        dashCount++;
        if (dashCount === 2) return i + 1;
      }
    }
    return 0;
  }

  /**
   * Get summary statistics
   */
  getSummary(issues) {
    const byRule = {};
    const bySeverity = { error: 0, warning: 0, info: 0 };

    for (const issue of issues) {
      byRule[issue.rule] = (byRule[issue.rule] || 0) + 1;
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    }

    return {
      total: issues.length,
      byRule,
      bySeverity,
      hasErrors: bySeverity.error > 0,
    };
  }

  /**
   * Format issues for console output
   */
  formatOutput(issues, options = {}) {
    const { ci = false, verbose = false } = options;
    const colors = getColors(ci);

    if (ci) {
      return JSON.stringify({
        issues: issues.map(i => ({
          rule: i.rule,
          file: i.file,
          line: i.line,
          message: i.message,
          severity: i.severity,
        })),
        summary: this.getSummary(issues),
      }, null, 2);
    }

    const lines = [];
    const grouped = {};

    // Group by file
    for (const issue of issues) {
      const key = issue.file;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(issue);
    }

    // Output by file
    for (const [file, fileIssues] of Object.entries(grouped)) {
      const relPath = relative(PROJECT_ROOT, file);
      lines.push(`\n${colors.cyan}${relPath}${colors.reset}`);

      for (const issue of fileIssues) {
        const sevColor = issue.severity === 'error' ? colors.red
          : issue.severity === 'warning' ? colors.yellow
          : colors.dim;
        const line = issue.line ? `:${issue.line}` : '';
        lines.push(`  ${sevColor}${issue.severity}${colors.reset} [${issue.rule}]${line}: ${issue.message}`);
      }
    }

    // Summary
    const summary = this.getSummary(issues);
    lines.push(`\n${colors.bold}Summary:${colors.reset}`);
    lines.push(`  Errors: ${colors.red}${summary.bySeverity.error}${colors.reset}`);
    lines.push(`  Warnings: ${colors.yellow}${summary.bySeverity.warning}${colors.reset}`);
    lines.push(`  Info: ${colors.dim}${summary.bySeverity.info}${colors.reset}`);

    return lines.join('\n');
  }
}

/**
 * Create a simple rule helper
 */
export function createRule({ id, name, description, scope = 'file', check }) {
  return { id, name, description, scope, check };
}

// Export singletons for convenience
export const engine = new ValidationEngine();

export default ValidationEngine;
