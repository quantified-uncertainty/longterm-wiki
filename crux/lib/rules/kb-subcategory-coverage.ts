/**
 * Rule: KB Subcategory Coverage
 *
 * Warns when a KB section has more than 20% of non-index pages without a
 * `subcategory` field in their frontmatter. This prevents organizational gaps
 * from accumulating undetected — pages without subcategories end up ungrouped
 * or lumped into "Other" in the sidebar.
 *
 * Severity: WARNING (advisory, non-blocking)
 * Scope: global (needs all files to compute per-section coverage)
 *
 * See: https://github.com/quantified-uncertainty/longterm-wiki/issues/352
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

const RULE_ID = 'kb-subcategory-coverage';

/** Fraction of non-index pages missing subcategory that triggers a warning. */
const MISSING_SUBCATEGORY_THRESHOLD = 0.2;

/** Pre-computed threshold percentage for display in messages. */
const THRESHOLD_PCT = Math.round(MISSING_SUBCATEGORY_THRESHOLD * 100);

interface SectionStats {
  all: ContentFile[];
  missing: ContentFile[];
  indexPage: ContentFile | null;
}

export const kbSubcategoryCoverageRule = {
  id: RULE_ID,
  name: 'KB Subcategory Coverage',
  description:
    `Warns when >${THRESHOLD_PCT}% of non-index pages in a KB section lack a subcategory field`,
  scope: 'global' as const,

  check(files: ContentFile | ContentFile[], _engine: ValidationEngine): Issue[] {
    const contentFiles = Array.isArray(files) ? files : [files];
    const issues: Issue[] = [];

    // Group pages by KB section (first directory under knowledge-base/)
    const sections = new Map<string, SectionStats>();

    for (const cf of contentFiles) {
      // Use startsWith to avoid false matches on paths containing "knowledge-base/"
      // as a non-leading substring (e.g. "not-knowledge-base/...").
      if (!cf.relativePath.startsWith('knowledge-base/')) continue;

      // Extract section name, e.g. "risks" from "knowledge-base/risks/bio-risk.mdx".
      // Pages directly under knowledge-base/ (no subdirectory) are skipped — they are
      // section-level files like index.mdx, directory.mdx, or table overviews.
      const match = cf.relativePath.match(/^knowledge-base\/([^/]+)\//);
      if (!match) continue;

      const section = match[1];
      if (!sections.has(section)) {
        sections.set(section, { all: [], missing: [], indexPage: null });
      }
      const entry = sections.get(section)!;

      if (cf.isIndex) {
        // Store index page for reporting location; don't count it toward the threshold.
        // Note: ContentFile.isIndex uses basename(path).startsWith('index.'), so a file
        // like "index-of-debates.mdx" would also be treated as an index page and excluded
        // from the count — this mirrors the existing ContentFile convention.
        entry.indexPage = cf;
        continue;
      }

      entry.all.push(cf);
      if (!cf.frontmatter.subcategory) {
        entry.missing.push(cf);
      }
    }

    // Emit one warning per section that exceeds the threshold
    for (const [sectionName, { all, missing, indexPage }] of sections) {
      if (all.length === 0) continue;

      const missingRatio = missing.length / all.length;
      if (missingRatio > MISSING_SUBCATEGORY_THRESHOLD) {
        const pct = Math.round(missingRatio * 100);
        // Report on the section index page so the issue is easy to locate;
        // fall back to the first non-index page if no index exists.
        const reportFile = indexPage?.path ?? all[0].path;

        issues.push(
          new Issue({
            rule: RULE_ID,
            file: reportFile,
            message:
              `KB section "${sectionName}" has ${missing.length}/${all.length} non-index pages ` +
              `without a subcategory (${pct}% > ${THRESHOLD_PCT}% threshold). ` +
              `Add a \`subcategory:\` field to: ${missing.map(f => f.relativePath.split('/').pop()).join(', ')}`,
            severity: Severity.WARNING,
          }),
        );
      }
    }

    return issues;
  },
};

export default kbSubcategoryCoverageRule;
