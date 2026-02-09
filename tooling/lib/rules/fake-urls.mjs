/**
 * Rule: Fake/Placeholder URL Detection
 *
 * Detects fake or placeholder URLs in citations and links:
 * - example.com, example.org, example.net
 * - /example paths (e.g., lesswrong.com/posts/example)
 * - placeholder.com, test.com
 * - Lorem ipsum style fake domains
 *
 * These are worse than no URL - they're actively misleading.
 */

import { createRule, Issue, Severity } from '../validation-engine.mjs';
import { isInCodeBlock, getLineNumber } from '../mdx-utils.mjs';

// Fake URL patterns to detect
const FAKE_URL_PATTERNS = [
  // example.com family
  {
    pattern: /https?:\/\/(?:www\.)?example\.(?:com|org|net)(?:\/[^\s\)"\]]*)?/gi,
    name: 'example.com URL',
    severity: Severity.ERROR,
  },
  // /example paths on real domains
  {
    pattern: /https?:\/\/[^\s\)"\]]+\/(?:posts\/example|example|p\/example|pages\/example)(?:\/[^\s\)"\]]*)?/gi,
    name: 'placeholder /example path',
    severity: Severity.ERROR,
  },
  // placeholder domains
  {
    pattern: /https?:\/\/(?:www\.)?(?:placeholder|test|fake|dummy|sample)\.(?:com|org|net)(?:\/[^\s\)"\]]*)?/gi,
    name: 'placeholder domain',
    severity: Severity.ERROR,
  },
  // foo/bar style fake domains
  {
    pattern: /https?:\/\/(?:www\.)?(?:foo|bar|baz|qux)\.(?:com|org|net)(?:\/[^\s\)"\]]*)?/gi,
    name: 'foo/bar placeholder domain',
    severity: Severity.ERROR,
  },
  // localhost URLs (shouldn't be in content)
  {
    pattern: /https?:\/\/localhost(?::\d+)?(?:\/[^\s\)"\]]*)?/gi,
    name: 'localhost URL',
    severity: Severity.ERROR,
  },
  // 127.0.0.1 URLs
  {
    pattern: /https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/[^\s\)"\]]*)?/gi,
    name: 'localhost IP URL',
    severity: Severity.ERROR,
  },
  // yoursite.com, yourdomain.com placeholders
  {
    pattern: /https?:\/\/(?:www\.)?(?:your(?:site|domain|company|blog|website)|mysite|mydomain)\.(?:com|org|net)(?:\/[^\s\)"\]]*)?/gi,
    name: 'yoursite placeholder',
    severity: Severity.ERROR,
  },
];

// Markdown link pattern to extract URLs
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g;
const FOOTNOTE_PATTERN = /\[\^[^\]]+\]:\s*\[([^\]]*)\]\(([^)]+)\)/g;
const HTML_LINK_PATTERN = /href=["']([^"']+)["']/g;

export const fakeUrlsRule = createRule({
  id: 'fake-urls',
  name: 'Fake URL Detection',
  description: 'Detect placeholder/fake URLs like example.com that are actively misleading',

  check(content, engine) {
    const issues = [];
    const body = content.body;

    // Skip internal docs and documentation pages
    if (content.relativePath.includes('/internal/') ||
        content.frontmatter.pageType === 'documentation') {
      return issues;
    }

    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip code blocks
      if (isInCodeBlock(body, body.indexOf(line))) {
        continue;
      }

      // Check each fake URL pattern
      for (const { pattern, name, severity } of FAKE_URL_PATTERNS) {
        // Reset regex state
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(line)) !== null) {
          const url = match[0];

          issues.push(
            new Issue({
              rule: 'fake-urls',
              file: content.path,
              line: lineNum,
              message: `Fake/placeholder URL detected: ${url} - ${name}. Either find the real URL or remove the link.`,
              severity,
            })
          );
        }
      }
    }

    return issues;
  },
});

export default fakeUrlsRule;
