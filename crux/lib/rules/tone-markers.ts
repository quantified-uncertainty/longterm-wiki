/**
 * Tone Markers Validation Rule
 *
 * Catches subtle language patterns that break analytical tone:
 * surprise markers, emphasis words, loaded language, and correction artifacts.
 *
 * Bad: "Interestingly, the data shows..." or "In fact, the cost is lower"
 * Good: "The data shows..." or "The cost is lower than commonly assumed"
 *
 * These patterns are intentionally narrow to reduce false positives.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

const TONE_MARKER_PATTERNS: { pattern: RegExp; message: string }[] = [
  // "actually" as emphasis/correction (not "actually implemented" or in quotes)
  {
    pattern: /\bactually\b(?!\s+(?:implemented|built|created|developed|deployed|launched|published|released))/gi,
    message: 'Tone marker: "actually" signals surprise or correction — state the fact directly',
  },
  // "interestingly" / "surprisingly" / "remarkably" — editorializing
  {
    pattern: /\b(?:interestingly|surprisingly|remarkably|strikingly|fascinatingly)\b/gi,
    message: 'Tone marker: editorializing adverb — let the reader judge whether it\'s interesting',
  },
  // "in fact" as emphasis
  {
    pattern: /\bin fact\b/gi,
    message: 'Tone marker: "in fact" implies correction of a misconception — state the fact directly',
  },
  // "it turns out" — surprise framing
  {
    pattern: /\bit turns out\b/gi,
    message: 'Tone marker: "it turns out" implies discovery during writing — present as established fact',
  },
  // "contrary to what you might think/expect"
  {
    pattern: /\bcontrary to (?:what (?:you|one|many|most people) might (?:think|expect|assume|believe))/gi,
    message: 'Tone marker: implies reader had wrong assumption — present the information directly',
  },
  // "a common misconception is" (when not about a genuine widespread misconception)
  {
    pattern: /\ba common (?:misconception|misunderstanding|mistake|error) is\b/gi,
    message: 'Possible correction artifact: verify this addresses a genuine public misconception, not the page\'s own earlier framing',
  },
  // "not just X, but Y" — correction pattern
  {
    pattern: /\bnot just\b.*\bbut (?:also|rather)\b/gi,
    message: 'Possible correction artifact: "not just X, but Y" may reveal scope expansion from editing — present Y directly',
  },
  // "importantly" / "significantly" / "notably" as value-smuggling
  {
    pattern: /(?:^|\.\s+)(?:importantly|significantly|notably|crucially|critically),?\s/gim,
    message: 'Tone marker: editorializing opener — let the content demonstrate importance',
  },
  // "to be clear" — suggests prior confusion
  {
    pattern: /\bto be clear\b/gi,
    message: 'Tone marker: "to be clear" implies prior ambiguity — restructure for clarity instead',
  },
  // "the key insight/takeaway/point is" — tells instead of shows
  {
    pattern: /\bthe (?:key|main|central|critical|important|crucial) (?:insight|takeaway|point|lesson|finding) (?:is|here is)\b/gi,
    message: 'Tone marker: "the key insight is" — structure the content so the insight is self-evident',
  },
];

export const toneMarkersRule = {
  id: 'tone-markers',
  name: 'Tone Markers',
  description: 'Detect surprise markers, emphasis words, and correction artifacts that break analytical tone',
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

      for (const { pattern, message } of TONE_MARKER_PATTERNS) {
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'tone-markers',
            file: contentFile.path,
            line: lineNum,
            message: `Tone marker: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
