/**
 * Rule: URL Safety Check
 *
 * Validates that URLs in external-links.yaml don't contain shell metacharacters
 * that could cause injection when passed to shell commands (e.g., via execSync).
 *
 * Dangerous characters: $, `, ", \, ;, |, &, (, ), {, }, <, >, newlines
 *
 * This is a defense-in-depth measure — code should also use execFileSync
 * instead of execSync, but data validation catches issues earlier.
 */

import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { PROJECT_ROOT } from '../content-types.ts';

const EXTERNAL_LINKS_YAML = join(PROJECT_ROOT, 'data/external-links.yaml');

// Characters that are dangerous in shell contexts (even inside double quotes)
const SHELL_METACHAR_RE = /[`"\\;|&{}<>\n\r]/;
// Dollar sign followed by alphanumeric or parenthesis (shell variable expansion)
const SHELL_VARIABLE_RE = /\$[a-zA-Z0-9_(]/;

interface ExternalLinkEntry {
  pageId: string;
  links: Record<string, string>;
}

export const urlSafetyRule = createRule({
  id: 'url-safety',
  name: 'URL Safety',
  description: 'Check external-links.yaml URLs for shell metacharacters that could cause injection',
  scope: 'global',

  check(_content: ContentFile[], _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    if (!existsSync(EXTERNAL_LINKS_YAML)) return issues;

    let entries: ExternalLinkEntry[];
    try {
      entries = parse(readFileSync(EXTERNAL_LINKS_YAML, 'utf-8')) || [];
    } catch {
      issues.push(new Issue({
        rule: 'url-safety',
        file: EXTERNAL_LINKS_YAML,
        message: 'Failed to parse external-links.yaml',
        severity: Severity.ERROR,
      }));
      return issues;
    }

    for (const entry of entries) {
      if (!entry.links) continue;

      for (const [platform, url] of Object.entries(entry.links)) {
        if (typeof url !== 'string') continue;

        // Check for basic URL format
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          issues.push(new Issue({
            rule: 'url-safety',
            file: EXTERNAL_LINKS_YAML,
            message: `[${entry.pageId}] ${platform}: URL doesn't start with http(s): "${url}"`,
            severity: Severity.ERROR,
          }));
          continue;
        }

        // Check for shell metacharacters
        if (SHELL_METACHAR_RE.test(url)) {
          const match = url.match(SHELL_METACHAR_RE);
          issues.push(new Issue({
            rule: 'url-safety',
            file: EXTERNAL_LINKS_YAML,
            message: `[${entry.pageId}] ${platform}: URL contains shell metacharacter "${match?.[0]}": ${url}`,
            severity: Severity.ERROR,
          }));
        }

        // Check for shell variable patterns ($VAR, $(cmd))
        if (SHELL_VARIABLE_RE.test(url)) {
          issues.push(new Issue({
            rule: 'url-safety',
            file: EXTERNAL_LINKS_YAML,
            message: `[${entry.pageId}] ${platform}: URL contains shell variable pattern: ${url}`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
});

export default urlSafetyRule;
