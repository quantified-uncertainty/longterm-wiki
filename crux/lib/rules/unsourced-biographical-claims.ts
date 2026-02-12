/**
 * Unsourced Biographical Claims Validation Rule
 *
 * Detects specific biographical claims in person/organization pages that lack
 * adjacent citations. People and organizations are particularly sensitive to
 * inaccuracies — factual errors about real people can be embarrassing and harmful.
 *
 * Targets claims like:
 *   - Dates of employment/founding ("joined X in 2019", "founded in 2015")
 *   - Educational credentials ("PhD from MIT", "studied at Oxford")
 *   - Specific roles/titles ("served as VP of Research")
 *   - Numeric facts ("raised $500M", "employs 1,200 people")
 *   - Awards/honors ("received the Turing Award")
 *
 * These are high-hallucination-risk claims that LLMs confidently generate
 * from training data without verification. Requiring citations for them
 * significantly reduces the risk of publishing incorrect biographical details.
 *
 * Only applies to pages under /people/ or /organizations/ paths.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

// Check if a page is a person or organization page based on its path
function isBiographicalPage(relativePath: string): boolean {
  return relativePath.includes('/people/') || relativePath.includes('/organizations/');
}

// Check if a line has a citation nearby (on the same line or within the same table row)
function hasCitation(line: string): boolean {
  // GFM footnotes: [^1], [^12]
  if (/\[\^\d+\]/.test(line)) return true;
  // <R id="..."> citation components
  if (/<R\s+id=/.test(line)) return true;
  // Inline markdown links to external URLs (common in tables)
  if (/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(line)) return true;
  return false;
}

// Biographical claim patterns that should have citations
// Each pattern is designed to catch specific factual claims about people/orgs
const BIOGRAPHICAL_CLAIM_PATTERNS: { pattern: RegExp; message: string }[] = [
  // Employment/role dates: "joined X in 2019", "left X in 2021", "from 2015 to 2020"
  {
    pattern: /\b(?:joined|left|departed|resigned from|was hired|appointed|became|served as|worked at)\b.*\b(?:in|since|from|during)\s+\d{4}\b/i,
    message: 'Employment/role date claim without citation — verify with primary source',
  },
  // Founding dates: "founded in 2015", "established in 2020", "co-founded X in"
  {
    pattern: /\b(?:founded|co-founded|established|launched|created|started|incorporated)\b.*\b(?:in|circa|around)\s+\d{4}\b/i,
    message: 'Founding date claim without citation — verify with official records',
  },
  // Education: "PhD from", "studied at", "degree from", "graduated from"
  {
    pattern: /\b(?:PhD|Ph\.D\.|doctorate|master'?s|bachelor'?s|degree|studied|graduated|attending|enrolled|alumnus|alumna|alumni)\b.*\b(?:from|at|in)\s+[A-Z]/i,
    message: 'Educational credential claim without citation — verify with institution or CV',
  },
  // Specific funding amounts: "raised $X", "received $X in funding", "$X valuation"
  {
    pattern: /\b(?:raised|received|secured|obtained|granted|allocated|valued at|valuation of)\b.*\\\?\$[\d,.]+[BMKbmk]?\b/i,
    message: 'Funding/valuation claim without citation — verify with financial records or announcements',
  },
  // Headcount/size: "employs X people", "X employees", "team of X"
  {
    pattern: /\b(?:employs?|hired?|staff of|team of|workforce of|headcount)\s+(?:approximately |roughly |about |over |more than |~)?\d{2,}/i,
    message: 'Headcount/size claim without citation — verify with company data',
  },
  // Awards/honors: "received the X Award", "won the X Prize", "awarded X"
  {
    pattern: /\b(?:received|won|awarded|honored with|given|granted)\s+(?:the\s+)?[A-Z][A-Za-z\s]+(?:Award|Prize|Medal|Fellowship|Grant|Honor)/i,
    message: 'Award/honor claim without citation — verify with awarding body',
  },
  // Board/advisory roles: "serves on the board of", "advisor to", "board member"
  {
    pattern: /\b(?:serves? on the board|board member|board of directors|advisory board|advisor to|counsel to)\b/i,
    message: 'Board/advisory role claim without citation — verify with organization',
  },
  // Publication/authorship: "authored X", "published X", "wrote X"
  {
    pattern: /\b(?:authored|co-authored|published|wrote|co-wrote)\b.*\b(?:paper|book|report|study|article|monograph)\b/i,
    message: 'Publication claim without citation — link to the actual publication',
  },
];

// Patterns for table rows with biographical data that lack source links
const TABLE_BIO_PATTERNS: { pattern: RegExp; message: string }[] = [
  // Year ranges in tables: "2015-2021", "2019-present"
  {
    pattern: /\|\s*\d{4}\s*[-–]\s*(?:\d{4}|present)\s*\|/i,
    message: 'Date range in table without source link — add citation for employment/involvement period',
  },
];

export const unsourcedBiographicalClaimsRule = {
  id: 'unsourced-biographical-claims',
  name: 'Unsourced Biographical Claims',
  description: 'Detect biographical facts about people/organizations that lack citations',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only apply to person/org pages
    if (!isBiographicalPage(contentFile.relativePath)) {
      return issues;
    }

    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');
    let inCodeBlock = false;
    let inTable = false;
    let tableHasSourceColumn = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip code blocks
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Skip imports and comments
      if (line.trim().startsWith('import ')) continue;
      if (line.trim().startsWith('<!--')) continue;
      // Skip headings (section titles aren't claims)
      if (line.trim().startsWith('#')) continue;
      // Skip footnote definitions
      if (/^\[\^\d+\]:/.test(line.trim())) continue;

      // Track table state
      if (line.includes('|') && !inTable) {
        inTable = true;
        tableHasSourceColumn = /source|reference/i.test(line);
      }
      if (inTable && !line.includes('|')) {
        inTable = false;
        tableHasSourceColumn = false;
      }

      // Skip table separator rows
      if (/^\|[\s\-:|]+\|$/.test(line)) continue;

      // If this line already has a citation, skip it
      if (hasCitation(line)) continue;

      // For table rows: if the table has a Source column, check if this row
      // has something in that column. If so, skip.
      if (inTable && tableHasSourceColumn) {
        // Tables with source columns are generally okay — the source column
        // provides citations. Only flag if it's empty/vague (covered by vague-citations rule).
        continue;
      }

      // Check prose biographical claims
      if (!inTable) {
        for (const { pattern, message } of BIOGRAPHICAL_CLAIM_PATTERNS) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) {
            issues.push(new Issue({
              rule: 'unsourced-biographical-claims',
              file: contentFile.path,
              line: lineNum,
              message: `${message}: "${line.trim().slice(0, 80)}..."`,
              severity: Severity.WARNING,
            }));
            break; // Only one warning per line
          }
        }
      }

      // Check table rows without source columns
      if (inTable && !tableHasSourceColumn) {
        for (const { pattern, message } of TABLE_BIO_PATTERNS) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) {
            issues.push(new Issue({
              rule: 'unsourced-biographical-claims',
              file: contentFile.path,
              line: lineNum,
              message: `${message}: "${line.trim().slice(0, 80)}..."`,
              severity: Severity.WARNING,
            }));
            break;
          }
        }
      }
    }

    return issues;
  },
};
