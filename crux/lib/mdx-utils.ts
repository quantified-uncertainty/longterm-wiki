/**
 * MDX Utilities for Scripts
 *
 * Common functions for parsing and manipulating MDX content files.
 */

import { parse as parseYaml } from 'yaml';
import { FRONTMATTER_RE, stripFrontmatter } from './patterns.ts';

/**
 * Parse YAML frontmatter from MDX content
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return {};
  try {
    return parseYaml(match[1]) || {};
  } catch {
    return {};
  }
}

/**
 * Parse frontmatter and body together from MDX content
 */
export function parseFrontmatterAndBody(content: string): { frontmatter: Record<string, unknown>; body: string } {
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
 */
export function getContentBody(content: string): string {
  return stripFrontmatter(content);
}

/**
 * Page types that should skip content validation
 * These pages contain examples/documentation that would trigger false positives
 */
const SKIP_VALIDATION_PAGE_TYPES = ['stub', 'documentation'];

/**
 * Check if a page should skip validation based on frontmatter.
 * Matches stub pages, legacy pageType: documentation, and entityType: internal.
 */
export function shouldSkipValidation(frontmatter: Record<string, unknown>): boolean {
  if (SKIP_VALIDATION_PAGE_TYPES.includes(frontmatter.pageType as string)) return true;
  if (frontmatter.entityType === 'internal') return true;
  return false;
}

// ============================================================================
// Position-based context detection utilities
// Used by validators to check if a position is in code/JSX/Mermaid contexts
// ============================================================================

/**
 * Check if a position is inside a code block (fenced or inline)
 */
export function isInCodeBlock(content: string, position: number): boolean {
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
 */
export function isInJsxAttribute(content: string, position: number): boolean {
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
 */
export function isInMermaid(content: string, position: number): boolean {
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
 */
export function isInComment(content: string, position: number): boolean {
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
 */
export function getLineNumber(content: string, position: number): number {
  return content.slice(0, position).split('\n').length;
}

/**
 * Get the line index (0-indexed) where frontmatter ends
 * Returns 0 if no frontmatter found
 */
export function getFrontmatterEndLine(content: string): number {
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
 */
export function shouldSkipPosition(content: string, position: number): boolean {
  return (
    isInCodeBlock(content, position) ||
    isInJsxAttribute(content, position) ||
    isInMermaid(content, position) ||
    isInComment(content, position)
  );
}

/**
 * Strip markdown code fences from AI-generated output.
 * Handles ```lang\n...\n``` wrapping that models sometimes add.
 */
export function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  }
  return cleaned;
}

export interface MatchCallbackInfo {
  match: RegExpExecArray;
  line: string;
  lineNum: number;
  absolutePos: number;
}

export interface MatchLinesOptions {
  skip?: (body: string, absolutePos: number) => boolean;
}

/**
 * Iterate regex matches over lines in body text, skipping code blocks.
 *
 * For each match that is NOT inside a code block (or other excluded context),
 * calls `callback({ match, line, lineNum, absolutePos })`.
 */
export function matchLinesOutsideCode(
  body: string,
  regex: RegExp,
  callback: (info: MatchCallbackInfo) => void,
  options: MatchLinesOptions = {},
): void {
  const lines = body.split('\n');
  let position = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Create a fresh regex per line so lastIndex resets naturally
    const lineRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(line)) !== null) {
      const absolutePos = position + match.index;

      if (isInCodeBlock(body, absolutePos)) continue;
      if (options.skip && options.skip(body, absolutePos)) continue;

      callback({ match, line, lineNum, absolutePos });
    }

    position += line.length + 1;
  }
}