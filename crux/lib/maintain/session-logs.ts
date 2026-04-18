/**
 * Session log parsing and loading.
 *
 * Parses the structured markdown format used by agent session logs.
 * Loads from wiki-server DB (primary) with local file fallback.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../content-types.ts';
import { listAgentSessions } from '../wiki-server/agent-sessions.ts';
import type { SessionLogEntry } from './types.ts';

const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');

/** Terminator pattern shared with canonical parser — matches \n\n, \n**, or \n--- */
const SECTION_END = /(?:\n\n|\n\*\*|\n---)/;

export function parseSessionLog(content: string): SessionLogEntry | null {
  const headerMatch = content.match(/^## (\d{4}-\d{2}-\d{2}) \| ([^\|]+?) \| (.+)/m);
  if (!headerMatch) return null;

  const [, date, branch, title] = headerMatch;

  // Extract "What was done" — aligned with canonical parser terminators
  const whatMatch = content.match(new RegExp(`\\*\\*What was done:\\*\\*\\s*(.+?)${SECTION_END.source}`, 's'));
  const whatWasDone = whatMatch ? whatMatch[1].trim() : '';

  // Extract "Pages" — aligned with canonical parser terminators
  const pagesMatch = content.match(new RegExp(`\\*\\*Pages:\\*\\*\\s*(.+?)${SECTION_END.source}`, 's'));
  const pages = pagesMatch
    ? pagesMatch[1].split(',').map(p => p.trim()).filter(p => /^[a-z0-9][a-z0-9-]*$/.test(p))
    : [];

  // Extract "Issues encountered"
  const issuesMatch = content.match(/\*\*Issues encountered:\*\*\s*([\s\S]+?)(?:\n\*\*|\n##|\n---|$)/);
  const issuesRaw = issuesMatch ? issuesMatch[1].trim() : '';
  const issues = (!issuesRaw || issuesRaw === 'None' || issuesRaw === '- None')
    ? []
    : issuesRaw.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  // Extract "Learnings/notes"
  const learningsMatch = content.match(/\*\*Learnings\/notes:\*\*\s*([\s\S]+?)(?:\n##|\n---|$)/);
  const learningsRaw = learningsMatch ? learningsMatch[1].trim() : '';
  const learnings = (!learningsRaw || learningsRaw === 'None' || learningsRaw === '- None')
    ? []
    : learningsRaw.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  return { date, branch: branch.trim(), title: title.trim(), whatWasDone, pages, issues, learnings };
}

/** Parse a JSON value that may be an array of strings, a JSON string, or return empty. */
export function parseJsonArray(json: unknown): string[] {
  if (!json) return [];
  if (Array.isArray(json)) return json.filter((s: unknown) => typeof s === 'string');
  if (typeof json === 'string') {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed.filter((s: unknown) => typeof s === 'string');
    } catch { /* invalid JSON */ }
  }
  return [];
}

/**
 * Load session logs from the wiki-server DB (primary source of truth).
 * Falls back to local files if the server is unavailable.
 */
export async function loadSessionLogsSince(since: string): Promise<SessionLogEntry[]> {
  // Try DB-backed sessions first (canonical source per session-logging.md)
  try {
    const result = await listAgentSessions(200);
    if (result.ok) {
      const entries: SessionLogEntry[] = [];
      for (const row of result.data.sessions) {
        // Prefer explicit session date, fall back to started_at.
        // The sweep endpoint and crashed sessions leave `date` null; without this
        // fallback the retrospective tool reports 0 sessions despite hundreds being present.
        const sessionDate = row.date?.slice(0, 10) ?? row.startedAt?.slice(0, 10);
        if (!sessionDate || sessionDate < since) continue;

        const issues = parseJsonArray(row.issuesJson);
        const learnings = parseJsonArray(row.learningsJson);
        const pages: string[] = []; // pages not included in list endpoint

        entries.push({
          date: sessionDate,
          branch: row.branch || '',
          title: row.title ?? row.task ?? '',
          whatWasDone: row.summary || '',
          pages,
          issues,
          learnings,
        });
      }
      return entries;
    }
  } catch { /* fall through to local files */ }

  return loadSessionLogsFromFiles(since);
}

/** Fallback: load session logs from local .md and .yaml files. */
export function loadSessionLogsFromFiles(since: string): SessionLogEntry[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.md') || f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const entries: SessionLogEntry[] = [];

  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch || dateMatch[1] < since) continue;

    const content = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
    const entry = parseSessionLog(content);
    if (entry) entries.push(entry);
  }

  return entries;
}
