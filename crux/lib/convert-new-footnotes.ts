/**
 * Convert numbered footnotes in LLM-generated content to DB-driven references.
 *
 * When the improve pipeline generates new content, footnotes come out as [^N]
 * because LLMs are unreliable at generating hash-based IDs. This module:
 *
 * 1. Finds all [^N] footnotes in the content
 * 2. Checks if the footnote URL matches a KB fact source (→ [^kb-factId])
 * 3. Otherwise generates [^rc-XXXX] reference IDs for each
 * 4. Rewrites inline refs and definitions
 * 5. Optionally creates DB citation entries via the wiki-server API
 *
 * Used as a post-processing step in the improve pipeline.
 */

import { createHash } from 'crypto';
import { parseFootnotes } from './footnote-parser.ts';
import { createCitationsBatch } from './wiki-server/references.ts';
import { isServerAvailable } from './wiki-server/client.ts';
import type { PageCitationInsert } from '../../apps/wiki-server/src/api-types.ts';
import { getResourceByUrl } from './search/resource-lookup.ts';
import { buildKBFactSourceMap, findKBFactByUrl } from './factbase-fact-lookup.ts';

// ---------------------------------------------------------------------------
// Reference ID generation (shared with migrate-footnotes.ts)
// ---------------------------------------------------------------------------

/**
 * Generate a short, stable reference ID from input data.
 * Format: rc-XXXX where XXXX is 4 hex chars from a SHA-256 hash.
 */
function generateRefId(data: string, existingIds: Set<string>): string {
  const hash = createHash('sha256').update(data).digest('hex');
  for (let offset = 0; offset < hash.length - 4; offset++) {
    const candidate = `rc-${hash.slice(offset, offset + 4)}`;
    if (!existingIds.has(candidate)) {
      existingIds.add(candidate);
      return candidate;
    }
  }
  const fallback = `rc-${hash.slice(0, 8)}`;
  existingIds.add(fallback);
  return fallback;
}

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------

export interface ConvertResult {
  /** The rewritten content with [^rc-XXXX] or [^kb-factId] references */
  content: string;
  /** Number of footnotes converted */
  convertedCount: number;
  /** Number of footnotes matched to KB facts (subset of convertedCount) */
  kbMatchCount: number;
  /** Whether DB entries were created */
  dbEntriesCreated: boolean;
}

/**
 * Convert numbered footnotes [^N] in content to [^kb-factId] or [^rc-XXXX] references.
 *
 * When an entityId is provided, footnote URLs are checked against KB fact sources.
 * Matches use [^kb-{factId}] (no DB entry needed — KB data lives in YAML).
 * Non-matches fall back to [^rc-XXXX] references with optional DB entries.
 *
 * @param content - MDX content with [^N] style footnotes
 * @param pageId - Entity ID for the page (used in DB entries and hash generation)
 * @param options.createDbEntries - Whether to create citation entries in the DB (default: false)
 * @param options.entityId - Entity slug to enable KB fact matching (e.g., "anthropic")
 */
