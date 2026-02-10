/**
 * MDX Utilities for Scripts
 *
 * Common functions for parsing and manipulating MDX content files.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * Parse YAML frontmatter from MDX content
 * @param {string} content - Full MDX file content
 * @returns {object} Parsed frontmatter object (empty if none/invalid)
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    return parseYaml(match[1]) || {};
  } catch {
    return {};
  }
}

/**
 * Parse frontmatter and body together from MDX content
 * @param {string} content - Full MDX file content
 * @returns {{frontmatter: object, body: string}} Parsed frontmatter and body
 */
export function parseFrontmatterAndBody(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  try {
    const frontmatter = parseYaml(match[1]);
    return { frontmatter: frontmatter || {}, body: match[2] };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

/**
 * Get content body (without frontmatter)
 * @param {string} content - Full MDX file content
 * @returns {string} Content without frontmatter
 */
export function getContentBody(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : content;
}

/**
 * Get raw frontmatter string (without delimiters)
 * @param {string} content - Full MDX file content
 * @returns {string|null} Raw frontmatter YAML or null if none
 */
export function getRawFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

/**
 * Update frontmatter fields while preserving existing content
 * @param {string} content - Full MDX file content
 * @param {object} updates - Fields to add/update in frontmatter
 * @returns {string} Updated content with modified frontmatter
 */
export function updateFrontmatter(content, updates) {
  const frontmatter = parseFrontmatter(content);
  const body = getContentBody(content);

  const newFrontmatter = { ...frontmatter, ...updates };
  const yamlString = stringifyYaml(newFrontmatter, { lineWidth: 0 }).trim();

  return `---\n${yamlString}\n---\n${body}`;
}

/**
 * Replace frontmatter entirely
 * @param {string} content - Full MDX file content
 * @param {object} newFrontmatter - New frontmatter object
 * @returns {string} Content with replaced frontmatter
 */
export function replaceFrontmatter(content, newFrontmatter) {
  const body = getContentBody(content);
  const yamlString = stringifyYaml(newFrontmatter, { lineWidth: 0 }).trim();

  return `---\n${yamlString}\n---\n${body}`;
}

/**
 * Check if content has valid frontmatter
 * @param {string} content - Full MDX file content
 * @returns {boolean} True if content has valid frontmatter
 */
export function hasFrontmatter(content) {
  return /^---\n[\s\S]*?\n---/.test(content);
}

/**
 * Extract all h2 sections from content body
 * @param {string} body - Content body (without frontmatter)
 * @returns {Array<{title: string, line: number}>} Array of section objects
 */
export function extractH2Sections(body) {
  const sections = [];
  const regex = /^##\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const lineNum = body.substring(0, match.index).split('\n').length;
    sections.push({
      title: match[1].trim(),
      line: lineNum,
    });
  }
  return sections;
}

/**
 * Extract all headings from content body
 * @param {string} body - Content body (without frontmatter)
 * @returns {Array<{level: number, title: string, line: number}>} Array of heading objects
 */
export function extractHeadings(body) {
  const headings = [];
  const regex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const lineNum = body.substring(0, match.index).split('\n').length;
    headings.push({
      level: match[1].length,
      title: match[2].trim(),
      line: lineNum,
    });
  }
  return headings;
}

/**
 * Count words in content (excluding code blocks and frontmatter)
 * @param {string} body - Content body (without frontmatter)
 * @returns {number} Word count
 */
