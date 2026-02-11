/**
 * Quality Source Validation Rule
 *
 * Ensures quality ratings are set by grade-content.mjs (which also sets ratings),
 * not manually or by LLM self-assessment.
 *
 * A page with `quality` but without `ratings` indicates the quality was set
 * outside the proper grading pipeline.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { shouldSkipValidation } from '../mdx-utils.ts';

export const qualitySourceRule = {
  id: 'quality-source',
  name: 'Quality Source',
  description: 'Ensure quality is set by grade-content.mjs (must have ratings)',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const fm = contentFile.frontmatter;

    // Skip overview pages (index.mdx) and stubs/documentation
    if (contentFile.isIndex || shouldSkipValidation(fm)) {
      return issues;
    }

    // Check if quality is set but ratings is missing
    if (fm.quality !== undefined && fm.quality !== null) {
      const hasRatings = fm.ratings &&
        (fm.ratings.novelty !== undefined ||
         fm.ratings.rigor !== undefined ||
         fm.ratings.actionability !== undefined ||
         fm.ratings.completeness !== undefined);

      if (!hasRatings) {
        // Extract page ID from slug (last segment of the path)
        const pageId = contentFile.slug.split('/').pop();
        issues.push(new Issue({
          rule: this.id,
          file: contentFile.relativePath,
          message: `Quality (${fm.quality}) set without ratings - use 'npm run regrade -- ${pageId}' to properly grade`,
          severity: this.severity,
        }));
      }
    }

    return issues;
  }
};
