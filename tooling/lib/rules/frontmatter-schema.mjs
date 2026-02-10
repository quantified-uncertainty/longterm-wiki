/**
 * Frontmatter Schema Validation Rule
 *
 * Validates MDX frontmatter against the content collection schema.
 */

import { z } from 'zod';
import { Severity, Issue } from '../validation-engine.js';

// Mirror the schema from content.config.ts
const frontmatterSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  sidebar: z.object({
    label: z.string().optional(),
    order: z.number().optional(),
    hidden: z.boolean().optional(),
    badge: z.any().optional(),
  }).optional(),
  template: z.enum(['doc', 'splash']).optional(),
  hero: z.any().optional(),
  tableOfContents: z.any().optional(),
  editUrl: z.union([z.string(), z.boolean()]).optional(),
  head: z.array(z.any()).optional(),
  lastUpdated: z.union([z.date(), z.string(), z.boolean()]).optional(),
  prev: z.any().optional(),
  next: z.any().optional(),
  banner: z.any().optional(),
  draft: z.boolean().optional(),

  // Custom LongtermWiki fields
  pageType: z.enum(['content', 'stub', 'documentation']).optional(),
  quality: z.number().min(0).max(100).optional(),
  importance: z.number().min(0).max(100).optional(),
  tractability: z.number().min(0).max(100).optional(),
  neglectedness: z.number().min(0).max(100).optional(),
  uncertainty: z.number().min(0).max(100).optional(),
  llmSummary: z.string().optional(),
  lastEdited: z.string().optional(),
  todo: z.string().optional(),
  todos: z.array(z.string()).optional(),
  seeAlso: z.string().optional(),
  ratings: z.object({
    novelty: z.number().min(0).max(10).optional(),
    rigor: z.number().min(0).max(10).optional(),
    actionability: z.number().min(0).max(10).optional(),
    completeness: z.number().min(0).max(10).optional(),
    changeability: z.number().min(0).max(100).optional(),
    xriskImpact: z.number().min(0).max(100).optional(),
    trajectoryImpact: z.number().min(0).max(100).optional(),
    uncertainty: z.number().min(0).max(100).optional(),
  }).optional(),
  metrics: z.object({
    wordCount: z.number().optional(),
    citations: z.number().optional(),
    tables: z.number().optional(),
    diagrams: z.number().optional(),
  }).optional(),
  maturity: z.string().optional(),
  fullWidth: z.boolean().optional(),
  entityId: z.string().optional(),
  roles: z.array(z.string()).optional(),
  pageTemplate: z.string().optional(),
  createdAt: z.union([z.date(), z.string()]).optional(), // YAML parser returns dates as strings or Date objects
}).passthrough();

export const frontmatterSchemaRule = {
  id: 'frontmatter-schema',
  name: 'Frontmatter Schema',
  description: 'Validate MDX frontmatter against content collection schema',
  severity: Severity.ERROR,

  // Auto-fix: quote lastEdited dates
  fix(content, issue) {
    if (issue.message.includes('lastEdited must be a quoted string')) {
      // Add quotes around unquoted lastEdited dates
      return content.replace(
        /^(lastEdited:\s*)(\d{4}-\d{2}-\d{2})(\s*)$/m,
        '$1"$2"$3'
      );
    }
    return null; // Can't fix other issues
  },

  check(contentFile, engine) {
    const issues = [];
    const frontmatter = contentFile.frontmatter;

    // Check for quoted dates (common mistake that Astro rejects)
    // We need to check the raw content for this since YAML parser already parses dates
    const rawContent = contentFile.raw;

    // Check for quoted lastUpdated dates in raw content
    const quotedLastUpdatedMatch = rawContent.match(/lastUpdated:\s*["'](\d{4}-\d{2}-\d{2})/);
    if (quotedLastUpdatedMatch) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: `lastUpdated should be unquoted YAML date (lastUpdated: ${quotedLastUpdatedMatch[1]}, not lastUpdated: "${quotedLastUpdatedMatch[1]}")`,
        severity: Severity.ERROR,
      }));
    }

    // Check for quoted createdAt dates in raw content
    const quotedCreatedAtMatch = rawContent.match(/createdAt:\s*["'](\d{4}-\d{2}-\d{2})/);
    if (quotedCreatedAtMatch) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: `createdAt should be unquoted YAML date (createdAt: ${quotedCreatedAtMatch[1]}, not createdAt: "${quotedCreatedAtMatch[1]}")`,
        severity: Severity.ERROR,
      }));
    }

    // Check for UNquoted lastEdited dates - these must be quoted strings
    // YAML parses bare 2026-02-01 as a Date object, but Astro schema expects string
    const unquotedLastEditedMatch = rawContent.match(/lastEdited:\s*(\d{4}-\d{2}-\d{2})(?:\s*$|\s*\n)/m);
    if (unquotedLastEditedMatch) {
      // Verify it's not quoted by checking if there's a quote before the date
      const beforeDate = rawContent.substring(0, rawContent.indexOf(unquotedLastEditedMatch[0]));
      const lastEditedLine = beforeDate.split('\n').length;
      const lineContent = rawContent.split('\n')[lastEditedLine - 1] || '';
      if (!lineContent.includes('"') && !lineContent.includes("'")) {
        issues.push(new Issue({
          rule: 'frontmatter-schema',
          file: contentFile.path,
          line: lastEditedLine,
          message: `lastEdited must be a quoted string (lastEdited: "${unquotedLastEditedMatch[1]}", not lastEdited: ${unquotedLastEditedMatch[1]})`,
          severity: Severity.ERROR,
        }));
      }
    }

    // Validate against Zod schema
    const result = frontmatterSchema.safeParse(frontmatter);

    if (!result.success) {
      for (const error of result.error.errors) {
        const field = error.path.join('.');
        issues.push(new Issue({
          rule: 'frontmatter-schema',
          file: contentFile.path,
          line: 1,
          message: `${field}: ${error.message}${error.received !== undefined ? ` (got: ${error.received})` : ''}`,
          severity: Severity.ERROR,
        }));
      }
    }

    return issues;
  },
};
