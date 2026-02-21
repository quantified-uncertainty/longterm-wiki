/**
 * Edit Log Command Handlers
 *
 * View and query the per-page edit history from the PostgreSQL database
 * via the wiki-server API.
 *
 * Usage:
 *   crux edit-log view <page-id>      Show edit history for a page
 *   crux edit-log list                List all pages with edit logs
 *   crux edit-log stats               Show edit log statistics
 */

import type { CommandResult } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import { getEditLogsForPage, getEditLogStats } from '../lib/wiki-server-client.ts';

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

  const result = await getEditLogsForPage(pageId);
  if (!result) {
    return { output: `${c.red}Error: wiki-server not available. Check LONGTERMWIKI_SERVER_URL.${c.reset}`, exitCode: 1 };
  }

  const entries = result.entries;

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
 * List all pages with edit logs (queries DB for paginated listing)
 */
export async function list(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const filterTool = options.tool as string | undefined;
  const filterAgency = options.agency as string | undefined;
  const limit = parseInt((options.limit as string) || '50', 10);

  // Use the stats endpoint to get a page-level overview, then list individual pages
  const serverStats = await getEditLogStats();
  if (!serverStats) {
    return { output: `${c.red}Error: wiki-server not available. Check LONGTERMWIKI_SERVER_URL.${c.reset}`, exitCode: 1 };
  }

  // For list, we query the /all endpoint and group by page
  const { getServerUrl, buildHeaders } = await import('../lib/wiki-server-client.ts');
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { output: `${c.red}Error: wiki-server not available. Check LONGTERMWIKI_SERVER_URL.${c.reset}`, exitCode: 1 };
  }

  try {
    // Fetch enough entries to build a per-page summary
    const params = new URLSearchParams({ limit: '5000', offset: '0' });
    if (filterTool) params.set('tool', filterTool);
    if (filterAgency) params.set('agency', filterAgency);

    const res = await fetch(`${serverUrl}/api/edit-logs/all?${params}`, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { output: `${c.red}Error: wiki-server returned ${res.status}${c.reset}`, exitCode: 1 };
    }

    const data = await res.json() as {
      entries: Array<{
        pageId: string;
        date: string;
        tool: string;
        agency: string;
      }>;
      total: number;
    };

    // Group by page
    interface PageSummary {
      id: string;
      entryCount: number;
      lastDate: string;
      lastTool: string;
      lastAgency: string;
    }

    const pageMap = new Map<string, PageSummary>();
    for (const e of data.entries) {
      // Apply tool/agency filters
      if (filterTool && e.tool !== filterTool) continue;
      if (filterAgency && e.agency !== filterAgency) continue;

      const existing = pageMap.get(e.pageId);
      if (!existing) {
        pageMap.set(e.pageId, {
          id: e.pageId,
          entryCount: 1,
          lastDate: e.date,
          lastTool: e.tool,
          lastAgency: e.agency,
        });
      } else {
        existing.entryCount++;
        if (e.date > existing.lastDate) {
          existing.lastDate = e.date;
          existing.lastTool = e.tool;
          existing.lastAgency = e.agency;
        }
      }
    }

    let summaries = Array.from(pageMap.values());
    summaries.sort((a, b) => b.lastDate.localeCompare(a.lastDate));
    summaries = summaries.slice(0, limit);

    if (options.ci || options.json) {
      return { output: JSON.stringify(summaries, null, 2), exitCode: 0 };
    }

    let output = '';
    output += `${c.bold}${c.blue}Pages with Edit Logs${c.reset}\n`;
    output += `${c.dim}${summaries.length} of ${pageMap.size} pages${c.reset}\n\n`;

    output += `${c.bold}${'Last Edit'.padEnd(12)} ${'#'.padStart(4)}  ${'Tool'.padEnd(16)} Page${c.reset}\n`;
    output += `${c.dim}${'─'.repeat(65)}${c.reset}\n`;

    for (const s of summaries) {
      output += `${s.lastDate}  ${String(s.entryCount).padStart(3)}  ${s.lastTool.padEnd(16)} ${s.id}\n`;
    }

    return { output, exitCode: 0 };
  } catch {
    return { output: `${c.red}Error: failed to query wiki-server${c.reset}`, exitCode: 1 };
  }
}

/**
 * Show aggregate statistics
 */
export async function stats(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const serverStats = await getEditLogStats();
  if (!serverStats) {
    return { output: `${c.red}Error: wiki-server not available. Check LONGTERMWIKI_SERVER_URL.${c.reset}`, exitCode: 1 };
  }

  if (options.ci || options.json) {
    return { output: JSON.stringify(serverStats, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Edit Log Statistics${c.reset}\n\n`;
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

Examples:
  crux edit-log view open-philanthropy
  crux edit-log list --tool=crux-improve
  crux edit-log stats
  crux edit-log list --agency=human --limit=10
`;
}
