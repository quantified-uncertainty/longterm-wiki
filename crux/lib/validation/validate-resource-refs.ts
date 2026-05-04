/**
 * Resource Reference Validation — Pre-Write Guard
 *
 * Validates <R id="..."> tags in generated MDX content before writing to disk.
 * Catches broken resource references at the point of creation, not downstream.
 *
 * This runs AFTER LLM content generation and BEFORE the file is written.
 * It logs warnings and auto-fixes what it can (strip broken tags, convert to
 * markdown links when URL context is available). It never blocks the write.
 *
 * Also validates resource title quality for newly created resources.
 */

import { loadResourceIdsPGFirst, loadResources } from '../../resource-io.ts';
import { truncate } from '../text-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResourceRefMatch {
  /** Full match string (e.g., `<R id="abc123">Label</R>`) */
  fullMatch: string;
  /** Resource ID from the id attribute */
  id: string;
  /** Display text/children of the <R> tag */
  displayText: string;
  /** 1-based line number */
  line: number;
  /** Character offset in the content string */
  offset: number;
}

export interface BrokenRef {
  /** The original match */
  match: ResourceRefMatch;
  /** How the reference was fixed */
  fix: 'stripped' | 'converted-to-link';
  /** The replacement string */
  replacement: string;
  /** URL used for conversion (if applicable) */
  url?: string;
}

export interface ResourceRefValidationResult {
  /** Total number of <R> refs found */
  totalRefs: number;
  /** Number of valid refs (ID exists in resource set) */
  validRefs: number;
  /** Number of broken refs found */
  brokenRefs: number;
  /** Details of each broken ref and its fix */
  broken: BrokenRef[];
  /** The fixed content (with broken refs repaired) */
  fixedContent: string;
  /** Whether any changes were made */
  changed: boolean;
}

export interface TitleQualityIssue {
  title: string;
  reason: string;
}

export interface TitleQualityResult {
  /** Number of titles checked */
  checked: number;
  /** Titles with quality issues */
  issues: TitleQualityIssue[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex matching <R id="...">...</R> or self-closing <R id="..." />.
 *
 * Groups:
 *   1 = id value
 *   2 = remaining attributes + children (for non-self-closing)
 *   3 = children text (inside the tag, before </R>)
 *
 * Handles both <R id="x">text</R> and <R id="x" /> forms.
 */
const R_TAG_FULL_RE = /<R\s+id=["']([^"']+)["']([^>]*?)(?:\/>|>([\s\S]*?)<\/R>)/g;

/**
 * Titles that indicate a failed fetch or placeholder.
 * Case-insensitive match.
 */
const BAD_TITLE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^untitled$/i, reason: 'placeholder title "Untitled"' },
  { pattern: /^404\b/i, reason: 'appears to be a 404 error page title' },
  { pattern: /^error\b/i, reason: 'appears to be an error page title' },
  { pattern: /^page not found$/i, reason: 'page not found error' },
  { pattern: /^access denied$/i, reason: 'access denied error' },
  { pattern: /^forbidden$/i, reason: 'forbidden error' },
  { pattern: /^loading\.{0,3}$/i, reason: 'loading placeholder' },
  { pattern: /^just a moment/i, reason: 'Cloudflare challenge page' },
  { pattern: /^attention required/i, reason: 'Cloudflare challenge page' },
  { pattern: /^please wait/i, reason: 'loading/challenge page' },
  { pattern: /^sign in/i, reason: 'login page title' },
  { pattern: /^log in/i, reason: 'login page title' },
  { pattern: /^null$/i, reason: 'null value used as title' },
  { pattern: /^undefined$/i, reason: 'undefined value used as title' },
  { pattern: /^none$/i, reason: 'none value used as title' },
  { pattern: /^N\/A$/i, reason: 'N/A used as title' },
];

/**
 * Domain-only titles: just a hostname with no meaningful content.
 * e.g., "arxiv.org", "www.nature.com", "github.com"
 */
const DOMAIN_ONLY_RE = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.)+[a-z]{2,}[\/]?$/i;

// ---------------------------------------------------------------------------
// Core: Extract <R> refs from content
// ---------------------------------------------------------------------------

/**
 * Extract all <R id="..."> tags from MDX content.
 * Skips refs inside fenced code blocks and inline code spans.
 */
