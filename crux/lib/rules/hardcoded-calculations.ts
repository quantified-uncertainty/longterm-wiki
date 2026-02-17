/**
 * Rule: Hardcoded Calculations
 *
 * Detects hardcoded derived values (ratios, multiples, fold-changes) in MDX
 * prose that could use the <Calc> component to stay in sync with canonical facts.
 *
 * Advisory (INFO level) — flags patterns like "≈27x revenue", "390x cost
 * reduction", "3.8:1 ratio" and suggests using <Calc> instead.
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { isInCodeBlock } from '../mdx-utils.ts';

// Patterns that suggest a hardcoded calculated/derived value.
// Each has a regex and a human-readable description of what it matches.
const CALC_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  // "≈27x" or "~42x" or "approximately 27x" — hardcoded multiples
  {
    regex: /[≈~∼][\s]*\d+(?:\.\d+)?x\b/g,
    description: 'approximate multiple (≈Nx)',
  },
  // "27x revenue" / "42x earnings" / "15x multiple" — named multiples
  {
    regex: /\b\d+(?:\.\d+)?x\s+(?:revenue|earnings|multiple|valuation|salary|cost|faster|cheaper|more|growth|increase)/gi,
    description: 'named multiple (Nx revenue/cost/...)',
  },
  // "390x cost reduction" / "500-fold" / "300-fold" — fold changes
  {
    regex: /\b\d+(?:\.\d+)?(?:x|-fold)\s+(?:reduction|expansion|increase|improvement|growth|decrease|drop)/gi,
    description: 'fold change',
  },
  // "N:1 ratio" or "N:1 gap"
  {
    regex: /\b\d+(?:\.\d+)?:\d+\s+(?:ratio|gap|split)/gi,
    description: 'ratio (N:1)',
  },
];

// Skip matches inside these contexts
function isInsideCalcOrF(body: string, matchIndex: number): boolean {
  const before = body.slice(Math.max(0, matchIndex - 300), matchIndex);
  // Inside <Calc ...> ... </Calc> or self-closing <Calc ... />
  if (before.includes('<Calc ') && !before.includes('/>') && !before.includes('</Calc>')) return true;
  // Inside <F ...> ... </F>
  const lastF = before.lastIndexOf('<F ');
  if (lastF !== -1) {
    const afterF = before.slice(lastF);
    if (!afterF.includes('</F>') && !afterF.includes('/>')) return true;
  }
  return false;
}

export const hardcodedCalculationsRule = createRule({
  id: 'hardcoded-calculations',
  name: 'Hardcoded Calculations',
  description: 'Detect hardcoded derived values that could use <Calc>',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = content.body;
    if (!body) return issues;

    // Skip internal pages
    if (content.relativePath.startsWith('internal/')) return issues;

    const lines = body.split('\n');

    for (const { regex, description } of CALC_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(body)) !== null) {
        if (isInCodeBlock(body, match.index)) continue;
        if (isInsideCalcOrF(body, match.index)) continue;

        // Find line number
        const beforeMatch = body.slice(0, match.index);
        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

        // Skip if inside a table header row (|---|)
        const line = lines[lineNum - 1] || '';
        if (/^\|[\s-|]+\|$/.test(line)) continue;

        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: lineNum,
          message: `Hardcoded ${description}: "${match[0].trim()}". Consider using <Calc expr="..."> for derived values that should stay in sync with facts.`,
          severity: Severity.INFO,
        }));
      }
    }

    // Deduplicate by file+line
    const seen = new Set<string>();
    return issues.filter(issue => {
      const key = `${issue.file}:${issue.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
});

export default hardcodedCalculationsRule;
