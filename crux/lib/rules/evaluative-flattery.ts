/**
 * Evaluative Flattery Validation Rule
 *
 * Detects flattering/ass-kissing language in person and organization pages.
 * Wiki pages should describe people and organizations neutrally, not praise them.
 *
 * This is a common LLM hallucination pattern: models tend to describe people
 * in glowing terms ("prominent researcher", "exceptional track record",
 * "demonstrated competitive excellence") even when the source material
 * doesn't support such characterizations.
 *
 * Real-world feedback: "It sounds a bit ass-kissing, e.g. 'demonstrated
 * exceptional forecasting accuracy', 'demonstrated competitive excellence
 * in multiple domains'" — Eli Lifland on his own wiki page
 *
 * Only applies to pages under /people/ or /organizations/ paths.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

function isBiographicalPage(relativePath: string): boolean {
  return relativePath.includes('/people/') || relativePath.includes('/organizations/');
}

const FLATTERY_PATTERNS: { pattern: RegExp; message: string }[] = [
  // "prominent X" — implies stature without evidence
  {
    pattern: /\b(?:prominent|renowned|distinguished|acclaimed|celebrated|eminent|preeminent|leading|notable|influential)\s+(?:researcher|scientist|scholar|thinker|figure|voice|advocate|leader|expert|practitioner|economist|philosopher|writer|author|engineer|developer)/gi,
    message: 'Evaluative label — describe specific achievements instead of using stature adjectives',
  },
  // "demonstrated exceptional/remarkable X"
  {
    pattern: /\bdemonstrated\s+(?:exceptional|remarkable|outstanding|extraordinary|impressive|stellar|excellent|superior|world-class)/gi,
    message: 'Flattering characterization — state the specific evidence instead',
  },
  // "competitive excellence" / "analytical excellence"
  {
    pattern: /\b(?:competitive|analytical|technical|intellectual|academic|forecasting|research)\s+excellence\b/gi,
    message: 'Vague praise ("excellence") — describe the specific accomplishment with data',
  },
  // "known for X" without citation (common hallucination)
  {
    pattern: /\b(?:known for|recognized for|celebrated for|famous for|renowned for)\s+(?:his|her|their|its)\b/gi,
    message: '"Known for X" is often hallucinated — cite a specific source or remove',
  },
  // "exceptional/remarkable/outstanding track record"
  {
    pattern: /\b(?:exceptional|remarkable|outstanding|extraordinary|impressive|stellar|unparalleled|unmatched|proven)\s+(?:track record|accuracy|performance|results|capabilities|contributions)/gi,
    message: 'Evaluative characterization — use specific numbers/data instead of superlatives',
  },
  // "world-leading" / "industry-leading" / "best-in-class"
  {
    pattern: /\b(?:world-leading|industry-leading|best-in-class|state-of-the-art|cutting-edge|groundbreaking|pioneering|trailblazing)\b/gi,
    message: 'Superlative characterization — describe the specific innovation or achievement',
  },
  // "visionary" / "thought leader" / "luminary"
  {
    pattern: /\b(?:visionary|thought leader|luminary|trailblazer|pioneer|titan|powerhouse|mastermind)\b/gi,
    message: 'Hagiographic language — describe what the person actually did, not their reputation',
  },
  // "has made significant/important/major contributions"
  {
    pattern: /\bhas\s+made\s+(?:significant|important|major|substantial|key|critical|vital|invaluable|tremendous)\s+contributions\b/gi,
    message: 'Vague praise — name the specific contributions instead',
  },
  // "one of the most X" — often unverifiable
  {
    pattern: /\bone of the (?:most|leading|top|foremost|premier|best|greatest)\b/gi,
    message: '"One of the most X" is often unverifiable — cite a ranking or describe specifics',
  },
  // "widely respected" / "highly regarded" / "well-known"
  {
    pattern: /\b(?:widely|highly|well|greatly|deeply|universally)\s+(?:respected|regarded|admired|valued|trusted|esteemed)\b/gi,
    message: 'Reputation claim without evidence — cite specific recognition or remove',
  },
  // "helpful, kind, and receptive" — character descriptions without sources
  {
    pattern: /\b(?:community members|colleagues|peers|others)\s+(?:describe|consider|regard|view)\s+(?:him|her|them)\s+as\b/gi,
    message: 'Unsourced character description — cite specific testimony or remove',
  },
];

export const evaluativeFlattery = {
  id: 'evaluative-flattery',
  name: 'Evaluative Flattery',
  description: 'Detect flattering/ass-kissing language about people and organizations',
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
      if (line.trim().startsWith('#')) continue;
      // Skip footnote definitions
      if (/^\[\^\d+\]:/.test(line.trim())) continue;

      for (const { pattern, message } of FLATTERY_PATTERNS) {
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'evaluative-flattery',
            file: contentFile.path,
            line: lineNum,
            message: `Flattery: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
