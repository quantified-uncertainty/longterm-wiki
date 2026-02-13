/**
 * Edit Log — per-page edit history stored in data/edit-logs/<page-id>.yaml
 *
 * Each page gets a YAML file tracking every creation, improvement, grading,
 * or manual edit. Stored outside frontmatter so LLM-generated content can't
 * corrupt the log, and the log can grow without cluttering page metadata.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The tool or pipeline that performed the edit. */
export type EditTool =
  | 'crux-create'    // pnpm crux content create
  | 'crux-improve'   // pnpm crux content improve
  | 'crux-grade'     // Crux grading pipeline
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
const EDIT_LOGS_DIR = path.join(ROOT, 'data/edit-logs');

function logFilePath(pageId: string): string {
  return path.join(EDIT_LOGS_DIR, `${pageId}.yaml`);
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/** Read the edit log for a page. Returns [] if no log exists. */
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

/** Append a single entry to a page's edit log. Creates the file if needed. */
export function appendEditLog(pageId: string, entry: Omit<EditLogEntry, 'date'> & { date?: string }): void {
  const existing = readEditLog(pageId);

  const fullEntry: EditLogEntry = {
    date: entry.date || new Date().toISOString().split('T')[0],
    tool: entry.tool,
    agency: entry.agency,
    ...(entry.requestedBy && { requestedBy: entry.requestedBy }),
    ...(entry.note && { note: entry.note }),
  };

  existing.push(fullEntry);

  if (!fs.existsSync(EDIT_LOGS_DIR)) {
    fs.mkdirSync(EDIT_LOGS_DIR, { recursive: true });
  }

  fs.writeFileSync(
    logFilePath(pageId),
    stringifyYaml(existing, { lineWidth: 0 }),
  );
}
