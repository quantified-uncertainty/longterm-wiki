/**
 * Unified Validation Engine
 *
 * A single-pass validation system that loads content once and runs multiple
 * validation rules against it. This replaces the pattern of having many
 * separate validator scripts that each re-read all files.
 *
 * Usage:
 *   import { ValidationEngine } from './validation-engine.js';
 *
 *   const engine = new ValidationEngine();
 *   await engine.load();
 *   engine.addRule(myRule);
 *   const issues = await engine.validate();
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative, dirname, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { findMdxFiles } from './file-utils.mjs';
import { getColors } from './output.mjs';
import { parseFrontmatterAndBody } from './mdx-utils.mjs';
import { PROJECT_ROOT, CONTENT_DIR_ABS as CONTENT_DIR, DATA_DIR_ABS as DATA_DIR } from './content-types.js';
import { parseSidebarConfig } from './sidebar-utils.mjs';

// ---------------------------------------------------------------------------
// Inline types for untyped .mjs dependencies (avoid blocking on full migration)
// ---------------------------------------------------------------------------

interface Colors {
  red: string;
  yellow: string;
  green: string;
  blue: string;
  cyan: string;
  dim: string;
  bold: string;
  reset: string;
  [key: string]: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixSpec {
  type: string;
  content?: string;
  oldText?: string;
  newText?: string;
}

export interface IssueOptions {
  rule: string;
  file: string;
  line?: number;
  message: string;
  severity?: string;
  fix?: FixSpec | null;
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  scope?: 'file' | 'global';
  check(
    input: ContentFile | ContentFile[],
    engine: ValidationEngine,
  ): Issue[] | Promise<Issue[]>;
}

export interface ValidateOptions {
  ruleIds?: string[] | null;
  files?: string[] | null;
}

export interface FormatOptions {
  ci?: boolean;
  verbose?: boolean;
}

export interface EngineOptions {
  contentDir?: string;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJSON(path: string): unknown | null {
  const fullPath = join(PROJECT_ROOT, path);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadYAML(path: string): unknown | null {
  const fullPath = join(PROJECT_ROOT, path);
  if (!existsSync(fullPath)) return null;
  try {
    return parseYaml(readFileSync(fullPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Issue severity levels */
export const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
} as const;

/** Fix types for declarative fixes */
export const FixType = {
  INSERT_LINE_BEFORE: 'insert-line-before',
  INSERT_LINE_AFTER: 'insert-line-after',
  REPLACE_LINE: 'replace-line',
  REPLACE_TEXT: 'replace-text',
} as const;

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/** Validation issue */
export class Issue {
  rule: string;
  file: string;
  line: number | undefined;
  message: string;
  severity: string;
  fix: FixSpec | null;

  constructor({ rule, file, line, message, severity = Severity.ERROR, fix = null }: IssueOptions) {
    this.rule = rule;
    this.file = file;
    this.line = line;
    this.message = message;
    this.severity = severity;
    this.fix = fix;
  }

  toString(): string {
    const loc = this.line ? `:${this.line}` : '';
    return `[${this.severity.toUpperCase()}] ${this.rule}: ${this.file}${loc} - ${this.message}`;
  }

  get isFixable(): boolean {
    return this.fix != null && this.fix.type != null;
  }
}

// ---------------------------------------------------------------------------
// ContentFile
// ---------------------------------------------------------------------------

/** Content file representation */
export class ContentFile {
  path: string;
  relativePath: string;
  raw: string;
  frontmatter: Record<string, any>;
  body: string;
  extension: string;
  isIndex: boolean;
  directory: string;
  slug: string;

  constructor(filePath: string, raw: string) {
    this.path = filePath;
    this.relativePath = relative(CONTENT_DIR, filePath);
    this.raw = raw;

    const parsed = parseFrontmatterAndBody(raw);
    this.frontmatter = parsed.frontmatter as Record<string, any>;
    this.body = parsed.body;

    this.extension = filePath.split('.').pop() || '';
    this.isIndex = basename(filePath).startsWith('index.');
    this.directory = dirname(this.relativePath);
    this.slug = this.relativePath.replace(/\.(mdx?|md)$/, '').replace(/\/index$/, '');
  }

  get urlPath(): string {
    let path = '/' + this.slug + '/';
    if (path === '//') path = '/';
    return path;
  }
}

// ---------------------------------------------------------------------------
// ValidationEngine
// ---------------------------------------------------------------------------

interface IssueSummary {
  total: number;
  byRule: Record<string, number>;
  bySeverity: { error: number; warning: number; info: number };
  hasErrors: boolean;
}

/** Main validation engine */
export class ValidationEngine {
  options: Required<EngineOptions>;
  rules: Map<string, Rule>;
  content: Map<string, ContentFile>;
  loaded: boolean;
  pathRegistry: Record<string, string>;
  reversePathRegistry: Record<string, string>;
  entities: unknown;
  sidebarConfig: unknown;

  constructor(options: EngineOptions = {}) {
    this.options = {
      contentDir: CONTENT_DIR,
      dataDir: DATA_DIR,
      ...options,
    };

    this.rules = new Map();
    this.content = new Map();
    this.loaded = false;

    this.pathRegistry = {};
    this.reversePathRegistry = {};
    this.entities = null;
    this.sidebarConfig = null;
  }

