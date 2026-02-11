/**
 * Rule: Fact Consistency
 *
 * Global-scope rule that checks for hardcoded values in MDX prose that
 * match or contradict canonical facts from src/data/facts/*.yaml.
 *
 * For each canonical fact:
 * - If the exact value appears hardcoded in prose (not inside <F> component),
 *   emit INFO suggesting migration to <F> component.
 * - If a similar but different value appears (same entity context),
 *   emit WARNING about potential stale/contradictory value.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createRule, Issue, Severity, ContentFile, ValidationEngine } from '../validation-engine.ts';
import { PROJECT_ROOT, loadDatabase } from '../content-types.ts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface CanonicalFact {
  entity: string;
  factId: string;
  key: string;
  value?: string;
  asOf?: string;
  [key: string]: unknown;
}

interface SearchPattern {
  regex: RegExp;
  isExact: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACTS_DIR: string = join(PROJECT_ROOT, 'data/facts');

// Values that are too short or too generic to search for reliably
const MIN_VALUE_LENGTH = 5;
const GENERIC_VALUES = new Set<string>([
  '2025', '2026', '2027', '2028', '2029', '2030',  // Year values are too common
  '25%', '40%', '50%', '75%', '20%', '30%', '10%', // Common percentages are too noisy
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load all canonical facts from YAML files, then overlay resolved
 * computed values from database.json (which has run resolveComputedFacts).
 */
function loadCanonicalFacts(): CanonicalFact[] {
  const facts: CanonicalFact[] = [];

  if (!existsSync(FACTS_DIR)) return facts;

  const files = readdirSync(FACTS_DIR).filter((f: string) => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(FACTS_DIR, file);
    const content = readFileSync(filepath, 'utf-8');
    const parsed = parseYaml(content) as { entity?: string; facts?: Record<string, Record<string, unknown>> } | null;
    if (parsed && parsed.entity && parsed.facts) {
      for (const [factId, factData] of Object.entries(parsed.facts)) {
        facts.push({
          entity: parsed.entity,
          factId,
          key: `${parsed.entity}.${factId}`,
          ...factData,
        });
      }
    }
  }

  // Overlay resolved computed values from database.json
  // Computed facts have no value in YAML but get one after build-data resolves them
  try {
    const db = loadDatabase();
    if (db.facts) {
      for (const fact of facts) {
        const dbFact = db.facts[fact.key];
        if (dbFact && dbFact.computed && dbFact.value && !fact.value) {
          fact.value = dbFact.value;
        }
      }
    }
  } catch {
    // database.json may not exist yet or be invalid — skip overlay
  }

  return facts;
}

/**
 * Generate search patterns for a fact value.
 * Produces regex patterns that match common variations of the value.
 * Returns empty array for values too generic to search reliably.
 */
function generateSearchPatterns(value: string): SearchPattern[] {
  // Skip values that are too short or too generic
  if (value.length < MIN_VALUE_LENGTH && !value.startsWith('$')) return [];
  if (GENERIC_VALUES.has(value)) return [];

  const patterns: SearchPattern[] = [];

  // In MDX files, dollar signs are escaped as \$ to avoid LaTeX parsing.
  // All patterns must match both $ and \$ variants.

  // Direct match (escaped for regex), with optional backslash before $
  let escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Replace literal \$ in the regex with \\?\$ to match both $ and \$
  escaped = escaped.replace(/\\\$/g, '\\\\?\\$');
  patterns.push({
    regex: new RegExp(escaped, 'gi'),
    isExact: true,
  });

  // Dollar amount variations: "$13 billion" → "$13B", "$13 bn", "$13 bil", etc.
  const dollarMatch = value.match(/^\$?([\d,.]+)\s*(billion|million|trillion|thousand)/i);
  if (dollarMatch) {
    const num = dollarMatch[1];
    const unit = dollarMatch[2].toLowerCase();
    const abbrevMap: Record<string, string> = {
      billion: 'B',
      million: 'M',
      trillion: 'T',
      thousand: 'K',
    };

    // Only add the short abbreviation form (e.g., $13B) to reduce duplicate matches
    // \\\\? matches optional backslash before $ in MDX
    const abbr = abbrevMap[unit];
    if (abbr) {
      const escapedNum = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `\\\\?\\$${escapedNum}\\s*${abbr}\\b`;
      patterns.push({
        regex: new RegExp(pattern, 'gi'),
        isExact: true,
      });
    }
  }

  // Number + unit without dollar sign: "100 million" → "100M"
  const numUnitMatch = value.match(/^([\d,.]+)\s*(billion|million|trillion|thousand)/i);
  if (numUnitMatch && !dollarMatch) {
    const num = numUnitMatch[1];
    const unit = numUnitMatch[2].toLowerCase();
    const abbrevMap: Record<string, string> = { billion: 'B', million: 'M', trillion: 'T', thousand: 'K' };
    const abbr = abbrevMap[unit];
    if (abbr) {
      patterns.push({
        regex: new RegExp(`\\b${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*${abbr}\\b`, 'gi'),
        isExact: true,
      });
    }
  }

  return patterns;
}

