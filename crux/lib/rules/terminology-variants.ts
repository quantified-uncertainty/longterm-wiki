/**
 * Rule: Terminology Variants
 *
 * Global-scope rule that scans for variant terms (AGI, ASI, TAI,
 * p(doom), x-risk) and flags when more than 2 variants of a canonical
 * term are in use across the content corpus. Advisory only (INFO).
 *
 * Ported from crux/validate/validate-consistency.ts (lines ~301-342).
 */

import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileUsage {
  filePath: string;
  count: number;
}

interface TermVariants {
  [canonical: string]: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Terms that should be used consistently, with their known variants. */
const TERM_VARIANTS: TermVariants = {
  'AGI': ['AGI', 'Artificial General Intelligence', 'general AI', 'human-level AI'],
  'ASI': ['ASI', 'Artificial Superintelligence', 'superintelligent AI', 'superintelligence'],
  'TAI': ['TAI', 'Transformative AI', 'transformative artificial intelligence'],
  'p(doom)': ['p(doom)', 'p-doom', 'P(doom)', 'probability of doom', 'extinction probability'],
  'x-risk': ['x-risk', 'X-risk', 'existential risk', 'xrisk'],
};

/** Minimum number of distinct variants before flagging. */
const VARIANT_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const terminologyVariantsRule = createRule({
  id: 'terminology-variants',
  name: 'Terminology Variants',
  description: 'Flags when more than 2 variants of a canonical term are in use across pages',
  scope: 'global',

  check(files: ContentFile | ContentFile[], _engine: ValidationEngine): Issue[] {
    const allFiles = Array.isArray(files) ? files : [files];
    const issues: Issue[] = [];

    for (const [canonical, variants] of Object.entries(TERM_VARIANTS)) {
      const usage: Record<string, FileUsage[]> = {};

      for (const contentFile of allFiles) {
        const content = contentFile.raw;

        for (const variant of variants) {
          // Case-sensitive match for short acronyms, case-insensitive for phrases
          const regex = variant.length <= 5
            ? new RegExp(`\\b${escapeRegex(variant)}\\b`, 'g')
            : new RegExp(`\\b${escapeRegex(variant)}\\b`, 'gi');

          const matches = content.match(regex);
          if (matches && matches.length > 0) {
            if (!usage[variant]) usage[variant] = [];
            usage[variant].push({ filePath: contentFile.path, count: matches.length });
          }
        }
      }

      const usedVariants = Object.keys(usage);

      // If more than 2 variants are used, flag it
      if (usedVariants.length > VARIANT_THRESHOLD) {
        const variantSummary = usedVariants
          .map((v: string) => {
            const totalUses = usage[v].reduce((sum: number, u: FileUsage) => sum + u.count, 0);
            return `"${v}" (${totalUses} uses in ${usage[v].length} files)`;
          })
          .join(', ');

        issues.push(new Issue({
          rule: 'terminology-variants',
          file: 'global',
          message: `Multiple variants used for "${canonical}": ${variantSummary}. Consider standardizing to "${canonical}" or the most common variant.`,
          severity: Severity.INFO,
        }));
      }
    }

    return issues;
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default terminologyVariantsRule;
