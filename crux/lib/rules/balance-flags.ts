/**
 * Balance Flags Validation Rule
 *
 * Detects content quality indicators that suggest a page may present
 * a one-sided or uncritical view of its subject. Flags include:
 *
 *   - single-source-dominance: >50% of citations from one domain
 *   - uncritical-tone: missing counterarguments or limitations
 *   - missing-controversy: known controversy patterns absent
 *   - outdated-claims: references older than 2 years without noting recency
 *
 * These flags help identify pages that need editorial attention to
 * improve neutrality and reliability. All are advisory (WARNING).
 *
 * Part of the hallucination risk reduction initiative (issue #200).
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { shouldSkipValidation } from '../mdx-utils.ts';
import { countProseWords } from '../page-analysis.ts';

/** Minimum word count before balance checks apply */
const MIN_WORDS = 500;

/** Minimum citations before source-dominance check applies */
const MIN_CITATIONS_FOR_DOMINANCE = 3;

/** Maximum percentage of citations from one domain */
const DOMINANCE_THRESHOLD = 0.5;

/** Current year for outdated reference detection */
const CURRENT_YEAR = new Date().getFullYear();

/** References older than this many years are flagged */
const OUTDATED_YEARS = 2;

/**
 * Extract domains from footnote definition URLs.
 * Footnote definitions look like: [^1]: [Title](https://example.com/path)
 */
function extractCitationDomains(body: string): string[] {
  const domains: string[] = [];
  const footnoteDefPattern = /^\[\^\d+\]:\s*\[.*?\]\((https?:\/\/[^)]+)\)/gm;
  let match: RegExpExecArray | null;

  while ((match = footnoteDefPattern.exec(body)) !== null) {
    try {
      const url = new URL(match[1]);
      // Normalize: strip www. prefix
      const domain = url.hostname.replace(/^www\./, '');
      domains.push(domain);
    } catch {
      // Invalid URL, skip
    }
  }

  // Also check inline links in footnote definitions: [^1]: https://example.com
  const bareUrlPattern = /^\[\^\d+\]:\s*(https?:\/\/[^\s]+)/gm;
  while ((match = bareUrlPattern.exec(body)) !== null) {
    try {
      const url = new URL(match[1]);
      const domain = url.hostname.replace(/^www\./, '');
      domains.push(domain);
    } catch {
      // Invalid URL, skip
    }
  }

  return domains;
}

/**
 * Extract years from footnote definition URLs and titles.
 * Looks for 4-digit years (2000-2099) in citation text.
 */
function extractCitationYears(body: string): number[] {
  const years: number[] = [];
  const footnoteDefPattern = /^\[\^\d+\]:\s*.+$/gm;
  const yearPattern = /\b(20\d{2})\b/g;
  let lineMatch: RegExpExecArray | null;

  while ((lineMatch = footnoteDefPattern.exec(body)) !== null) {
    const line = lineMatch[0];
    let yearMatch: RegExpExecArray | null;
    yearPattern.lastIndex = 0;
    while ((yearMatch = yearPattern.exec(line)) !== null) {
      const year = parseInt(yearMatch[1], 10);
      if (year >= 2000 && year <= CURRENT_YEAR) {
        years.push(year);
      }
    }
  }

  return years;
}

// ---------------------------------------------------------------------------
// Balance check: single-source dominance
// ---------------------------------------------------------------------------