export function extractResourceRefs(content: string): ResourceRefMatch[] {
  const matches: ResourceRefMatch[] = [];
  const lines = content.split('\n');
  let inFencedBlock = false;

  // Build a line-offset map for efficient offset -> line lookup
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +1 for newline
  }

  // Process line by line to handle code blocks
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Track fenced code blocks
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
      continue;
    }
    if (inFencedBlock) continue;

    // Strip inline code spans before checking
    const strippedLine = line.replace(/`[^`]*`/g, match => ' '.repeat(match.length));

    R_TAG_FULL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = R_TAG_FULL_RE.exec(strippedLine)) !== null) {
      const id = match[1];
      const children = match[3]?.trim() || '';

      // Find the corresponding full match in the original line (not stripped)
      // We need the actual original text for replacement
      const originalMatch = findOriginalRTag(line, id);

      matches.push({
        fullMatch: originalMatch || match[0],
        id,
        displayText: children,
        line: lineIdx + 1,
        offset: lineOffsets[lineIdx] + match.index,
      });
    }
  }

  return matches;
}

/**
 * Find the full original <R> tag in a line, including children and closing tag.
 * This handles multi-attribute tags where the stripped version may differ.
 */
function findOriginalRTag(line: string, id: string): string | null {
  // Build a pattern that matches the specific R tag with this ID
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<R\\s+id=["']${escaped}["']([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/R>)`);
  const m = re.exec(line);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Core: Validate and fix broken refs
// ---------------------------------------------------------------------------

/**
 * Validate all <R> tags in content against a set of known resource IDs.
 * Returns validation results with the fixed content.
 *
 * For broken refs:
 * - If a URL is nearby (in a footnote or the same line), converts to a markdown link
 * - Otherwise, strips the <R> tag and leaves the display text
 */
export function validateResourceRefs(
  content: string,
  knownIds: Set<string>,
): ResourceRefValidationResult {
  const refs = extractResourceRefs(content);
  const broken: BrokenRef[] = [];
  let fixedContent = content;

  for (const ref of refs) {
    if (knownIds.has(ref.id)) continue;

    // This ref is broken — try to find a URL context for conversion
    const nearbyUrl = findNearbyUrl(content, ref);
    const displayText = ref.displayText || ref.id;

    let replacement: string;
    let fix: 'stripped' | 'converted-to-link';
    let url: string | undefined;

    if (nearbyUrl) {
      replacement = `[${displayText}](${nearbyUrl})`;
      fix = 'converted-to-link';
      url = nearbyUrl;
    } else {
      replacement = displayText;
      fix = 'stripped';
    }

    broken.push({ match: ref, fix, replacement, url });

    // Apply the fix to the content
    fixedContent = fixedContent.replace(ref.fullMatch, replacement);
  }

  return {
    totalRefs: refs.length,
    validRefs: refs.length - broken.length,
    brokenRefs: broken.length,
    broken,
    fixedContent,
    changed: broken.length > 0,
  };
}

/**
 * Try to find a URL near a broken <R> tag that could be used as a fallback link.
 *
 * Searches:
 * 1. The same line for a URL
 * 2. Footnote definitions that reference the resource ID
 * 3. Adjacent lines (within 2 lines)
 */
function findNearbyUrl(content: string, ref: ResourceRefMatch): string | null {
  const lines = content.split('\n');
  const lineIdx = ref.line - 1; // 0-based

  // URL pattern for extraction
  const urlRe = /https?:\/\/[^\s)"'\]>]+/g;

  // 1. Check the same line (but not the R tag's own id)
  const currentLine = lines[lineIdx] || '';
  urlRe.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRe.exec(currentLine)) !== null) {
    return urlMatch[0];
  }

  // 2. Check footnote definitions referencing this resource
  const footnoteRe = new RegExp(`^\\[\\^\\d+\\]:.*${escapeRegExp(ref.id)}`, 'gm');
  const footnoteMatch = footnoteRe.exec(content);
  if (footnoteMatch) {
    urlRe.lastIndex = 0;
    const fnUrlMatch = urlRe.exec(footnoteMatch[0]);
    if (fnUrlMatch) return fnUrlMatch[0];
  }

  // 3. Check adjacent lines (1 line before and after)
  for (const delta of [-1, 1]) {
    const adjacentIdx = lineIdx + delta;
    if (adjacentIdx >= 0 && adjacentIdx < lines.length) {
      const adjacentLine = lines[adjacentIdx];
      urlRe.lastIndex = 0;
      const adjUrlMatch = urlRe.exec(adjacentLine);
      if (adjUrlMatch) return adjUrlMatch[0];
    }
  }

  return null;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Title quality validation
// ---------------------------------------------------------------------------

/**
 * Check resource titles for quality issues.
 *
 * Flags:
 * - Domain-only titles (e.g., "arxiv.org")
 * - Error/placeholder titles (e.g., "404", "Untitled", "Page Not Found")
 * - Very short titles (< 3 chars)
 * - Very long titles (> 300 chars)
 */