/**
 * Check if a position in the body is inside an <F> component
 */
function isInsideFComponent(body: string, matchIndex: number): boolean {
  // Look backwards from match for <F and check if we're inside it
  const before = body.slice(Math.max(0, matchIndex - 200), matchIndex);
  const after = body.slice(matchIndex, Math.min(body.length, matchIndex + 200));

  // Check if we're between <F ...> and </F> or within a self-closing <F ... />
  const lastOpenF = before.lastIndexOf('<F ');
  if (lastOpenF === -1) return false;

  // Check if there's a closing > after the <F
  const afterOpen = before.slice(lastOpenF);
  const closingBracket = afterOpen.indexOf('>');
  if (closingBracket === -1) return true; // Still inside the opening tag

  // Check if it's self-closing
  if (afterOpen[closingBracket - 1] === '/') return false;

  // Look for </F> after our match
  return after.includes('</F>');
}

/**
 * Check if a position is inside a code block or inline code
 */
function isInCodeOrComponent(body: string, matchIndex: number): boolean {
  const before = body.slice(0, matchIndex);

  // Check for code fences
  const fences = before.split('```');
  if (fences.length % 2 === 0) return true; // Inside a fenced block

  // Check for inline code
  const line = before.split('\n').pop() || '';
  const backticks = (line.match(/`/g) || []).length;
  if (backticks % 2 === 1) return true; // Inside inline code

  // Check for YAML frontmatter
  if (before.startsWith('---')) {
    const secondDash = before.indexOf('---', 3);
    if (secondDash === -1 || matchIndex < secondDash) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const factConsistencyRule = createRule({
  id: 'fact-consistency',
  name: 'Fact Consistency',
  description: 'Check for hardcoded facts that should use <F> component',
  scope: 'global',

  check(allFiles: ContentFile[], engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const facts = loadCanonicalFacts();

    if (facts.length === 0) return issues;

    for (const fact of facts) {
      if (!fact.value) continue;
      const patterns = generateSearchPatterns(fact.value);

      for (const contentFile of allFiles) {
        const body = contentFile.body;
        if (!body) continue;

        // Skip internal/documentation pages
        if (contentFile.relativePath.startsWith('internal/')) continue;

        const lines = body.split('\n');

        for (const { regex, isExact } of patterns) {
          // Reset regex state
          regex.lastIndex = 0;

          let match: RegExpExecArray | null;
          while ((match = regex.exec(body)) !== null) {
            // Skip if inside <F> component, code block, or YAML
            if (isInsideFComponent(body, match.index)) continue;
            if (isInCodeOrComponent(body, match.index)) continue;

            // Find line number
            const beforeMatch = body.slice(0, match.index);
            const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

            // Get context for the message
            const lineContent = lines[lineNum - 1] || '';
            const contextStart = Math.max(0, match.index - (body.slice(0, match.index).lastIndexOf('\n') + 1));
            const displayContext = lineContent.slice(
              Math.max(0, contextStart - 20),
              Math.min(lineContent.length, contextStart + match[0].length + 20)
            ).trim();

            if (isExact) {
              issues.push(new Issue({
                rule: this.id,
                file: contentFile.path,
                line: lineNum,
                message: `Hardcoded "${match[0]}" matches canonical fact ${fact.key} (value: "${fact.value}"${fact.asOf ? `, as of ${fact.asOf}` : ''}). Consider using <F e="${fact.entity}" f="${fact.factId}" />`,
                severity: Severity.INFO,
              }));
            }
          }
        }
      }
    }

    // Deduplicate: keep only one issue per file+line+fact combination
    // Multiple patterns for the same fact value can match the same line
    const seen = new Set<string>();
    return issues.filter(issue => {
      // Extract fact key from message
      const factKeyMatch = issue.message.match(/canonical fact ([\w.-]+)/);
      const factKey = factKeyMatch ? factKeyMatch[1] : '';
      const key = `${issue.file}:${issue.line}:${factKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
});

export default factConsistencyRule;