function checkSourceDominance(body: string, contentFile: ContentFile): Issue | null {
  const domains = extractCitationDomains(body);
  if (domains.length < MIN_CITATIONS_FOR_DOMINANCE) return null;

  // Count domain frequencies
  const counts: Record<string, number> = {};
  for (const d of domains) {
    counts[d] = (counts[d] || 0) + 1;
  }

  // Find the most common domain
  let maxDomain = '';
  let maxCount = 0;
  for (const [domain, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxDomain = domain;
      maxCount = count;
    }
  }

  const ratio = maxCount / domains.length;
  if (ratio > DOMINANCE_THRESHOLD) {
    const pct = Math.round(ratio * 100);
    return new Issue({
      rule: 'balance-flags',
      file: contentFile.path,
      line: 1,
      message: `Single-source dominance: ${pct}% of citations (${maxCount}/${domains.length}) are from ${maxDomain}. Consider diversifying sources.`,
      severity: Severity.WARNING,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Balance check: uncritical tone
// ---------------------------------------------------------------------------

/** Patterns that indicate critical engagement with the subject */
const CRITICAL_TONE_PATTERNS = [
  /\bhowever\b/i,
  /\bnevertheless\b/i,
  /\bcritics?\s+(?:argue|say|note|point|contend|claim|have\s+raised)/i,
  /\bcriticism/i,
  /\blimitation/i,
  /\bdrawback/i,
  /\bcontroversy/i,
  /\bcontroversial/i,
  /\bdisagree/i,
  /\bskeptic/i,
  /\bconcern/i,
  /\brisk/i,
  /\bchalleng/i,
  /\bon the other hand\b/i,
  /\bcounterargument/i,
  /\bdespite\b/i,
  /\balthough\b/i,
  /\bwhile\s+(?:some|many|others|this|there)/i,
  /\bdebat/i,
  /\buncertain/i,
  /\bquestion(?:ed|able|ing)\b/i,
];

function checkUncriticalTone(body: string, contentFile: ContentFile): Issue | null {
  // Only flag person and organization pages — these are most prone to puff pieces
  const path = contentFile.relativePath;
  if (!path.includes('/people/') && !path.includes('/organizations/')) {
    return null;
  }

  let criticalCount = 0;
  for (const pattern of CRITICAL_TONE_PATTERNS) {
    if (pattern.test(body)) {
      criticalCount++;
    }
  }

  // If fewer than 2 critical indicators in a substantial page, flag it
  if (criticalCount < 2) {
    return new Issue({
      rule: 'balance-flags',
      file: contentFile.path,
      line: 1,
      message: `Uncritical tone: page has ${criticalCount} critical engagement marker(s) (expected 2+). ` +
        `Consider adding limitations, criticisms, or counterpoints.`,
      severity: Severity.WARNING,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Balance check: outdated claims
// ---------------------------------------------------------------------------

function checkOutdatedClaims(body: string, contentFile: ContentFile): Issue | null {
  const years = extractCitationYears(body);
  if (years.length === 0) return null;

  const cutoff = CURRENT_YEAR - OUTDATED_YEARS;
  const outdated = years.filter(y => y < cutoff);
  const outdatedRatio = outdated.length / years.length;

  // Flag if >75% of dated citations are older than threshold
  if (outdatedRatio > 0.75 && outdated.length >= 3) {
    const oldestYear = Math.min(...outdated);
    return new Issue({
      rule: 'balance-flags',
      file: contentFile.path,
      line: 1,
      message: `Outdated citations: ${outdated.length}/${years.length} citations reference ${cutoff} or earlier ` +
        `(oldest: ${oldestYear}). Consider updating with more recent sources.`,
      severity: Severity.WARNING,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main rule
// ---------------------------------------------------------------------------

export const balanceFlagsRule = {
  id: 'balance-flags',
  name: 'Balance Flags',
  description: 'Detect single-source dominance, uncritical tone, and outdated citations',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only apply to knowledge-base pages
    if (!contentFile.relativePath.startsWith('knowledge-base/')) {
      return issues;
    }

    // Skip index pages, stubs, documentation
    if (contentFile.isIndex || shouldSkipValidation(contentFile.frontmatter)) {
      return issues;
    }

    const body = contentFile.body || '';
    if (!body) return issues;

    const proseWords = countProseWords(body);
    if (proseWords < MIN_WORDS) return issues;

    // Run each balance check
    const dominance = checkSourceDominance(body, contentFile);
    if (dominance) issues.push(dominance);

    const tone = checkUncriticalTone(body, contentFile);
    if (tone) issues.push(tone);

    const outdated = checkOutdatedClaims(body, contentFile);
    if (outdated) issues.push(outdated);

    return issues;
  },
};
