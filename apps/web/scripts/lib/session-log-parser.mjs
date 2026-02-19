/**
 * Session Log Parser
 *
 * Parses session log entries from:
 * 1. Individual YAML session files in .claude/sessions/*.yaml (new format)
 * 2. Individual Markdown session files in .claude/sessions/*.md (legacy format)
 * 3. The consolidated .claude/session-log.md (legacy format)
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
import { parse as parseYaml } from 'yaml';

/**
 * Parse a single YAML session log file into a map of pageId → ChangeEntry[].
 *
 * Expected YAML structure:
 *   date: 2026-02-19
 *   branch: claude/fix-something-AbC12
 *   title: Fix something
 *   model: opus-4-6        # optional
 *   duration: ~45min       # optional
 *   cost: ~$5              # optional
 *   pages: [page-id-1, page-id-2]  # optional
 *   summary: >
 *     What was done...
 *   pr: 123                # optional (integer)
 *   issues: [...]          # optional, for human readability
 *   learnings: [...]       # optional, for human readability
 *   recommendations: [...] # optional, for human readability
 */
export function parseYamlSessionLog(content) {
  const pageHistory = {};

  let data;
  try {
    data = parseYaml(content);
  } catch {
    return pageHistory; // Invalid YAML — skip silently
  }

  if (!data || typeof data !== 'object') return pageHistory;

  const { date, branch, title, summary, pages, pr, model, duration, cost } = data;

  if (!date || !branch || !title) return pageHistory; // Required fields missing

  const pageIds = Array.isArray(pages)
    ? pages.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id))
    : [];

  if (pageIds.length === 0) return pageHistory; // No pages — infrastructure-only session

  // Extract PR number
  let prNum;
  if (typeof pr === 'number') {
    prNum = pr;
  } else if (typeof pr === 'string') {
    const numMatch = pr.match(/^#(\d+)$/) || pr.match(/\/pull\/(\d+)/);
    if (numMatch) prNum = parseInt(numMatch[1], 10);
  }

  const changeEntry = {
    date: String(date),
    branch: String(branch),
    title: String(title),
    summary: typeof summary === 'string' ? summary.trim() : '',
    ...(prNum !== undefined && { pr: prNum }),
    ...(model !== undefined && { model: String(model) }),
    ...(duration !== undefined && { duration: String(duration) }),
    ...(cost !== undefined && { cost: String(cost) }),
  };

  for (const pageId of pageIds) {
    if (!pageHistory[pageId]) pageHistory[pageId] = [];
    pageHistory[pageId].push(changeEntry);
  }

  return pageHistory;
}

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

    // Extract optional "Model" field (e.g., "opus-4-6", "sonnet-4")
    const modelMatch = body.match(/\*\*Model:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    const model = modelMatch ? modelMatch[1].trim() : undefined;

    // Extract optional "Duration" field (e.g., "~45min", "~2h")
    const durationMatch = body.match(/\*\*Duration:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    const duration = durationMatch ? durationMatch[1].trim() : undefined;

    // Extract optional "Cost" field (e.g., "~$5", "~$12 (premium tier)")
    const costMatch = body.match(/\*\*Cost:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n---)/s);
    const cost = costMatch ? costMatch[1].trim() : undefined;

    const changeEntry = {
      date: entry.date,
      branch: entry.branch,
      title: entry.title,
      summary,
      ...(pr !== undefined && { pr }),
      ...(model !== undefined && { model }),
      ...(duration !== undefined && { duration }),
      ...(cost !== undefined && { cost }),
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
 * Collect all session log content from:
 * 1. YAML files in .claude/sessions/*.yaml (new format, parsed directly)
 * 2. Markdown files in .claude/sessions/*.md (legacy format, regex-parsed)
 * 3. The consolidated session-log.md (legacy format, regex-parsed)
 *
 * Returns a merged pageId → ChangeEntry[] map with deduplication.
 *
 * Deduplicates entries that appear in both sources (same date+branch+title+pageId).
 */
export function parseAllSessionLogs(consolidatedLogPath, sessionsDir) {
  const merged = {};
  const seen = new Set(); // Track "date|branch|title|pageId" to deduplicate

  function mergePartial(partial) {
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

  // Read consolidated log if it exists (legacy Markdown)
  if (existsSync(consolidatedLogPath)) {
    const content = readFileSync(consolidatedLogPath, 'utf-8');
    mergePartial(parseSessionLogContent(content));
  }

  // Read individual session files (YAML first, then Markdown legacy)
  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir).sort();

    for (const file of files) {
      const filePath = join(sessionsDir, file);
      if (!statSync(filePath).isFile()) continue;

      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        const content = readFileSync(filePath, 'utf-8');
        mergePartial(parseYamlSessionLog(content));
      } else if (file.endsWith('.md')) {
        const content = readFileSync(filePath, 'utf-8');
        mergePartial(parseSessionLogContent(content));
      }
    }
  }

  return merged;
}
