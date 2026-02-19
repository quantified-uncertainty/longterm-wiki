/**
 * No-URL Footnotes Validation Rule
 *
 * Detects footnote definitions that contain no URL — neither a markdown link
 * `[Title](https://...)` nor a bare `https://` URL.
 *
 * This catches two failure modes the AI pipeline produces:
 *
 *   1. Explicit placeholder: `[^10]: Some description (no source URL available)`
 *   2. Vague text with no source: `[^7]: EA Forum community discussion - various posts`
 *
 * These are distinct from the cases `citation-urls` already handles:
 *   - `[^1]: [Title](undefined)` — caught by citation-urls (ERROR)
 *   - `[^1]: [Title]()` — caught by citation-urls (ERROR)
 *   - `[^1]: [Title](https://example.com)` — caught by citation-urls (WARNING)
 *
 * And distinct from footnotes with bare (non-markdown) URLs like:
 *   - `[^1]: TransformerLens repo: https://github.com/...`
 * These are non-ideal formatting but have a real URL — the normalize-footnotes
 * command (PR #337) converts them to proper format.
 *
 * Severity: WARNING (not ERROR) because legitimate edge cases exist, e.g.
 * references to personal communications, grey literature, or internal docs
 * that genuinely have no URL.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

/** Matches a footnote definition line: `[^N]: <rest>` */
const FOOTNOTE_DEF_RE = /^\[\^(\d+)\]:\s*(.+)/;

/** Matches a markdown link anywhere in text: [text](url) */
const MARKDOWN_LINK_RE = /\[[^\]]*\]\([^)]+\)/;

/** Matches a bare URL anywhere in text */
const BARE_URL_RE = /https?:\/\/\S+/;

/** Placeholder phrases that explicitly signal missing source */
const PLACEHOLDER_PHRASES = [
  'no source url available',
  'no url available',
  'no link available',
  'url unavailable',
  'source unavailable',
];

export const noUrlFootnotesRule = {
  id: 'no-url-footnotes',
  name: 'No-URL Footnotes',
  description: 'Detect footnote definitions with no URL (neither markdown link nor bare https://)',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Track code block boundaries
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      const match = FOOTNOTE_DEF_RE.exec(line);
      if (!match) continue;

      const footnoteNum = match[1];
      const body = match[2].trim();

      // Skip if there's a markdown link — already has a URL
      if (MARKDOWN_LINK_RE.test(body)) continue;

      // Skip if there's a bare URL — non-ideal format but has a source
      // (normalize-footnotes handles converting these)
      if (BARE_URL_RE.test(body)) continue;

      // At this point: footnote definition with no URL at all
      const lowerBody = body.toLowerCase();
      const isExplicitPlaceholder = PLACEHOLDER_PHRASES.some((phrase) =>
        lowerBody.includes(phrase)
      );

      const message = isExplicitPlaceholder
        ? `Footnote [^${footnoteNum}] has no URL and contains a placeholder: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}". Replace with a real source or remove the footnote.`
        : `Footnote [^${footnoteNum}] has no URL: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}". Add a markdown link [Title](https://...) or a bare URL.`;

      issues.push(
        new Issue({
          rule: 'no-url-footnotes',
          file: contentFile.path,
          line: lineNum,
          message,
          severity: isExplicitPlaceholder ? Severity.ERROR : Severity.WARNING,
        })
      );
    }

    return issues;
  },
};
