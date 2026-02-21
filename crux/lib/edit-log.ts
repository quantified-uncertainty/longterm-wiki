/**
 * Edit Log — per-page edit history
 *
 * Dual-write strategy:
 * - YAML files in data/edit-logs/<page-id>.yaml (always written, backward-compatible)
 * - PostgreSQL via wiki-server API (written when server is available, fire-and-forget)
 *
 * Reads come from YAML by default. The CLI commands can optionally read from the
 * server API for cross-page queries when the server is available.
 *
 * Usage:
 *   import { appendEditLog } from '../lib/edit-log.ts';
 *   appendEditLog('open-philanthropy', {
 *     tool: 'crux-improve',
 *     agency: 'ai-directed',
 *     requestedBy: 'ozzie',
 *     note: 'Added 2024 funding data',
 *   });
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { appendEditLogToServer } from './wiki-server-client.ts';

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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CONTENT_DIR = path.join(ROOT, 'content/docs');
const EDIT_LOGS_DIR = path.join(ROOT, 'data/edit-logs');

function logFilePath(pageId: string): string {
  return path.join(EDIT_LOGS_DIR, `${pageId}.yaml`);
}

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

/** Read the edit log for a page from YAML. Returns [] if no log exists. */
export function readEditLog(pageId: string): EditLogEntry[] {
  const filePath = logFilePath(pageId);
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);

  if (!Array.isArray(parsed)) return [];

  // Normalize dates that YAML parser may have converted to Date objects
  return parsed.map((entry: Record<string, unknown>) => ({
    ...entry,
    date: entry.date instanceof Date
      ? entry.date.toISOString().split('T')[0]
      : String(entry.date),
  })) as EditLogEntry[];
}

/**
 * Append a single entry to a page's edit log.
 *
 * Dual-write: always writes to YAML, then attempts to write to the wiki-server
 * database via API. The API write is fire-and-forget — failures are silently
 * ignored since YAML is the authoritative source during the migration period.
 */
export function appendEditLog(pageId: string, entry: Omit<EditLogEntry, 'date'> & { date?: string }): void {
  const existing = readEditLog(pageId);

  const fullEntry: EditLogEntry = {
    date: entry.date || new Date().toISOString().split('T')[0],
    tool: entry.tool,
    agency: entry.agency,
    ...(entry.requestedBy != null && { requestedBy: entry.requestedBy }),
    ...(entry.note != null && { note: entry.note }),
  };

  existing.push(fullEntry);

  if (!fs.existsSync(EDIT_LOGS_DIR)) {
    fs.mkdirSync(EDIT_LOGS_DIR, { recursive: true });
  }

  fs.writeFileSync(
    logFilePath(pageId),
    stringifyYaml(existing, { lineWidth: 0 }),
  );

  // Fire-and-forget write to wiki-server DB
  appendEditLogToServer({
    pageId,
    date: fullEntry.date,
    tool: fullEntry.tool,
    agency: fullEntry.agency,
    requestedBy: fullEntry.requestedBy ?? null,
    note: fullEntry.note ?? null,
  }).catch(() => {
    // Silently ignore — YAML is authoritative during migration period
  });
}

/**
 * Log a bulk fix operation that modified multiple files.
 * Appends one entry per affected page.
 */
export function logBulkFixes(
  filePaths: string[],
  entry: Omit<EditLogEntry, 'date'> & { date?: string },
): void {
  for (const fp of filePaths) {
    const pageId = pageIdFromPath(fp);
    appendEditLog(pageId, entry);
  }
}
