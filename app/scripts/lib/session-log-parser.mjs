/**
 * Session Log Parser
 *
 * Parses session log entries from both the consolidated .claude/session-log.md
 * and individual session files in .claude/sessions/*.md.
 *
 * IMPORTANT: If you change the session entry format, also update:
 *   - .claude/rules/session-logging.md (the format spec for contributors)
 *   - The tests in app/scripts/lib/__tests__/session-log-parser.test.mjs
 *
 * If you change where session files are stored, also update:
 *   - The caller in app/scripts/build-data.mjs (paths passed to parseAllSessionLogs)
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Parse session log content (a markdown string) and return a map of
 * pageId → ChangeEntry[].
 *
 * Each session entry looks like:
 *   ## 2026-02-13 | branch-name | Short title
 *   **What was done:** Summary text.
 *   **Pages:** page-id-1, page-id-2
 *   **PR:** #123
 *   ...
 */
export function parseSessionLogContent(content) {
  const pageHistory = {};

  const entryPattern = /^## (\d{4}-\d{2}-\d{2}) \| ([^\|]+?) \| (.+)$/gm;
  const entries = [];
  let match;

  while ((match = entryPattern.exec(content)) !== null) {
    entries.push({
      date: match[1],
      branch: match[2].trim(),
      title: match[3].trim(),
      startIndex: match.index,
    });
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const endIndex = i + 1 < entries.length ? entries[i + 1].startIndex : content.length;
    const body = content.slice(entry.startIndex, endIndex);

    // Extract "What was done" summary
    const summaryMatch = body.match(/\*\*What was done:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    const summary = summaryMatch ? summaryMatch[1].trim() : '';

    // Extract "Pages" list
    const pagesMatch = body.match(/\*\*Pages:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    if (!pagesMatch) continue; // No pages field — infrastructure-only session

    const pageIds = pagesMatch[1]
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0 && /^[a-z0-9][a-z0-9-]*$/.test(id));

    // Extract optional "PR" field — supports "#123" or full GitHub URL
    const prMatch = body.match(/\*\*PR:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    let pr = undefined;
    if (prMatch) {
      const raw = prMatch[1].trim();
      // Extract PR number from "#123" or "https://github.com/.../pull/123"
      const numMatch = raw.match(/^#(\d+)$/) || raw.match(/\/pull\/(\d+)/);
      if (numMatch) {
        pr = parseInt(numMatch[1], 10);
      }
    }

    const changeEntry = {
      date: entry.date,
      branch: entry.branch,
      title: entry.title,
      summary,
      ...(pr !== undefined && { pr }),
    };

    for (const pageId of pageIds) {
      if (!pageHistory[pageId]) {
        pageHistory[pageId] = [];
      }
      pageHistory[pageId].push(changeEntry);
    }
  }

  return pageHistory;
}

/**
 * Collect all session log content from both the consolidated session-log.md
 * and individual session files in .claude/sessions/*.md, then parse into
 * a merged pageId → ChangeEntry[] map.
 *
 * Deduplicates entries that appear in both sources (same date+branch+title+pageId).
 */
export function parseAllSessionLogs(consolidatedLogPath, sessionsDir) {
  const allContent = [];

  // Read consolidated log if it exists
  if (existsSync(consolidatedLogPath)) {
    allContent.push(readFileSync(consolidatedLogPath, 'utf-8'));
  }

  // Read individual session files
  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      if (statSync(filePath).isFile()) {
        allContent.push(readFileSync(filePath, 'utf-8'));
      }
    }
  }

  if (allContent.length === 0) return {};

  // Parse each source separately, then merge with deduplication
  const merged = {};
  const seen = new Set(); // Track "date|branch|title|pageId" to deduplicate

  for (const content of allContent) {
    const partial = parseSessionLogContent(content);
    for (const [pageId, entries] of Object.entries(partial)) {
      if (!merged[pageId]) merged[pageId] = [];
      for (const entry of entries) {
        const key = `${entry.date}|${entry.branch}|${entry.title}|${pageId}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged[pageId].push(entry);
        }
      }
    }
  }

  return merged;
}