export function countWords(body) {
  // Remove code blocks
  const withoutCode = body.replace(/```[\s\S]*?```/g, '');
  // Remove inline code
  const withoutInline = withoutCode.replace(/`[^`]+`/g, '');
  // Count words
  return withoutInline.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Extract links from MDX content
 * @param {string} body - Content body
 * @returns {Array<{text: string, url: string, line: number}>} Array of link objects
 */
export function extractLinks(body) {
  const links = [];
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const lineNum = body.substring(0, match.index).split('\n').length;
    links.push({
      text: match[1],
      url: match[2],
      line: lineNum,
    });
  }
  return links;
}

/**
 * Page types that should skip content validation
 * These pages contain examples/documentation that would trigger false positives
 */
const SKIP_VALIDATION_PAGE_TYPES = ['stub', 'documentation'];

/**
 * File path patterns that should skip validation
 */
const SKIP_VALIDATION_PATHS = [
  /\/index\.(mdx?|md)$/,        // Index/overview pages
  /\/_[^/]+\.(mdx?|md)$/,       // Files starting with underscore
  /\/internal\//,               // Internal docs directory
];

/**
 * Check if a page should skip validation based on frontmatter
 * @param {object} frontmatter - Parsed frontmatter object
 * @returns {boolean} True if validation should be skipped
 */
export function shouldSkipValidation(frontmatter) {
  return SKIP_VALIDATION_PAGE_TYPES.includes(frontmatter.pageType);
}

/**
 * Check if a file should skip validation based on path
 * @param {string} filePath - Path to the file
 * @returns {boolean} True if validation should be skipped
 */
export function shouldSkipValidationByPath(filePath) {
  return SKIP_VALIDATION_PATHS.some(pattern => pattern.test(filePath));
}

/**
 * Combined check: skip validation if either frontmatter or path matches
 * @param {object} frontmatter - Parsed frontmatter object
 * @param {string} filePath - Path to the file
 * @returns {boolean} True if validation should be skipped
 */
export function shouldSkipValidationFull(frontmatter, filePath) {
  return shouldSkipValidation(frontmatter) || shouldSkipValidationByPath(filePath);
}

// ============================================================================
// Position-based context detection utilities
// Used by validators to check if a position is in code/JSX/Mermaid contexts
// ============================================================================

/**
 * Check if a position is inside a code block (fenced or inline)
 * @param {string} content - Full content string
 * @param {number} position - Character position to check
 * @returns {boolean} True if position is inside a code block
 */
export function isInCodeBlock(content, position) {
  const before = content.slice(0, position);

  // Count triple backticks - if odd, we're inside a fenced code block
  const tripleBackticks = (before.match(/```/g) || []).length;
  if (tripleBackticks % 2 === 1) return true;

  // Check inline code (simplistic - just check if between backticks on same line)
  const lastNewline = before.lastIndexOf('\n');
  const currentLine = before.slice(lastNewline + 1);
  const backticks = (currentLine.match(/`/g) || []).length;
  return backticks % 2 === 1;
}

/**
 * Check if a position is inside a JSX attribute (e.g., chart={`...`})
 * @param {string} content - Full content string
 * @param {number} position - Character position to check
 * @returns {boolean} True if position is inside a JSX attribute
 */
export function isInJsxAttribute(content, position) {
  const before = content.slice(0, position);
  const lastNewline = before.lastIndexOf('\n');
  const currentLine = before.slice(lastNewline + 1);

  // Inside a template literal in JSX (e.g., chart={`...`})
  const templateLiteralMatch = currentLine.match(/\{`[^`]*$/);
  if (templateLiteralMatch) return true;

  // Inside a JSX string attribute (e.g., title="...")
  const jsxStringMatch = currentLine.match(/<[^>]*=["'][^"']*$/);
  if (jsxStringMatch) return true;

  return false;
}

/**
 * Check if a position is inside a Mermaid diagram component
 * @param {string} content - Full content string
 * @param {number} position - Character position to check
 * @returns {boolean} True if position is inside a Mermaid component
 */
export function isInMermaid(content, position) {
  const before = content.slice(0, position);

  // Check for <Mermaid ... chart={` pattern before position
  const mermaidOpenMatch = before.match(/<Mermaid[^>]*chart=\{`[^`]*$/);
  if (mermaidOpenMatch) return true;

  // Check if we're after Mermaid open but before closing
  const lastMermaidOpen = before.lastIndexOf('<Mermaid');
  if (lastMermaidOpen === -1) return false;

  const lastMermaidClose = before.lastIndexOf('/>');
  const lastMermaidCloseTag = before.lastIndexOf('</Mermaid>');
  const lastClose = Math.max(lastMermaidClose, lastMermaidCloseTag);

  return lastMermaidOpen > lastClose;
}

/**
 * Check if a position is inside an HTML/JSX comment
 * @param {string} content - Full content string
 * @param {number} position - Character position to check
 * @returns {boolean} True if position is inside a comment
 */
export function isInComment(content, position) {
  const before = content.slice(0, position);

  // Check for HTML comment
  const lastCommentOpen = before.lastIndexOf('<!--');
  const lastCommentClose = before.lastIndexOf('-->');
  if (lastCommentOpen > lastCommentClose) return true;

  // Check for JSX comment {/* ... */}
  const lastJsxCommentOpen = before.lastIndexOf('{/*');
  const lastJsxCommentClose = before.lastIndexOf('*/}');
  if (lastJsxCommentOpen > lastJsxCommentClose) return true;

  return false;
}

/**
 * Get the line number at a character position
 * @param {string} content - Full content string
 * @param {number} position - Character position
 * @returns {number} 1-indexed line number
 */
export function getLineNumber(content, position) {
  return content.slice(0, position).split('\n').length;
}

/**
 * Get the line index (0-indexed) where frontmatter ends
 * Returns 0 if no frontmatter found
 * @param {string} content - Full content string
 * @returns {number} 0-indexed line number of closing ---
 */
export function getFrontmatterEndLine(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return 0;

  let dashCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      dashCount++;
      if (dashCount === 2) return i;
    }
  }
  return 0;
}

/**
 * Check if a position should be skipped for validation
 * (in code block, JSX attribute, Mermaid, or comment)
 * @param {string} content - Full content string
 * @param {number} position - Character position to check
 * @returns {boolean} True if position should be skipped
 */
export function shouldSkipPosition(content, position) {
  return (
    isInCodeBlock(content, position) ||
    isInJsxAttribute(content, position) ||
    isInMermaid(content, position) ||
    isInComment(content, position)
  );
}

/**
 * Iterate regex matches over lines in body text, skipping code blocks.
 *
 * For each match that is NOT inside a code block (or other excluded context),
 * calls `callback({ match, line, lineNum, absolutePos })`.
 *
 * @param {string} body - Content body (without frontmatter)
 * @param {RegExp} regex - Pattern to search for (must have the 'g' flag set
 *   on the *source*; a fresh RegExp is created per line internally).
 * @param {function} callback - Called for each non-code-block match
 * @param {object} [options]
 * @param {function} [options.skip] - Extra skip predicate `(body, absolutePos) => boolean`
 */
export function matchLinesOutsideCode(body, regex, callback, options = {}) {
  const lines = body.split('\n');
  let position = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Create a fresh regex per line so lastIndex resets naturally
    const lineRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let match;
    while ((match = lineRegex.exec(line)) !== null) {
      const absolutePos = position + match.index;

      if (isInCodeBlock(body, absolutePos)) continue;
      if (options.skip && options.skip(body, absolutePos)) continue;

      callback({ match, line, lineNum, absolutePos });
    }

    position += line.length + 1;
  }
}
