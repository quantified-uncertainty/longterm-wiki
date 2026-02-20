/**
 * Rule: Standard Table Column Headers
 *
 * Enforces canonical column header formats for the three standard table types
 * across the wiki. Inconsistent headers make it harder to scan across pages.
 *
 * Canonical formats (issue #379):
 *   Risk Assessment:  | Dimension | Assessment | Notes |
 *   Quick Assessment: | Dimension | Assessment | Evidence |
 *   Key Links:        | Source | Link |
 *
 * Auto-fixable: replaces non-standard headers with the canonical form.
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

/** Canonical table header for each section type */
const CANONICAL = {
  'Risk Assessment': {
    standard: '| Dimension | Assessment | Notes |',
    separator: '|-----------|------------|-------|',
    // Known non-standard headers for this section → canonical mapping
    aliases: new Map<string, string>([
      ['| Dimension | Rating | Justification |', '| Dimension | Assessment | Notes |'],
      ['| Dimension | Rating | Notes |', '| Dimension | Assessment | Notes |'],
      ['| Dimension | Assessment | Details |', '| Dimension | Assessment | Notes |'],
      ['| Dimension | Assessment | Evidence/Notes |', '| Dimension | Assessment | Notes |'],
      ['| Dimension | Assessment | Evidence |', '| Dimension | Assessment | Notes |'],
      ['| Factor | Assessment | Evidence |', '| Dimension | Assessment | Notes |'],
      ['| Factor | Assessment | Notes |', '| Dimension | Assessment | Notes |'],
    ]),
  },
  'Quick Assessment': {
    standard: '| Dimension | Assessment | Evidence |',
    separator: '|-----------|------------|----------|',
    aliases: new Map<string, string>([
      ['| Dimension | Rating | Notes |', '| Dimension | Assessment | Evidence |'],
      ['| Dimension | Assessment | Notes |', '| Dimension | Assessment | Evidence |'],
      ['| Dimension | Rating | Evidence |', '| Dimension | Assessment | Evidence |'],
      ['| Dimension | Rating | Evidence Basis |', '| Dimension | Assessment | Evidence |'],
      ['| Dimension | Score | Evidence |', '| Dimension | Assessment | Evidence |'],
      ['| Dimension | Assessment | Details |', '| Dimension | Assessment | Evidence |'],
      ['| Dimension | Rating | Rationale |', '| Dimension | Assessment | Evidence |'],
      ['| Assessment Dimension | Rating | Analysis |', '| Dimension | Assessment | Evidence |'],
      ['| Aspect | Assessment |', '| Dimension | Assessment |'],
      ['| Aspect | Details |', '| Dimension | Assessment |'],
      ['| Aspect | Summary |', '| Dimension | Assessment |'],
      ['| Aspect | Status |', '| Dimension | Assessment |'],
      ['| Aspect | Rating | Notes |', '| Dimension | Assessment | Evidence |'],
      ['| Aspect | Description |', '| Dimension | Assessment |'],
      ['| Attribute | Assessment |', '| Dimension | Assessment |'],
      ['| Attribute | Detail |', '| Dimension | Assessment |'],
      ['| Attribute | Details |', '| Dimension | Assessment |'],
      ['| Category | Details |', '| Dimension | Assessment |'],
      ['| Dimension | Rating/Details |', '| Dimension | Assessment |'],
    ]),
  },
  'Key Links': {
    standard: '| Source | Link |',
    separator: '|--------|------|',
    aliases: new Map<string, string>([
      ['| Resource | Link |', '| Source | Link |'],
      ['| Title | Link |', '| Source | Link |'],
      ['| Name | Link |', '| Source | Link |'],
    ]),
  },
} as const;

type SectionType = keyof typeof CANONICAL;

/**
 * Parse the first non-separator table row after a section heading.
 * Returns { header, lineNum } or null if no table found nearby.
 */
function findFirstTableHeader(
  lines: string[],
  startIdx: number,
): { header: string; lineNum: number } | null {
  // Search up to 10 lines after the heading for a table
  for (let i = startIdx + 1; i < Math.min(startIdx + 11, lines.length); i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && !line.replace(/\|/g, '').replace(/-/g, '').trim() === false) {
      // Skip pure separator lines like |---|---|
      if (/^\|[\s\-|]+\|$/.test(line) && line.replace(/[\|\s\-]/g, '').length === 0) continue;
      return { header: line, lineNum: i + 1 };
    }
    // Stop searching if we hit another section heading
    if (/^#{1,3} /.test(line) && i > startIdx) break;
  }
  return null;
}

/**
 * Get the separator line for a given header (dashes matching column widths).
 */
function buildSeparator(header: string): string {
  return header
    .split('|')
    .map((cell) => {
      const trimmed = cell.trim();
      if (!trimmed) return '';
      return '-'.repeat(Math.max(3, trimmed.length));
    })
    .join('|');
}

export const tableHeadersRule = createRule({
  id: 'table-headers',
  name: 'Standard Table Column Headers',
  description:
    'Enforces canonical column headers for Risk Assessment, Quick Assessment, and Key Links tables',

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = contentFile.body;
    if (!body) return issues;

    // Skip code blocks and internal style guides
    if (contentFile.relativePath.startsWith('internal/')) return issues;

    const lines = body.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track code blocks
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Check for section headings
      const headingMatch = line.match(/^#{1,3} (Risk Assessment|Quick Assessment|Key Links)$/);
      if (!headingMatch) continue;

      const sectionType = headingMatch[1] as SectionType;
      const config = CANONICAL[sectionType];

      const found = findFirstTableHeader(lines, i);
      if (!found) continue;

      const { header, lineNum } = found;

      // Check if header is already canonical (exact match or starts with standard)
      if (header === config.standard) continue;

      // Check if it's a known alias with a fix available
      const canonical = config.aliases.get(header);
      if (canonical !== undefined) {
        const newSep = buildSeparator(canonical);
        issues.push(
          new Issue({
            rule: this.id,
            file: contentFile.path,
            line: lineNum,
            message: `Non-standard ${sectionType} table header: "${header}" → should be "${canonical}"`,
            severity: Severity.WARNING,
            fix: {
              type: FixType.REPLACE_TEXT,
              oldText: header,
              newText: canonical,
            },
          }),
        );
      } else if (!header.startsWith('| Dimension |') && !header.startsWith('| Source |')) {
        // Unknown format — report as info only (may be a specialized table)
        issues.push(
          new Issue({
            rule: this.id,
            file: contentFile.path,
            line: lineNum,
            message: `Non-standard ${sectionType} table header: "${header}" (expected "${config.standard}" or compatible variant)`,
            severity: Severity.INFO,
          }),
        );
      }
    }

    return issues;
  },
});

export default tableHeadersRule;
