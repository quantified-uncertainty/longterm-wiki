/**
 * Footnote Quality Validation Rule
 *
 * Detects systemic citation quality problems in knowledge-base pages:
 *   1. Unverified hedging — footnotes containing "could not be verified" etc.
 *   2. Wikipedia as source — footnotes linking to *.wikipedia.org
 *   3. Overloaded footnotes — single [^N] referenced 8+ times (catch-all sourcing)
 *   4. Generic/index URLs — footnotes pointing to domain roots or generic paths
 *
 * All sub-checks are WARNING severity (advisory, not CI-blocking).
 * Only applies to knowledge-base pages with 300+ prose words.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { shouldSkipValidation } from '../mdx-utils.ts';
import { countProseWords } from '../page-analysis.ts';

const MIN_WORDS = 300;

/** Threshold for overloaded footnote references */
const OVERLOADED_REF_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Hedging phrases that signal unverified content
// ---------------------------------------------------------------------------

const HEDGING_PHRASES = [
  'could not be verified',
  'could not be independently verified',
  'could not be independently confirmed',
  'could not be confirmed',
  'treated as reported',
  'not independently verified',
  'not independently confirmed',
  'unable to verify',
  'unable to confirm',
  'verification pending',
  'unverified',
];

// ---------------------------------------------------------------------------
// Generic URL path segments
// ---------------------------------------------------------------------------

const GENERIC_PATH_SEGMENTS = [
  '/press',
  '/news',
  '/about',
  '/blog',
  '/research',
  '/publications',
  '/media',
  '/newsroom',
];

// ---------------------------------------------------------------------------
// Footnote definition parser
// ---------------------------------------------------------------------------

interface FootnoteDef {
  num: number;
  line: number;       // 1-based line number in body
  text: string;       // full text including continuation lines
  urls: string[];     // extracted URLs
}

/**
 * Parse footnote definitions from body text, handling multi-line continuations.
 * Returns an array of FootnoteDef objects.
 */
function parseFootnoteDefs(body: string): FootnoteDef[] {
  const defs: FootnoteDef[] = [];
  const lines = body.split('\n');
  let inCodeBlock = false;

  let current: FootnoteDef | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      // Flush current def before toggling code block
      if (current) {
        current.urls = extractUrls(current.text);
        defs.push(current);
        current = null;
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const defMatch = /^\[\^(\d+)\]:\s*(.*)/.exec(trimmed);
    if (defMatch) {
      // Flush previous definition
      if (current) {
        current.urls = extractUrls(current.text);
        defs.push(current);
      }
      current = {
        num: parseInt(defMatch[1], 10),
        line: i + 1,
        text: defMatch[2],
        urls: [],
      };
    } else if (current && /^\s+\S/.test(line)) {
      // Continuation line (indented)
      current.text += ' ' + trimmed;
    } else {
      // End of footnote block
      if (current) {
        current.urls = extractUrls(current.text);
        defs.push(current);
        current = null;
      }
    }
  }

  // Flush final definition
  if (current) {
    current.urls = extractUrls(current.text);
    defs.push(current);
  }

  return defs;
}

/** Extract all URLs from text (both markdown links and bare URLs) */
function extractUrls(text: string): string[] {
  const urls: string[] = [];
  // Markdown links: [text](url)
  const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdLinkRe.exec(text)) !== null) {
    urls.push(match[2]);
  }
  // Bare URLs not inside markdown links
  const bareUrlRe = /https?:\/\/\S+/g;
  while ((match = bareUrlRe.exec(text)) !== null) {
    const url = match[0];
    // Skip if this URL was already captured as a markdown link
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Footnote reference counter
// ---------------------------------------------------------------------------

/**
 * Count how many times each [^N] is referenced in the body (excluding definition lines).
 */
function countFootnoteRefsByNum(body: string): Map<number, number> {
  const counts = new Map<number, number>();
  const pattern = /\[\^(\d+)\]/g;
  let inCodeBlock = false;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Skip footnote definition lines
    if (/^\[\^\d+\]:/.test(trimmed)) continue;

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const num = parseInt(match[1], 10);
      counts.set(num, (counts.get(num) ?? 0) + 1);
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export const footnoteQualityRule = {
  id: 'footnote-quality',
  name: 'Footnote Quality',
  description: 'Detect citation quality issues: hedging, Wikipedia sources, overloaded footnotes, generic URLs',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only knowledge-base pages
    if (!contentFile.relativePath.startsWith('knowledge-base/')) {
      return issues;
    }

    // Skip index, stubs, docs
    if (contentFile.isIndex || shouldSkipValidation(contentFile.frontmatter)) {
      return issues;
    }

    const body = contentFile.body || '';
    if (!body) return issues;

    const proseWords = countProseWords(body);
    if (proseWords < MIN_WORDS) return issues;

    const defs = parseFootnoteDefs(body);
    const refCounts = countFootnoteRefsByNum(body);

    // Sub-check 1: Unverified hedging
    for (const def of defs) {
      const lower = def.text.toLowerCase();
      for (const phrase of HEDGING_PHRASES) {
        if (lower.includes(phrase)) {
          issues.push(new Issue({
            rule: 'footnote-quality',
            file: contentFile.path,
            line: def.line,
            message: `Footnote [^${def.num}] contains unverified hedging: "${phrase}". Replace with a verifiable source or remove the claim.`,
            severity: Severity.WARNING,
          }));
          break; // one warning per footnote
        }
      }
    }

    // Sub-check 2: Wikipedia as source
    for (const def of defs) {
      const hasWikipedia = def.urls.some(url =>
        /wikipedia\.org/i.test(url)
      );
      if (hasWikipedia) {
        issues.push(new Issue({
          rule: 'footnote-quality',
          file: contentFile.path,
          line: def.line,
          message: `Footnote [^${def.num}] cites Wikipedia. Prefer primary sources or peer-reviewed references.`,
          severity: Severity.WARNING,
        }));
      }
    }

    // Sub-check 3: Overloaded footnotes
    for (const [num, count] of refCounts) {
      if (count >= OVERLOADED_REF_THRESHOLD) {
        // Find the definition line for this footnote (if it exists)
        const def = defs.find(d => d.num === num);
        issues.push(new Issue({
          rule: 'footnote-quality',
          file: contentFile.path,
          line: def?.line ?? 1,
          message: `Footnote [^${num}] is referenced ${count} times. Overloaded footnotes obscure which claim each citation supports. Split into specific per-claim citations.`,
          severity: Severity.WARNING,
        }));
      }
    }

    // Sub-check 4: Generic/index URLs
    for (const def of defs) {
      for (const url of def.urls) {
        if (isGenericUrl(url)) {
          issues.push(new Issue({
            rule: 'footnote-quality',
            file: contentFile.path,
            line: def.line,
            message: `Footnote [^${def.num}] points to a generic/index URL: ${url}. Link to the specific page, article, or document.`,
            severity: Severity.WARNING,
          }));
          break; // one warning per footnote
        }
      }
    }

    return issues;
  },
};

/**
 * Check if a URL is a generic/index URL (domain root or generic path).
 * Examples:
 *   - https://investors.asana.com → domain root
 *   - https://example.com/press → generic path
 *   - https://example.com/press/2024/release.html → NOT generic (has specific path)
 */
function isGenericUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, ''); // strip trailing slashes

    // Domain root (no path or just /)
    if (!path || path === '') return true;

    // Generic path: exactly one segment matching a known generic name
    for (const segment of GENERIC_PATH_SEGMENTS) {
      if (path === segment) return true;
    }

    return false;
  } catch {
    return false;
  }
}
