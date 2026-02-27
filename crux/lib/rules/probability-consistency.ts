/**
 * Rule: Probability Consistency
 *
 * Global-scope rule that extracts probability ranges from MDX content,
 * groups them by topic, and flags non-overlapping ranges with a gap
 * greater than 15 percentage points.
 *
 * Topics with expected variance (p-doom, timelines, etc.) are flagged
 * as INFO rather than WARNING, since documenting diverse expert views
 * is intentional in those areas.
 *
 * Ported from crux/validate/validate-consistency.ts (lines ~179-296).
 */

import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProbabilityClaim {
  filePath: string;
  line: number;
  value: string;
  low: number;
  high: number;
  topic: string;
  lineContent: string;
}

interface TopicKeywords {
  [topic: string]: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pages that intentionally document ranges of views (should be skipped
 * for consistency checks). These pages quote different experts/sources
 * with varying estimates by design.
 */
const MULTI_VIEW_PAGES: string[] = [
  '/metrics/',
  '/getting-started/',
  '/arguments/',
  '/debates/',
  '/models/',
  '/people/',
  '/organizations/',
  '/core-argument/',
  '/scenarios/',
  '/guides/',
];

/**
 * Topics where varying estimates across pages are expected and should
 * not be flagged as warnings. These are inherently multi-view topics
 * where experts disagree.
 */
const EXPECTED_VARIANCE_TOPICS: string[] = [
  'p-doom',
  'timelines',
  'alignment-difficulty',
  'deceptive-alignment',
  'mesa-optimization',
  'bioweapons',
  'cyberweapons',
];

/** Keywords that help identify which topic a probability claim relates to. */
const TOPIC_KEYWORDS: TopicKeywords = {
  'p-doom': ['doom', 'extinction', 'existential', 'x-risk', 'catastroph', 'human extinction'],
  'alignment-difficulty': ['alignment', 'difficult', 'hard', 'solve', 'tractab'],
  'timelines': ['timeline', 'agi', 'tai', '203', '204', 'years', 'decade'],
  'deceptive-alignment': ['deceptive', 'deception', 'scheming', 'hidden goal'],
  'mesa-optimization': ['mesa', 'inner optimizer', 'inner objective'],
  'bioweapons': ['bio', 'pathogen', 'pandemic', 'virus', 'uplift'],
  'cyberweapons': ['cyber', 'vulnerability', 'exploit', 'zero-day', 'infrastructure'],
};

/** Gap threshold in percentage points */
const GAP_THRESHOLD = 15;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract probability claims from file content. */
function extractProbabilityClaims(content: string, filePath: string): ProbabilityClaim[] {
  const claims: ProbabilityClaim[] = [];
  const lines = content.split('\n');

  // Pattern: "X-Y%" or "X%" with surrounding context
  const percentPattern = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;

    while ((match = percentPattern.exec(line)) !== null) {
      // Get surrounding context (2 lines each side for topic detection)
      const contextStart = Math.max(0, i - 2);
      const contextEnd = Math.min(lines.length - 1, i + 2);
      const context = lines.slice(contextStart, contextEnd + 1).join(' ').toLowerCase();

      // Determine topic from context
      let topic = 'unknown';
      for (const [t, keywords] of Object.entries(TOPIC_KEYWORDS)) {
        if (keywords.some((k: string) => context.includes(k.toLowerCase()))) {
          topic = t;
          break;
        }
      }

      // Skip unknown topics (too noisy)
      if (topic === 'unknown') continue;

      const low = parseFloat(match[1] || match[3]);
      const high = parseFloat(match[2] || match[3]);

      claims.push({
        filePath,
        line: i + 1,
        value: match[1] && match[2] ? `${match[1]}-${match[2]}%` : `${match[3]}%`,
        low,
        high,
        topic,
        lineContent: line.substring(0, 100),
      });
    }
  }

  return claims;
}

/** Check if a file path matches any multi-view page pattern. */
function isMultiViewPage(filePath: string): boolean {
  return MULTI_VIEW_PAGES.some((pattern: string) => filePath.includes(pattern));
}

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const probabilityConsistencyRule = createRule({
  id: 'probability-consistency',
  name: 'Probability Consistency',
  description: 'Flags non-overlapping probability estimate ranges across pages for the same topic',
  scope: 'global',

  check(files: ContentFile | ContentFile[], _engine: ValidationEngine): Issue[] {
    const allFiles = Array.isArray(files) ? files : [files];
    const issues: Issue[] = [];

    // Extract probability claims from all files
    const allClaims: ProbabilityClaim[] = [];
    for (const contentFile of allFiles) {
      // Skip style guides and index pages
      if (contentFile.relativePath.includes('/style-guides/') ||
          contentFile.isIndex) {
        continue;
      }
      const claims = extractProbabilityClaims(contentFile.raw, contentFile.path);
      allClaims.push(...claims);
    }

    // Filter out claims from multi-view pages (they intentionally document diverse estimates)
    const filteredClaims = allClaims.filter(
      (claim: ProbabilityClaim) => !isMultiViewPage(claim.filePath),
    );

    // Group claims by topic
    const byTopic: Record<string, ProbabilityClaim[]> = {};
    for (const claim of filteredClaims) {
      if (!byTopic[claim.topic]) byTopic[claim.topic] = [];
      byTopic[claim.topic].push(claim);
    }

    for (const [topic, claims] of Object.entries(byTopic)) {
      if (claims.length < 2) continue;

      // Check for non-overlapping ranges
      for (let i = 0; i < claims.length; i++) {
        for (let j = i + 1; j < claims.length; j++) {
          const a = claims[i];
          const b = claims[j];

          // Skip if same file
          if (a.filePath === b.filePath) continue;

          // Check for non-overlapping ranges
          if (a.high < b.low || b.high < a.low) {
            const gap = Math.min(Math.abs(a.high - b.low), Math.abs(b.high - a.low));

            // Only flag significant gaps (> 15 percentage points)
            if (gap > GAP_THRESHOLD) {
              // Topics with expected variance are info, not warnings
              const severity = EXPECTED_VARIANCE_TOPICS.includes(topic)
                ? Severity.INFO
                : Severity.WARNING;

              issues.push(new Issue({
                rule: 'probability-consistency',
                file: a.filePath,
                line: a.line,
                message: `"${topic}" estimates differ significantly: ${a.value} vs ${b.value} (${gap.toFixed(0)} pp gap). Other location: ${b.filePath}:${b.line}`,
                severity,
              }));
            }
          }
        }
      }
    }

    // Deduplicate (same pair might be found multiple times)
    const seen = new Set<string>();
    return issues.filter((issue: Issue) => {
      // Build a canonical key from the file+line pairs embedded in the message
      const key = `${issue.file}:${issue.line}:${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
});

export default probabilityConsistencyRule;
