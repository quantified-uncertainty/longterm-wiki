/**
 * Edit Log Command Handlers
 *
 * View and query the per-page edit history. Reads from YAML files by default.
 * When --source=db is passed (and the wiki-server is available), queries the
 * PostgreSQL database via API instead.
 *
 * Usage:
 *   crux edit-log view <page-id>      Show edit history for a page
 *   crux edit-log list                List all pages with edit logs
 *   crux edit-log stats               Show edit log statistics
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import type { CommandResult } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import { readEditLog } from '../lib/edit-log.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getEditLogsForPage, getEditLogStats } from '../lib/wiki-server-client.ts';

const EDIT_LOGS_DIR = join(PROJECT_ROOT, 'data/edit-logs');

function getAllLoggedPageIds(): string[] {
  try {
    return readdirSync(EDIT_LOGS_DIR)
      .filter((f: string) => f.endsWith('.yaml'))
      .map((f: string) => f.replace(/\.yaml$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function useDb(options: Record<string, unknown>): boolean {
  return options.source === 'db';
}

/**
 * View edit history for a specific page
 */
export async function view(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args[0];
  if (!pageId) {
    return { output: `${c.red}Error: page ID required. Usage: crux edit-log view <page-id>${c.reset}`, exitCode: 1 };
  }

  // Try DB source if requested
  if (useDb(options)) {
    const result = await getEditLogsForPage(pageId);
    if (result) {
      const entries = result.entries;

      if (options.ci || options.json) {
        return { output: JSON.stringify(entries, null, 2), exitCode: 0 };
      }

      if (entries.length === 0) {
        return { output: `${c.dim}No edit log found for "${pageId}" (source: db)${c.reset}`, exitCode: 0 };
      }

      let output = '';
      output += `${c.bold}${c.blue}Edit History: ${pageId}${c.reset} ${c.dim}(source: db)${c.reset}\n`;
      output += `${c.dim}${entries.length} entries${c.reset}\n\n`;

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const agencyIcon = e.agency === 'human' ? 'H' : e.agency === 'ai-directed' ? 'A' : 'S';
        const agencyColor = e.agency === 'human' ? c.green : e.agency === 'ai-directed' ? c.cyan : c.dim;

        output += `${c.dim}${String(i + 1).padStart(3)}.${c.reset} `;
        output += `${c.bold}${e.date}${c.reset} `;
        output += `[${agencyColor}${agencyIcon}${c.reset}] `;
        output += `${e.tool}`;
        if (e.requestedBy) output += ` ${c.dim}by ${e.requestedBy}${c.reset}`;
        output += '\n';
        if (e.note) {
          output += `       ${c.dim}${e.note}${c.reset}\n`;
        }
      }

      output += `\n${c.dim}Agency: [H]=human [A]=ai-directed [S]=automated${c.reset}`;
      return { output, exitCode: 0 };
    }
    return { output: `${c.red}Error: wiki-server not available. Check LONGTERMWIKI_SERVER_URL.${c.reset}`, exitCode: 1 };
  }

  // Default: YAML source
  const entries = readEditLog(pageId);

  if (options.ci || options.json) {
    return { output: JSON.stringify(entries, null, 2), exitCode: 0 };
  }

  if (entries.length === 0) {
    return { output: `${c.dim}No edit log found for "${pageId}"${c.reset}`, exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Edit History: ${pageId}${c.reset}\n`;
  output += `${c.dim}${entries.length} entries${c.reset}\n\n`;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const agencyIcon = e.agency === 'human' ? 'H' : e.agency === 'ai-directed' ? 'A' : 'S';
    const agencyColor = e.agency === 'human' ? c.green : e.agency === 'ai-directed' ? c.cyan : c.dim;

    output += `${c.dim}${String(i + 1).padStart(3)}.${c.reset} `;
    output += `${c.bold}${e.date}${c.reset} `;
    output += `[${agencyColor}${agencyIcon}${c.reset}] `;
    output += `${e.tool}`;
    if (e.requestedBy) output += ` ${c.dim}by ${e.requestedBy}${c.reset}`;
    output += '\n';
    if (e.note) {
      output += `       ${c.dim}${e.note}${c.reset}\n`;
    }
  }

  output += `\n${c.dim}Agency: [H]=human [A]=ai-directed [S]=automated${c.reset}`;

  return { output, exitCode: 0 };
}

/**
 * List all pages with edit logs
 */
export async function list(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageIds = getAllLoggedPageIds();

  if (pageIds.length === 0) {
    return { output: `${c.dim}No edit logs found in data/edit-logs/${c.reset}`, exitCode: 0 };
  }

  const filterTool = options.tool as string | undefined;
  const filterAgency = options.agency as string | undefined;
  const limit = parseInt((options.limit as string) || '50', 10);

  interface PageSummary {
    id: string;
    entryCount: number;
    lastDate: string;
    lastTool: string;
    lastAgency: string;
  }

  let summaries: PageSummary[] = [];
  for (const id of pageIds) {
    const entries = readEditLog(id);
    if (entries.length === 0) continue;

    // Apply filters
    if (filterTool) {
      const hasMatchingEntry = entries.some(e => e.tool === filterTool);
      if (!hasMatchingEntry) continue;
    }
    if (filterAgency) {
      const hasMatchingEntry = entries.some(e => e.agency === filterAgency);
      if (!hasMatchingEntry) continue;
    }

    const last = entries[entries.length - 1];
    summaries.push({
      id,
      entryCount: entries.length,
      lastDate: last.date,
      lastTool: last.tool,
      lastAgency: last.agency,
    });
  }

  // Sort by most recent first
  summaries.sort((a, b) => b.lastDate.localeCompare(a.lastDate));
  summaries = summaries.slice(0, limit);

  if (options.ci || options.json) {
    return { output: JSON.stringify(summaries, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Pages with Edit Logs${c.reset}\n`;
  output += `${c.dim}${summaries.length} of ${pageIds.length} pages${c.reset}\n\n`;

  output += `${c.bold}${'Last Edit'.padEnd(12)} ${'#'.padStart(4)}  ${'Tool'.padEnd(16)} Page${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(65)}${c.reset}\n`;

  for (const s of summaries) {
    output += `${s.lastDate}  ${String(s.entryCount).padStart(3)}  ${s.lastTool.padEnd(16)} ${s.id}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Show aggregate statistics
 */
export async function stats(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  // Try DB source if requested
  if (useDb(options)) {
    const serverStats = await getEditLogStats();
    if (serverStats) {
      if (options.ci || options.json) {
        return { output: JSON.stringify(serverStats, null, 2), exitCode: 0 };
      }

      let output = '';
      output += `${c.bold}${c.blue}Edit Log Statistics${c.reset} ${c.dim}(source: db)${c.reset}\n\n`;
      output += `  Pages with logs: ${c.bold}${serverStats.pagesWithLogs}${c.reset}\n`;
      output += `  Total entries:   ${c.bold}${serverStats.totalEntries}${c.reset}\n\n`;

      output += `${c.bold}By Tool:${c.reset}\n`;
      for (const [tool, cnt] of Object.entries(serverStats.byTool).sort((a, b) => b[1] - a[1])) {
        output += `  ${tool.padEnd(18)} ${String(cnt).padStart(5)}\n`;
      }

      output += `\n${c.bold}By Agency:${c.reset}\n`;
      for (const [agency, cnt] of Object.entries(serverStats.byAgency).sort((a, b) => b[1] - a[1])) {
        output += `  ${agency.padEnd(18)} ${String(cnt).padStart(5)}\n`;
      }

      return { output, exitCode: 0 };
    }
    return { output: `${c.red}Error: wiki-server not available. Check LONGTERMWIKI_SERVER_URL.${c.reset}`, exitCode: 1 };
  }

  // Default: YAML source
  const pageIds = getAllLoggedPageIds();

  const toolCounts: Record<string, number> = {};
  const agencyCounts: Record<string, number> = {};
  let totalEntries = 0;

  for (const id of pageIds) {
    const entries = readEditLog(id);
    totalEntries += entries.length;
    for (const e of entries) {
      toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
      agencyCounts[e.agency] = (agencyCounts[e.agency] || 0) + 1;
    }
  }

  const statsData = {
    pagesWithLogs: pageIds.length,
    totalEntries,
    byTool: toolCounts,
    byAgency: agencyCounts,
  };

  if (options.ci || options.json) {
    return { output: JSON.stringify(statsData, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Edit Log Statistics${c.reset}\n\n`;
  output += `  Pages with logs: ${c.bold}${pageIds.length}${c.reset}\n`;
  output += `  Total entries:   ${c.bold}${totalEntries}${c.reset}\n\n`;

  output += `${c.bold}By Tool:${c.reset}\n`;
  for (const [tool, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
    output += `  ${tool.padEnd(18)} ${String(count).padStart(5)}\n`;
  }

  output += `\n${c.bold}By Agency:${c.reset}\n`;
  for (const [agency, count] of Object.entries(agencyCounts).sort((a, b) => b[1] - a[1])) {
    output += `  ${agency.padEnd(18)} ${String(count).padStart(5)}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Command registry
 */
export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {
  view,
  list,
  stats,
  default: list,
};

/**
 * Get help text
 */
export function getHelp(): string {
  return `
Edit Log Domain - View and query per-page edit history

Commands:
  view <page-id>       Show edit history for a specific page
  list                 List all pages with edit logs (default)
  stats                Show aggregate statistics

Options:
  --json               Output as JSON
  --ci                 JSON output for CI pipelines
  --tool=<tool>        Filter by tool (crux-create, crux-improve, crux-grade, crux-fix, etc.)
  --agency=<agency>    Filter by agency (human, ai-directed, automated)
  --limit=N            Number of results for list (default: 50)
  --source=db          Query wiki-server database instead of YAML files

Examples:
  crux edit-log view open-philanthropy
  crux edit-log list --tool=crux-improve
  crux edit-log stats
  crux edit-log stats --source=db
  crux edit-log list --agency=human --limit=10
`;
}