  /** Load all content and shared data */
  async load(): Promise<void> {
    if (this.loaded) return;

    const files = findMdxFiles(this.options.contentDir);
    for (const filePath of files) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const contentFile = new ContentFile(filePath, raw);
        this.content.set(filePath, contentFile);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to load ${filePath}: ${message}`);
      }
    }

    this.pathRegistry = (loadJSON('data/pathRegistry.json') as Record<string, string>) || {};
    this.entities = loadYAML('data/entities.yaml') || {};

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
  private _parseSidebarConfig(): unknown {
    return parseSidebarConfig();
  }

  /** Register a validation rule */
  addRule(rule: Rule): void {
    if (!rule.id || !rule.check) {
      throw new Error('Rule must have id and check function');
    }
    this.rules.set(rule.id, rule);
  }

  /** Register multiple rules */
  addRules(rules: Rule[]): void {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  /** Get a registered rule by ID */
  getRule(id: string): Rule | undefined {
    return this.rules.get(id);
  }

  /** Run validation */
  async validate(options: ValidateOptions = {}): Promise<Issue[]> {
    if (!this.loaded) {
      await this.load();
    }

    const { ruleIds = null, files = null } = options;
    const issues: Issue[] = [];

    const rulesToRun = ruleIds
      ? ruleIds.map(id => this.rules.get(id)).filter((r): r is Rule => r != null)
      : [...this.rules.values()];

    const filesToCheck = files
      ? files.map(f => this.content.get(f)).filter((c): c is ContentFile => c != null)
      : [...this.content.values()];

    // Run file-level rules
    for (const contentFile of filesToCheck) {
      for (const rule of rulesToRun) {
        if (rule.scope === 'global') continue;

        try {
          const ruleIssues = await rule.check(contentFile, this);
          if (Array.isArray(ruleIssues)) {
            issues.push(...ruleIssues);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          issues.push(new Issue({
            rule: rule.id,
            file: contentFile.path,
            message: `Rule threw error: ${message}`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    // Run global rules
    for (const rule of rulesToRun) {
      if (rule.scope !== 'global') continue;

      try {
        const ruleIssues = await rule.check(filesToCheck, this);
        if (Array.isArray(ruleIssues)) {
          issues.push(...ruleIssues);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        issues.push(new Issue({
          rule: rule.id,
          file: 'global',
          message: `Rule threw error: ${message}`,
          severity: Severity.ERROR,
        }));
      }
    }

    return issues;
  }

  /** Apply fixes to files */
  applyFixes(issues: Issue[]): { filesFixed: number; issuesFixed: number } {
    const fixableIssues = issues.filter(i => i.isFixable);
    const byFile = new Map<string, Issue[]>();

    for (const issue of fixableIssues) {
      if (!byFile.has(issue.file)) {
        byFile.set(issue.file, []);
      }
      byFile.get(issue.file)!.push(issue);
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

  /** Apply fixes to content string */
  private _applyFixesToContent(content: string, issues: Issue[]): string {
    const frontmatterEndLine = this._getFrontmatterEndLine(content);
    const lines = content.split('\n');

    const sorted = [...issues].sort((a, b) => (b.line || 0) - (a.line || 0));

    for (const issue of sorted) {
      const { fix, line } = issue;
      if (!fix || !line) continue;

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
          lines[lineIndex] = fix.content!;
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

  /** Get the line index where frontmatter ends */
  private _getFrontmatterEndLine(content: string): number {
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

  /** Get summary statistics */
  getSummary(issues: Issue[]): IssueSummary {
    const byRule: Record<string, number> = {};
    const bySeverity = { error: 0, warning: 0, info: 0 };

    for (const issue of issues) {
      byRule[issue.rule] = (byRule[issue.rule] || 0) + 1;
      const sev = issue.severity as keyof typeof bySeverity;
      if (sev in bySeverity) {
        bySeverity[sev] = (bySeverity[sev] || 0) + 1;
      }
    }

    return {
      total: issues.length,
      byRule,
      bySeverity,
      hasErrors: bySeverity.error > 0,
    };
  }

  /** Format issues for console output */
  formatOutput(issues: Issue[], options: FormatOptions = {}): string {
    const { ci = false } = options;
    const colors = getColors(ci) as Colors;

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

    const lines: string[] = [];
    const grouped: Record<string, Issue[]> = {};

    for (const issue of issues) {
      const key = issue.file;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(issue);
    }

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

    const summary = this.getSummary(issues);
    lines.push(`\n${colors.bold}Summary:${colors.reset}`);
    lines.push(`  Errors: ${colors.red}${summary.bySeverity.error}${colors.reset}`);
    lines.push(`  Warnings: ${colors.yellow}${summary.bySeverity.warning}${colors.reset}`);
    lines.push(`  Info: ${colors.dim}${summary.bySeverity.info}${colors.reset}`);

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple rule */
export function createRule({ id, name, description, scope = 'file', check }: Rule): Rule {
  return { id, name, description, scope, check };
}

export default ValidationEngine;
