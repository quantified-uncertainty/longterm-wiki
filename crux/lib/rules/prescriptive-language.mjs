/**
 * Prescriptive Language Validation Rule
 *
 * Catches language that advocates rather than analyzes. Wiki content should
 * describe and analyze; prescriptions should be attributed to specific actors.
 *
 * Bad: "We should push for stronger regulation"
 * Good: "Proponents argue for stronger regulation because..."
 *
 * These patterns target prescriptive framing in analytical content.
 */

import { Severity, Issue } from '../validation-engine.js';

const PRESCRIPTIVE_PATTERNS = [
  // "should" / "must" / "need to" in analytical voice (not in quotes or attributions)
  {
    pattern: /(?:^|\.\s+)(?:We|Organizations?|Policymakers?|Governments?|Researchers?|The (?:field|sector|industry))\s+(?:should|must|need to|ought to)\b/gm,
    message: 'Prescriptive language in analytical context — attribute the recommendation or reframe as analysis',
  },
  // "it is imperative" / "it is essential" / "it is critical" as advocacy
  {
    pattern: /\bit is (?:imperative|essential|critical|crucial|vital|urgent) (?:that|to)\b/gi,
    message: 'Prescriptive framing: "it is imperative..." — reframe as analysis of why something matters',
  },
  // "we must act" / "action is needed" / "we need to act"
  {
    pattern: /\b(?:we must act|action is (?:needed|required|necessary)|we need to act)\b/gi,
    message: 'Advocacy language: reframe as analysis of what various actors could do and why',
  },
  // Self-importance: "this is the canonical/definitive/comprehensive source"
  {
    pattern: /\bthis (?:is |provides |offers )?(?:the )?(?:canonical|definitive|comprehensive|authoritative|complete|exhaustive) (?:source|guide|reference|overview|analysis|treatment)\b/gi,
    message: 'Self-importance: describe what the page covers, not how authoritative it is',
  },
  // "rigorous analysis" / "careful analysis" when self-referential (requires "this/our/the following")
  {
    pattern: /\b(?:this |our |the following )(?:rigorous|careful|thorough|detailed|in-depth|exhaustive) analysis\b/gi,
    message: 'Self-importance: let the analysis speak for itself — remove self-describing adjectives',
  },
  // "the right approach" / "the correct response" — implies one answer
  {
    pattern: /\bthe (?:right|correct|proper|appropriate|best) (?:approach|response|solution|strategy|answer)\b/gi,
    message: 'Prescriptive framing: "the right approach" implies a single correct answer — present tradeoffs instead',
  },
  // "failure to X will Y" — threat framing
  {
    pattern: /\bfailure to (?:\w+ ){1,3}will (?:lead|result|cause|mean)\b/gi,
    message: 'Threat framing: "failure to X will Y" — reframe as risk analysis with probabilities',
  },
  // "cannot afford to" / "can't afford to" as advocacy
  {
    pattern: /\b(?:cannot|can't|can not) afford to\b/gi,
    message: 'Advocacy language: "cannot afford to" — reframe as analysis of consequences',
  },
];

export const prescriptiveLanguageRule = {
  id: 'prescriptive-language',
  name: 'Prescriptive Language',
  description: 'Detect advocacy and prescriptive framing where analysis is expected',
  severity: Severity.WARNING,

  check(contentFile, engine) {
    const issues = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      if (line.trim().startsWith('import ')) continue;
      if (line.trim().startsWith('<!--')) continue;
      if (line.trim().startsWith('#')) continue; // Skip headings

      for (const { pattern, message } of PRESCRIPTIVE_PATTERNS) {
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'prescriptive-language',
            file: contentFile.path,
            line: lineNum,
            message: `Prescriptive language: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
