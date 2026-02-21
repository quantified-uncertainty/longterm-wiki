/**
 * Edit Log — per-page edit history
 *
 * PostgreSQL via wiki-server API is the authoritative source.
 * YAML files in data/edit-logs/ are no longer written (removed in #485).
 *
 * Usage:
 *   import { appendEditLog } from '../lib/edit-log.ts';
 *   const result = await appendEditLog('open-philanthropy', {
 *     tool: 'crux-improve',
 *     agency: 'ai-directed',
 *     requestedBy: 'ozzie',
 *     note: 'Added 2024 funding data',
 *   });
 *   if (!result.ok) console.error('Edit log write failed:', result.message);
 */

import path from 'path';
import { appendEditLogToServer, getEditLogsForPage, type AppendResult } from './wiki-server/edit-logs.ts';
import type { ApiResult } from './wiki-server/client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The tool or pipeline that performed the edit. */
export type EditTool =
  | 'crux-create'    // pnpm crux content create
  | 'crux-improve'   // pnpm crux content improve
  | 'crux-grade'     // Crux grading pipeline
  | 'crux-fix'       // Crux fix commands (escaping, markdown, cross-links, etc.)
  | 'crux-fix-escalated' // Claude escalation for complex citation fixes
  | 'crux-audit'     // Citation audit pipeline fixes
  | 'crux-audit-escalated' // Citation audit with Claude escalation
  | 'claude-code'    // Claude Code interactive session
  | 'manual'         // Direct human file edits
  | 'bulk-script';   // Bulk automated scripts

/** How much human involvement drove this edit. */
export type EditAgency =
  | 'human'          // Human made the edit directly
  | 'ai-directed'    // Human directed AI to make the edit
  | 'automated';     // Fully automated, no human in the loop

export interface EditLogEntry {
  date: string;           // YYYY-MM-DD
  tool: EditTool;
  agency: EditAgency;
  requestedBy?: string;   // Who initiated (person name, "system", etc.)
  note?: string;          // Free-text description of what changed
}

// Re-export for callers that want to type the return value
export type { AppendResult, ApiResult };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CONTENT_DIR = path.join(ROOT, 'content/docs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract page ID (slug) from an absolute or content-relative MDX file path.
 *
 * Uses the filename (last path segment) as the slug, which matches the `page.id`
 * convention used throughout the codebase. Index files use the parent directory name.
 *
 * NOTE: This assumes all non-index MDX filenames are unique across the content tree.
 * If two pages share the same filename in different directories, they would collide.
 * As of Feb 2026 there are no such collisions among the ~625 pages.
 */
export function pageIdFromPath(filePath: string): string {
  const rel = filePath.startsWith(CONTENT_DIR)
    ? filePath.slice(CONTENT_DIR.length + 1)
    : filePath;
  return rel.replace(/\.mdx?$/, '').replace(/\/index$/, '').split('/').pop()!;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Get the default value for `requestedBy` based on environment.
 * Checks CRUX_REQUESTED_BY env var first, then falls back to USER, then 'system'.
 * Callers should use this instead of hardcoding 'system'.
 */
export function getDefaultRequestedBy(): string {
  return process.env.CRUX_REQUESTED_BY || process.env.USER || 'system';
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Read the edit log for a page from the wiki-server DB.
 * Returns [] if the server is unavailable or no log exists.
 */
export async function readEditLog(pageId: string): Promise<EditLogEntry[]> {
  const result = await getEditLogsForPage(pageId);
  if (!result.ok) return [];

  return result.data.entries.map((e) => ({
    date: e.date,
    tool: e.tool as EditTool,
    agency: e.agency as EditAgency,
    ...(e.requestedBy != null && { requestedBy: e.requestedBy }),
    ...(e.note != null && { note: e.note }),
  }));
}

/**
 * Append a single entry to a page's edit log.
 *
 * Writes to the wiki-server PostgreSQL database (authoritative source).
 * Returns an ApiResult so callers can detect and handle failures.
 * A warning is logged to stderr on failure regardless of whether the caller checks.
 *
 * Callers that do not need to detect failures can ignore the returned Promise.
 * Callers that require confirmation should `await` and check `result.ok`.
 */
export async function appendEditLog(
  pageId: string,
  entry: Omit<EditLogEntry, 'date'> & { date?: string },
): Promise<ApiResult<AppendResult>> {
  const fullEntry: EditLogEntry = {
    date: entry.date || new Date().toISOString().split('T')[0],
    tool: entry.tool,
    agency: entry.agency,
    ...(entry.requestedBy != null && { requestedBy: entry.requestedBy }),
    ...(entry.note != null && { note: entry.note }),
  };

  const result = await appendEditLogToServer({
    pageId,
    date: fullEntry.date,
    tool: fullEntry.tool,
    agency: fullEntry.agency,
    requestedBy: fullEntry.requestedBy ?? null,
    note: fullEntry.note ?? null,
  });

  if (!result.ok) {
    console.error(`  WARNING: Failed to write edit log for "${pageId}" to wiki-server: ${result.message}`);
  }

  return result;
}

/**
 * Log a bulk fix operation that modified multiple files.
 * Appends one entry per affected page, running all writes in parallel.
 * Returns an array of ApiResults — one per file — so callers can inspect failures.
 */
export async function logBulkFixes(
  filePaths: string[],
  entry: Omit<EditLogEntry, 'date'> & { date?: string },
): Promise<ApiResult<AppendResult>[]> {
  return Promise.all(
    filePaths.map((fp) => {
      const pageId = pageIdFromPath(fp);
      return appendEditLog(pageId, entry);
    }),
  );
}