export async function convertNewFootnotes(
  content: string,
  pageId: string,
  options: { createDbEntries?: boolean; entityId?: string } = {},
): Promise<ConvertResult> {
  const { createDbEntries = false, entityId } = options;

  // Parse existing numbered footnotes
  const footnotes = parseFootnotes(content);
  if (footnotes.length === 0) {
    return { content, convertedCount: 0, kbMatchCount: 0, dbEntriesCreated: false };
  }

  // Load KB fact source map if entityId is provided
  const kbSourceMap = entityId
    ? await buildKBFactSourceMap(entityId)
    : new Map();

  // Also check if there are already [^rc-XXXX], [^cr-XXXX], or [^kb-...] refs in the content.
  // Collect their IDs so we don't collide.
  const existingIds = new Set<string>();
  const existingRefPattern = /\[\^((?:rc|cr)-[a-f0-9]+|kb-[^\]]+)\]/g;
  let existingMatch;
  while ((existingMatch = existingRefPattern.exec(content)) !== null) {
    existingIds.add(existingMatch[1]);
  }

  // Build mapping: footnote number -> new reference ID
  // Prefer KB fact IDs when the footnote URL matches a KB fact source.
  const refMap = new Map<number, string>();
  let kbMatchCount = 0;

  for (const fn of footnotes) {
    // Try KB fact matching first
    if (fn.url && kbSourceMap.size > 0) {
      const kbMatch = findKBFactByUrl(kbSourceMap, fn.url);
      if (kbMatch) {
        const kbRefId = `kb-${kbMatch.factId}`;
        if (!existingIds.has(kbRefId)) {
          existingIds.add(kbRefId);
          refMap.set(fn.number, kbRefId);
          kbMatchCount++;
          continue;
        }
        // If the kb-factId already exists in the content, fall through to rc-XXXX
      }
    }

    // Fall back to generated rc-XXXX reference
    const refId = generateRefId(
      `cite:${pageId}:${fn.number}:${fn.url ?? fn.rawText}`,
      existingIds,
    );
    refMap.set(fn.number, refId);
  }

  // Rewrite content: replace inline refs and definition lines
  let modified = content;

  // Replace inline references [^N] -> [^rc-XXXX] or [^kb-factId] (process in reverse order)
  const sortedEntries = [...refMap.entries()].sort((a, b) => b[0] - a[0]);
  for (const [fnNum, refId] of sortedEntries) {
    // Replace inline references [^N] (not definition lines [^N]:)
    const inlinePattern = new RegExp(`\\[\\^${fnNum}\\](?!:)`, 'g');
    modified = modified.replace(inlinePattern, `[^${refId}]`);

    // Replace definition line [^N]: -> [^rc-XXXX]: or [^kb-factId]:
    const defPattern = new RegExp(`^\\[\\^${fnNum}\\]:`, 'gm');
    modified = modified.replace(defPattern, `[^${refId}]:`);
  }

  // Create DB entries if requested — only for rc-XXXX refs (not kb- refs)
  let dbEntriesCreated = false;
  if (createDbEntries) {
    const serverAvailable = await isServerAvailable();
    if (serverAvailable) {
      // Only create DB entries for footnotes that got rc-XXXX refs (not kb- refs)
      const rcFootnotes = footnotes.filter((fn) => {
        const refId = refMap.get(fn.number);
        return refId && refId.startsWith('rc-');
      });

      const citationInserts: PageCitationInsert[] = rcFootnotes.map((fn) => ({
        referenceId: refMap.get(fn.number)!,
        pageId,
        title: fn.title ?? undefined,
        url: fn.url ?? undefined,
        note: fn.rawText,
        resourceId: fn.url ? (getResourceByUrl(fn.url)?.id ?? undefined) : undefined,
      }));

      if (citationInserts.length > 0) {
        for (let i = 0; i < citationInserts.length; i += 200) {
          const batch = citationInserts.slice(i, i + 200);
          const result = await createCitationsBatch(batch);
          if (result.ok) {
            dbEntriesCreated = true;
          }
        }
      }
    }
  }

  return {
    content: modified,
    convertedCount: footnotes.length,
    kbMatchCount,
    dbEntriesCreated,
  };
}

// ---------------------------------------------------------------------------
// DB entry creation for already-converted content
// ---------------------------------------------------------------------------

/**
 * Parse [^rc-XXXX] footnote definitions from content and create DB citation entries.
 *
 * Called by the pipeline after --apply to register the converted footnotes in the DB.
 * Only processes [^rc-XXXX] definitions (not [^cr-XXXX] which are claim-backed).
 *
 * @returns Number of citations created, or 0 if server unavailable or no rc- footnotes.
 */
export async function createDbEntriesForRcFootnotes(
  content: string,
  pageId: string,
): Promise<number> {
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) return 0;

  // Find all [^rc-XXXX]: definition lines
  const rcDefPattern = /^\[\^(rc-[a-f0-9]+)\]:\s*(.*)/gm;
  const entries: Array<{ referenceId: string; rawText: string }> = [];

  let match;
  while ((match = rcDefPattern.exec(content)) !== null) {
    entries.push({
      referenceId: match[1],
      rawText: match[2].trim(),
    });
  }

  if (entries.length === 0) return 0;

  // Extract URLs and titles from the raw text
  const citationInserts: PageCitationInsert[] = entries.map((entry) => {
    const mdLink = entry.rawText.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    const bareUrl = entry.rawText.match(/(https?:\/\/[^\s,)"']+)/);

    const resolvedUrl = mdLink?.[2] ?? bareUrl?.[1];
    return {
      referenceId: entry.referenceId,
      pageId,
      title: mdLink?.[1] ?? undefined,
      url: resolvedUrl ?? undefined,
      note: entry.rawText,
      resourceId: resolvedUrl ? (getResourceByUrl(resolvedUrl)?.id ?? undefined) : undefined,
    };
  });

  let created = 0;
  for (let i = 0; i < citationInserts.length; i += 200) {
    const batch = citationInserts.slice(i, i + 200);
    const result = await createCitationsBatch(batch);
    if (result.ok) {
      created += batch.length;
    }
  }

  return created;
}
