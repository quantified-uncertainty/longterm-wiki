/**
 * Audit Command Handlers — universal PG audit log (QUA-442)
 *
 * Usage:
 *   crux audit recent [--table=T] [--session=S] [--txn=N] [--since=ISO] [--limit=N]
 *     Print the most recent audit entries. Filters compose (AND).
 *   crux audit recent --json
 *     Emit newline-delimited JSON for scripting.
 *
 * Data source: `full_audit_log` in PG, written by the `audit_trigger_fn()`
 * trigger. Every write to an allow-listed table creates one row here with
 * before/after JSONB plus session+tool attribution.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  listRecentAuditEntries,
  type AuditRecentResponse,
} from '../lib/wiki-server/audit-log.ts';
import { truncate } from '../lib/text-utils.ts';

interface CommandOptions extends BaseOptions {
  ci?: boolean;
  json?: boolean;
  table?: string;
  session?: string;
  txn?: string;
  since?: string;
  limit?: string;
}

type AuditEntry = AuditRecentResponse['entries'][number];

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function formatChangedAt(value: AuditEntry['changedAt']): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}

function summarizeRow(row: Record<string, unknown> | null | undefined): string {
  if (!row) return '';
  const id = row.id ?? row.stable_id ?? row.stableId ?? null;
  const title =
    row.title ?? row.name ?? row.display_name ?? row.displayName ?? null;
  const parts: string[] = [];
  if (id !== null && id !== undefined) parts.push(`id=${String(id)}`);
  if (title !== null && title !== undefined) parts.push(`title=${truncate(String(title), 40)}`);
  if (parts.length === 0) {
    // Fall back to a short key list so callers know something is there.
    const keys = Object.keys(row).slice(0, 4).join(',');
    return keys ? `{${keys}…}` : '';
  }
  return parts.join(' ');
}

async function recent(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const limit = parseLimit(options.limit, 50, 500);

  const result = await listRecentAuditEntries({
    table: options.table,
    session: options.session,
    txn: options.txn,
    since: options.since,
    limit,
  });

  if (!result.ok) {
    const message =
      result.error === 'unavailable'
        ? `wiki-server unavailable: ${result.message}`
        : `audit log request failed: ${result.message}`;
    return { output: message, exitCode: 1 };
  }

  const { entries } = result.data;

  if (options.json) {
    const lines = entries.map((e) => JSON.stringify(e));
    return { output: lines.join('\n'), exitCode: 0 };
  }

  if (entries.length === 0) {
    return {
      output: 'No audit entries match the given filters.',
      exitCode: 0,
    };
  }

  const lines: string[] = [];
  lines.push(
    `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (filters: ${describeFilters(options)})`,
  );
  for (const e of entries) {
    const when = formatChangedAt(e.changedAt);
    const attr = [
      e.sessionId ? `session=${e.sessionId}` : null,
      e.tool ? `tool=${e.tool}` : null,
      e.txnId ? `txn=${e.txnId}` : null,
    ]
      .filter((v): v is string => Boolean(v))
      .join(' ');
    const summary =
      e.operation === 'DELETE'
        ? summarizeRow(e.oldRow as Record<string, unknown> | null)
        : summarizeRow(e.newRow as Record<string, unknown> | null);
    lines.push(
      `  ${when}  ${e.operation.padEnd(6)} ${e.tableName.padEnd(28)}  ${summary}${attr ? `  [${attr}]` : ''}`,
    );
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

function describeFilters(options: CommandOptions): string {
  const parts: string[] = [];
  if (options.table) parts.push(`table=${options.table}`);
  if (options.session) parts.push(`session=${options.session}`);
  if (options.txn) parts.push(`txn=${options.txn}`);
  if (options.since) parts.push(`since=${options.since}`);
  parts.push(`limit=${parseLimit(options.limit, 50, 500)}`);
  return parts.join(' ');
}

export const commands = {
  default: recent,
  recent,
};

export function getHelp(): string {
  return `
Audit Domain - Universal PG audit log (QUA-442)

Commands:
  recent                    Show recent audit entries (default)

Options:
  --table=T        Filter by table name (e.g. --table=personnel)
  --session=S      Filter by agent session ID
  --txn=N          Filter by PostgreSQL transaction id
  --since=ISO      Only entries newer than this ISO timestamp (e.g. 2026-04-10T00:00:00Z)
  --limit=N        Maximum number of entries to return (default: 50, max: 500)
  --json           Output one JSON object per entry (newline-delimited)

Examples:
  crux audit recent                                   50 most recent entries across all tables
  crux audit recent --table=personnel --limit=100     recent personnel writes
  crux audit recent --session=12345                    all writes from one session
  crux audit recent --txn=98765                        all rows changed in one transaction
  crux audit recent --since=2026-04-20T00:00:00Z --table=grants --json

Data lives in the PG \`full_audit_log\` table. Every allow-listed table
has an AFTER INSERT/UPDATE/DELETE trigger (\`zz_audit_trigger\`) that
writes a row here with before/after JSONB + session attribution.
`.trim();
}
