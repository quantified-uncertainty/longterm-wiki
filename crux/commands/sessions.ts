/**
 * Sessions Command Handlers
 *
 * Create and manage agent session log YAML files.
 *
 * Usage:
 *   crux sessions write "Session title"               Write a session log YAML
 *   crux sessions write --title="Session title"       Alternative flag form
 *   crux sessions write "Title" --sync                Write + sync to wiki-server
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../lib/output.ts';
import { currentBranch } from '../lib/session-checklist.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { syncSessionFile } from '../wiki-server/sync-session.ts';
import type { CommandResult } from '../lib/cli.ts';

const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** Convert a branch name into a filename-safe slug. */
function branchToSlug(branch: string): string {
  return branch
    .replace(/^claude\//, '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Parse a comma- or space-separated list from CLI args. */
function parseList(val: unknown): string[] {
  if (!val) return [];
  const s = String(val);
  return s
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Build the YAML string for a session log file.
 * Uses raw string building to include comment placeholders for optional fields.
 */
function buildSessionYaml(fields: {
  date: string;
  branch: string;
  title: string;
  summary?: string;
  model?: string;
  duration?: string;
  cost?: string;
  pr?: string;
  pages: string[];
}): string {
  const lines: string[] = [
    `date: "${fields.date}"`,
    `branch: ${fields.branch}`,
    `title: ${JSON.stringify(fields.title)}`,
    `summary: |`,
    `  ${fields.summary ?? '(fill in)'}`,
  ];

  if (fields.model) lines.push(`model: ${fields.model}`);
  if (fields.duration) lines.push(`duration: "${fields.duration}"`);
  if (fields.cost) lines.push(`cost: "${fields.cost}"`);
  if (fields.pr) lines.push(`pr: "${fields.pr}"`);

  if (fields.pages.length === 0) {
    lines.push('pages: []');
  } else {
    lines.push('pages:');
    for (const p of fields.pages) {
      lines.push(`  - ${p}`);
    }
  }

  lines.push(
    '# issues, learnings, recommendations: add as YAML lists, e.g.:',
    '# issues:',
    '#   - "Description of an issue encountered"',
    '# learnings:',
    '#   - "Something learned"',
    '# recommendations:',
    '#   - "Suggested follow-up action"',
    '# checks: (paste output of: pnpm crux agent-checklist snapshot)',
  );

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// write command
// ---------------------------------------------------------------------------

/**
 * Scaffold and write a session log YAML to .claude/sessions/.
 *
 * Required: --title="..." or first positional arg.
 * Optional: --summary, --model, --duration, --cost, --pr, --pages (comma-separated IDs).
 * Optional: --sync — also sync to wiki-server after writing.
 * Optional: --output=<path> — write to a custom path instead of .claude/sessions/.
 */
async function write(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean | undefined);
  const c = log.colors;

  // Resolve title: first non-flag positional arg or --title=
  const positional = args.filter((a) => !a.startsWith('--'));
  const title = positional[0] ?? (options.title as string | undefined);

  if (!title) {
    return {
      output:
        `${c.red}Error: title is required.${c.reset}\n` +
        `  Usage: pnpm crux sessions write "Session title" [options]\n` +
        `  Or:    pnpm crux sessions write --title="Session title" [options]\n`,
      exitCode: 1,
    };
  }

  const date = today();
  const branch = currentBranch();
  const slug = branchToSlug(branch);
  const filename = `${date}_${slug}.yaml`;

  const outputPath = options.output
    ? String(options.output)
    : join(SESSIONS_DIR, filename);

  // Ensure parent directory exists (handles both default and custom --output paths)
  mkdirSync(dirname(outputPath), { recursive: true });

  // Parse optional list fields
  const pages = parseList(options.pages);

  const yamlContent = buildSessionYaml({
    date,
    branch,
    title,
    summary: options.summary ? String(options.summary) : undefined,
    model: options.model ? String(options.model) : undefined,
    duration: options.duration ? String(options.duration) : undefined,
    cost: options.cost ? String(options.cost) : undefined,
    pr: options.pr ? String(options.pr) : undefined,
    pages,
  });

  const alreadyExists = existsSync(outputPath);
  writeFileSync(outputPath, yamlContent, 'utf-8');

  let out = alreadyExists
    ? `${c.yellow}⚠${c.reset}  Session YAML overwritten: ${c.cyan}${outputPath}${c.reset}\n`
    : `${c.green}✓${c.reset} Session YAML written: ${c.cyan}${outputPath}${c.reset}\n`;
  out += `  Date: ${date}\n`;
  out += `  Branch: ${branch}\n`;
  out += `  Title: ${title}\n`;
  if (pages.length > 0) out += `  Pages: ${pages.join(', ')}\n`;
  out += `\n  Edit the file to add summary, issues, learnings, recommendations and checks, then:\n`;
  out += `  ${c.cyan}pnpm crux wiki-server sync-session ${outputPath}${c.reset}\n`;

  // Optionally sync immediately
  if (options.sync) {
    log.info('Syncing to wiki-server...');
    const synced = await syncSessionFile(outputPath);
    if (synced) {
      out += `${c.green}✓ Synced to wiki-server.${c.reset}\n`;
    } else {
      out += `${c.yellow}Warning: could not sync to wiki-server (server unavailable or error).${c.reset}\n`;
    }
  }

  return { output: out, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Domain entry point (required by crux.mjs dispatch)
// ---------------------------------------------------------------------------

export const commands = {
  write,
};

export function getHelp(): string {
  return `
Sessions Domain — Create and manage agent session log YAML files

Commands:
  write <title> [options]   Scaffold a session YAML in .claude/sessions/

Options:
  --title=<text>            Session title (alternative to positional arg)
  --summary=<text>          Short summary of what was done
  --model=<name>            Model used (e.g. claude-sonnet-4-6)
  --duration=<text>         Approximate duration (e.g. "~30min")
  --cost=<text>             Approximate cost (e.g. "~$1.50")
  --pr=<url|number>         PR URL or number
  --pages=<id1,id2,...>     Comma-separated wiki page IDs edited
  --sync                    Also sync to wiki-server after writing
  --output=<path>           Custom output path (default: .claude/sessions/<date>_<branch>.yaml)

Examples:
  pnpm crux sessions write "Fix citation parser bug"
  pnpm crux sessions write "Add dark mode" --model=claude-sonnet-4-6 --duration="~45min"
  pnpm crux sessions write "Update AI timelines page" --pages=ai-timelines,ai-forecasting --sync
`.trim();
}
