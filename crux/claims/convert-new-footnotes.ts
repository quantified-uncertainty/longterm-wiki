/**
 * Convert numbered footnotes in LLM-generated content to DB-driven references.
 *
 * When the improve pipeline generates new content, footnotes come out as [^N]
 * because LLMs are unreliable at generating hash-based IDs. This module:
 *
 * 1. Finds all [^N] footnotes in the content
 * 2. Generates [^rc-XXXX] reference IDs for each
 * 3. Rewrites inline refs and definitions
 * 4. Optionally creates DB citation entries via the wiki-server API
 *
 * Used as a post-processing step in the improve pipeline.
 */

import { createHash } from 'crypto';
import { parseFootnotes } from '../lib/footnote-parser.ts';
import { createCitationsBatch } from '../lib/wiki-server/references.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import type { PageCitationInsert } from '../../apps/wiki-server/src/api-types.ts';

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
  /** The rewritten content with [^rc-XXXX] references */
  content: string;
  /** Number of footnotes converted */
  convertedCount: number;
  /** Whether DB entries were created */
  dbEntriesCreated: boolean;
}

/**
 * Convert numbered footnotes [^N] in content to DB-driven [^rc-XXXX] references.
 *
 * @param content - MDX content with [^N] style footnotes
 * @param pageId - Entity ID for the page (used in DB entries and hash generation)
 * @param options.createDbEntries - Whether to create citation entries in the DB (default: false)
 */
export async function convertNewFootnotes(
  content: string,
  pageId: string,
  options: { createDbEntries?: boolean } = {},
): Promise<ConvertResult> {
  const { createDbEntries = false } = options;

  // Parse existing numbered footnotes
  const footnotes = parseFootnotes(content);
  if (footnotes.length === 0) {
    return { content, convertedCount: 0, dbEntriesCreated: false };
  }

  // Also check if there are already [^rc-XXXX] or [^cr-XXXX] refs in the content.
  // Collect their IDs so we don't collide.
  const existingIds = new Set<string>();
  const existingRefPattern = /\[\^((?:rc|cr)-[a-f0-9]+)\]/g;
  let existingMatch;
  while ((existingMatch = existingRefPattern.exec(content)) !== null) {
    existingIds.add(existingMatch[1]);
  }

  // Build mapping: footnote number -> new reference ID
  const refMap = new Map<number, string>();
  for (const fn of footnotes) {
    const refId = generateRefId(
      `cite:${pageId}:${fn.number}:${fn.url ?? fn.rawText}`,
      existingIds,
    );
    refMap.set(fn.number, refId);
  }

  // Rewrite content: replace inline refs and definition lines
  let modified = content;

  // Replace inline references [^N] -> [^rc-XXXX] (process in reverse order)
  const sortedEntries = [...refMap.entries()].sort((a, b) => b[0] - a[0]);
  for (const [fnNum, refId] of sortedEntries) {
    // Replace inline references [^N] (not definition lines [^N]:)
    const inlinePattern = new RegExp(`\\[\\^${fnNum}\\](?!:)`, 'g');
    modified = modified.replace(inlinePattern, `[^${refId}]`);

    // Replace definition line [^N]: -> [^rc-XXXX]:
    const defPattern = new RegExp(`^\\[\\^${fnNum}\\]:`, 'gm');
    modified = modified.replace(defPattern, `[^${refId}]:`);
  }

  // Create DB entries if requested
  let dbEntriesCreated = false;
  if (createDbEntries) {
    const serverAvailable = await isServerAvailable();
    if (serverAvailable) {
      const citationInserts: PageCitationInsert[] = footnotes.map((fn) => ({
        referenceId: refMap.get(fn.number)!,
        pageId,
        title: fn.title ?? undefined,
        url: fn.url ?? undefined,
        note: fn.rawText,
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

    return {
      referenceId: entry.referenceId,
      pageId,
      title: mdLink?.[1] ?? undefined,
      url: mdLink?.[2] ?? bareUrl?.[1] ?? undefined,
      note: entry.rawText,
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
