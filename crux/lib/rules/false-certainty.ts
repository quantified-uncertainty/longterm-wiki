/**
 * False Certainty Validation Rule
 *
 * Catches language that presents uncertain information as definitive facts,
 * including point estimates without ranges and absolutist language.
 *
 * Bad: "True Cost: $500K", "clearly the best approach", "obviously wrong"
 * Good: "Estimated cost: $300K–$800K", "appears to be effective", "likely incorrect"
 *
 * These patterns target false certainty in analytical content.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.js';

const FALSE_CERTAINTY_PATTERNS = [
  // "True Cost:" / "True Value:" / "Realistic EV:" — false precision labels
  {
    pattern: /\b(?:True|Actual|Real|Realistic)\s+(?:Cost|Value|EV|Expected Value|Impact|Benefit):/gi,
    message: 'False certainty label — use "Estimated" or include a range',
  },
  // "clearly" as emphasis (not "clearly stated" or "clearly visible")
  {
    pattern: /\bclearly\b(?!\s+(?:stated|written|visible|marked|labeled|defined|documented|shown|displayed))/gi,
    message: 'False certainty: "clearly" implies obviousness — state the evidence instead',
  },
  // "obviously" as emphasis
  {
    pattern: /\bobviously\b/gi,
    message: 'False certainty: "obviously" dismisses need for evidence — show the reasoning',
  },
  // "certainly" / "undoubtedly" / "without question" / "without doubt"
  {
    pattern: /\b(?:certainly|undoubtedly|unquestionably|indisputably|without (?:question|doubt))\b/gi,
    message: 'False certainty: use hedged language ("likely", "probably", "strong evidence suggests")',
  },
  // "will" for uncertain future predictions (not in quotes, not "will be able to" in known capabilities)
  {
    pattern: /\bthis will (?:lead|result|cause|create|produce|generate|drive|enable)\b/gi,
    message: 'False certainty about future: "this will..." — use "this could/may/is likely to..."',
  },
  // "is guaranteed" / "guaranteed to"
  {
    pattern: /\b(?:is |are )?guaranteed(?: to)?\b/gi,
    message: 'False certainty: very few things are "guaranteed" — qualify the claim',
  },
  // "the only way" / "the only option" / "the only approach"
  {
    pattern: /\bthe only (?:way|option|approach|solution|path|method)\b/gi,
    message: 'False certainty: "the only X" is rarely true — qualify or present alternatives',
  },
  // "it is clear that" / "it is obvious that"
  {
    pattern: /\bit is (?:clear|obvious|evident|apparent|plain) that\b/gi,
    message: 'False certainty: state the evidence directly rather than asserting clarity',
  },
];

export const falseCertaintyRule = {
  id: 'false-certainty',
  name: 'False Certainty',
  description: 'Detect language that presents uncertain information as definitive',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
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

      for (const { pattern, message } of FALSE_CERTAINTY_PATTERNS) {
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'false-certainty',
            file: contentFile.path,
            line: lineNum,
            message: `False certainty: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