export function validateResourceTitles(
  titles: Array<{ id: string; title: string }>,
): TitleQualityResult {
  const issues: TitleQualityIssue[] = [];

  for (const { title } of titles) {
    if (!title || !title.trim()) {
      issues.push({ title: title || '(empty)', reason: 'empty or blank title' });
      continue;
    }

    const trimmed = title.trim();

    // Check for domain-only titles
    if (DOMAIN_ONLY_RE.test(trimmed)) {
      issues.push({ title: trimmed, reason: 'title is just a domain name' });
      continue;
    }

    // Check against bad title patterns
    for (const { pattern, reason } of BAD_TITLE_PATTERNS) {
      if (pattern.test(trimmed)) {
        issues.push({ title: trimmed, reason });
        break;
      }
    }

    // Check length
    if (trimmed.length < 3) {
      issues.push({ title: trimmed, reason: `title too short (${trimmed.length} chars)` });
    } else if (trimmed.length > 300) {
      issues.push({
        title: truncate(trimmed, 63, { ellipsis: '...' }),
        reason: `title too long (${trimmed.length} chars)`,
      });
    }
  }

  return { checked: titles.length, issues };
}

// ---------------------------------------------------------------------------
// High-level pipeline integration
// ---------------------------------------------------------------------------

/**
 * Load known resource IDs for validation.
 *
 * Tries PG first, falls back to snapshot. Returns an empty set with a warning
 * if neither is available (never blocks the pipeline).
 */
export async function loadKnownResourceIds(): Promise<Set<string>> {
  try {
    return await loadResourceIdsPGFirst();
  } catch {
    // Neither PG nor snapshot available
    return new Set();
  }
}

/**
 * Load known resource IDs synchronously from snapshot only.
 * Faster than the async version — use when you know the wiki-server is unavailable.
 */
export function loadKnownResourceIdsSync(): Set<string> {
  try {
    const resources = loadResources();
    const ids = new Set(resources.map(r => r.id));
    for (const r of resources) {
      if (r.stable_id) ids.add(r.stable_id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

export interface PipelineResourceValidationResult {
  /** Resource ref validation result */
  refs: ResourceRefValidationResult;
  /** Title quality result (if titles were checked) */
  titles?: TitleQualityResult;
  /** Whether resource IDs were available for checking */
  resourceIdsAvailable: boolean;
}

/**
 * Run resource validation on generated MDX content.
 *
 * This is the main entry point for the improve/create pipeline.
 * Call it after LLM generates content, before writing to disk.
 *
 * @param content - The generated MDX content
 * @param options - Optional configuration
 * @returns Validation result with fixed content
 */
export async function validatePipelineResources(
  content: string,
  options: {
    /** New resource titles to check for quality (id + title pairs) */
    newResourceTitles?: Array<{ id: string; title: string }>;
    /** Logger function for output (defaults to console.log) */
    log?: (phase: string, message: string) => void;
  } = {},
): Promise<PipelineResourceValidationResult> {
  const { newResourceTitles, log: logFn } = options;

  const logMsg = logFn || ((_phase: string, msg: string) => console.log(`  [resource-validation] ${msg}`));

  // Load known resource IDs
  const knownIds = await loadKnownResourceIds();
  const resourceIdsAvailable = knownIds.size > 0;

  if (!resourceIdsAvailable) {
    logMsg('resource-validation', 'Warning: no resource IDs available — skipping ref validation');
    return {
      refs: {
        totalRefs: 0,
        validRefs: 0,
        brokenRefs: 0,
        broken: [],
        fixedContent: content,
        changed: false,
      },
      resourceIdsAvailable: false,
    };
  }

  // Validate resource refs
  const refs = validateResourceRefs(content, knownIds);

  // Log results
  if (refs.totalRefs > 0) {
    if (refs.brokenRefs === 0) {
      logMsg('resource-validation', `${refs.totalRefs} resource refs validated — all OK`);
    } else {
      logMsg('resource-validation',
        `${refs.totalRefs} resource refs checked — ${refs.brokenRefs} broken refs fixed:`);
      for (const broken of refs.broken) {
        const fixLabel = broken.fix === 'converted-to-link'
          ? `converted to markdown link (${broken.url})`
          : 'stripped to plain text';
        logMsg('resource-validation',
          `  Line ${broken.match.line}: <R id="${broken.match.id}"> — ${fixLabel}`);
      }
    }
  }

  // Validate title quality if new resources provided
  let titles: TitleQualityResult | undefined;
  if (newResourceTitles && newResourceTitles.length > 0) {
    titles = validateResourceTitles(newResourceTitles);
    if (titles.issues.length > 0) {
      logMsg('resource-validation',
        `${titles.issues.length} resource title quality issues:`);
      for (const issue of titles.issues) {
        logMsg('resource-validation', `  "${issue.title}" — ${issue.reason}`);
      }
    }
  }

  return { refs, titles, resourceIdsAvailable };
}
