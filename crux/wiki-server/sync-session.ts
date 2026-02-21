/**
 * Wiki Server Session Sync
 *
 * Reads a single .claude/sessions/*.yaml file and POSTs it to the
 * wiki-server's /api/sessions endpoint. Fire-and-forget: errors are
 * reported but do not cause a non-zero exit (YAML is authoritative).
 *
 * Usage:
 *   pnpm crux wiki-server sync-session <file>
 *   pnpm crux wiki-server sync-session .claude/sessions/2026-02-21_my-branch.yaml
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { createSession, type SessionApiEntry } from '../lib/wiki-server-client.ts';

const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

interface YamlSession {
  date: string | Date;
  branch?: string;
  title: string;
  summary?: string;
  model?: string;
  duration?: string;
  cost?: string;
  pr?: number | string;
  pages?: string[];
  issues?: unknown[];
  learnings?: unknown[];
  recommendations?: unknown[];
  checks?: Record<string, unknown>;
}

function normalizeDate(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d);
}

function normalizePrUrl(pr: unknown): string | null {
  if (pr == null) return null;
  if (typeof pr === 'number') {
    return `https://github.com/quantified-uncertainty/longterm-wiki/pull/${pr}`;
  }
  const s = String(pr);
  if (s.startsWith('http')) return s;
  const numMatch = s.match(/^#?(\d+)$/) || s.match(/\/pull\/(\d+)/);
  if (numMatch) {
    return `https://github.com/quantified-uncertainty/longterm-wiki/pull/${numMatch[1]}`;
  }
  return null;
}

function serializeChecks(checks: unknown): string | null {
  if (!checks || typeof checks !== 'object') return null;
  try {
    return JSON.stringify(checks);
  } catch {
    return null;
  }
}

/**
 * Parse a session YAML file and convert to the API entry format.
 */
export function parseSessionYaml(filePath: string): SessionApiEntry | null {
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as YamlSession;

  if (!parsed || typeof parsed !== 'object' || !parsed.date || !parsed.title) {
    return null;
  }

  const pages = Array.isArray(parsed.pages)
    ? parsed.pages.filter((id) => typeof id === 'string' && PAGE_ID_RE.test(id))
    : [];

  return {
    date: normalizeDate(parsed.date),
    branch: parsed.branch ? String(parsed.branch) : null,
    title: String(parsed.title),
    summary: parsed.summary ? String(parsed.summary).trim() : null,
    model: parsed.model ? String(parsed.model) : null,
    duration: parsed.duration ? String(parsed.duration) : null,
    cost: parsed.cost ? String(parsed.cost) : null,
    prUrl: normalizePrUrl(parsed.pr),
    checksYaml: serializeChecks(parsed.checks),
    issuesJson: parsed.issues && Array.isArray(parsed.issues)
      ? parsed.issues
      : undefined,
    learningsJson: parsed.learnings && Array.isArray(parsed.learnings)
      ? parsed.learnings
      : undefined,
    recommendationsJson: parsed.recommendations && Array.isArray(parsed.recommendations)
      ? parsed.recommendations
      : undefined,
    pages,
  };
}

/**
 * Sync a single session YAML file to the wiki-server.
 * Returns true if the POST succeeded, false otherwise.
 */
export async function syncSessionFile(filePath: string): Promise<boolean> {
  const entry = parseSessionYaml(filePath);
  if (!entry) return false;

  const result = await createSession(entry);
  return result !== null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const positional = (args._positional as string[]) || [];
  const filePath = positional[0];

  if (!filePath) {
    console.error('Error: provide a session YAML file path');
    console.error('  Usage: pnpm crux wiki-server sync-session <file>');
    process.exit(1);
  }

  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    console.error(`Error: file not found: ${resolved}`);
    process.exit(1);
  }

  const entry = parseSessionYaml(resolved);
  if (!entry) {
    console.error(`Error: could not parse session YAML: ${resolved}`);
    process.exit(1);
  }

  console.log(`Syncing session: ${entry.title}`);
  console.log(`  Date: ${entry.date}`);
  console.log(`  Branch: ${entry.branch || '(none)'}`);
  console.log(`  Pages: ${entry.pages?.length || 0}`);

  const result = await createSession(entry);
  if (result) {
    console.log(`\u2713 Session synced to wiki-server (id: ${result.id})`);
  } else {
    console.log('Warning: could not sync session to wiki-server (server unavailable or error)');
    // Not a hard failure — YAML is authoritative
  }
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
