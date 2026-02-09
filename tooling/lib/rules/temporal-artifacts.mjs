/**
 * Temporal Artifacts Validation Rule
 *
 * Catches phrases that expose when research was conducted rather than
 * presenting information in a current/timeless manner.
 *
 * Bad: "As of the research data (through late 2024)..."
 * Good: "As of early 2026..." or "The convention remains in..."
 */

import { Severity, Issue } from '../validation-engine.mjs';

// Patterns that indicate synthesis artifacts exposing research timing
const TEMPORAL_ARTIFACT_PATTERNS = [
  {
    pattern: /as of (?:the |my |our )?research(?: data)?/gi,
    message: 'References research timing instead of presenting current information',
  },
  {
    pattern: /(?:based on|according to) (?:the |)?(?:available |)?(?:research |)?(?:data |)?(?:sources )?(?:from|through) (?:late |early |mid[- ])?\d{4}/gi,
    message: 'References when sources were gathered instead of current status',
  },
  {
    pattern: /in (?:the |)?(?:available |)?sources(?:,| )(?:no|limited|insufficient)/gi,
    message: 'References source limitations - should rephrase as factual uncertainty',
  },
  {
    pattern: /(?:the |)?research (?:indicates|shows|suggests|reveals) that as of/gi,
    message: 'Uses "research indicates" phrasing - should present facts directly',
  },
  {
    pattern: /no (?:information|data|details) (?:is |are |was |were )?(?:available|found) in (?:the |)?(?:available |)?sources/gi,
    message: 'References source limitations - should rephrase or omit',
  },
  {
    pattern: /(?:through|as of) (?:late|early|mid[- ])?\d{4}(?:,|\.|\)|])/gi,
    message: 'May expose research date - verify this is intentional (e.g., describing historical events is fine)',
    severity: 'warning',
  },
];

export const temporalArtifactsRule = {
  id: 'temporal-artifacts',
  name: 'Temporal Artifacts',
  description: 'Detect phrases that expose when research was conducted',
  severity: Severity.WARNING,

  check(contentFile, engine) {
    const issues = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      for (const { pattern, message, severity } of TEMPORAL_ARTIFACT_PATTERNS) {
        // Reset regex state
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'temporal-artifacts',
            file: contentFile.path,
            line: lineNum,
            message: `Temporal artifact: "${match[0]}" - ${message}`,
            severity: severity === 'warning' ? Severity.WARNING : Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
