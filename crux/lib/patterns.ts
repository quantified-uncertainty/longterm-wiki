/**
 * Shared Regex Patterns
 *
 * Common patterns used across validation rules, authoring pipelines,
 * and other crux tooling. Centralizing prevents drift when patterns
 * need updating.
 *
 * Usage:
 *   import { ENTITY_LINK_RE, NUMERIC_ID_RE } from '../lib/patterns.ts';
 */

// ---------------------------------------------------------------------------
// EntityLink patterns
// ---------------------------------------------------------------------------

/** Match `<EntityLink id="...">` — captures the ID in group 1. Use with `g` flag. */
export const ENTITY_LINK_RE = /<EntityLink\s+[^>]*id=["']([^"']+)["'][^>]*>/g;

/** Match numeric entity IDs like `E35`, `E710`. Case-insensitive. */
export const NUMERIC_ID_RE = /^E\d+$/i;

// ---------------------------------------------------------------------------
// JSX / MDX component patterns
// ---------------------------------------------------------------------------

/** Match JSX component usage: `<ComponentName`. Captures name in group 1. */
export const COMPONENT_USAGE_RE = /<([A-Z][a-zA-Z0-9]*)/g;

/** Match import from `@components/wiki`. Captures import list in group 1. */
export const WIKI_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"]@components\/wiki['"]/;

// ---------------------------------------------------------------------------
// Markdown patterns
// ---------------------------------------------------------------------------

/** Match markdown links `[text](url)`. Groups: 1=text, 2=url. */
export const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/** Match GFM footnote references `[^N]` (not definitions). */
export const FOOTNOTE_REF_RE = /\[\^\d+\]/g;

/** Match GFM footnote definitions `[^N]:` at start of line. */
export const FOOTNOTE_DEF_RE = /^\[\^\d+\]:/gm;

// ---------------------------------------------------------------------------
// Frontmatter patterns
// ---------------------------------------------------------------------------

/** Match YAML frontmatter delimiters. Group 1 = frontmatter body (without delimiters). */
export const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** Strip frontmatter from content (returns body only). */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '');
}

// ---------------------------------------------------------------------------
// Dollar sign / escaping patterns
// ---------------------------------------------------------------------------

/** Unescaped $ followed by a digit. Used by dollar-signs rule. */
export const UNESCAPED_DOLLAR_RE = /(?<!\\)\$(\d)/g;

/** Double-escaped \\$ in MDX body. */
export const DOUBLE_ESCAPED_DOLLAR_RE = /\\\\\$/g;

/** Less-than before a digit or escaped dollar. Used by comparison-operators rule. */
export const LESS_THAN_BEFORE_NUM_RE = /<(\d|\\?\$)/g;

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

/** Common fake/placeholder URL domains. */
export const FAKE_DOMAIN_RE = /https?:\/\/(?:www\.)?(?:example|placeholder|test|fake|dummy|sample)\.(?:com|org|net)/gi;

/** Fake /example paths on real domains. */
export const FAKE_PATH_RE = /https?:\/\/[^\s)"'\]]+\/(?:posts\/example|example|p\/example|pages\/example)/gi;
