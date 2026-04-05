/**
 * Usage Patterns — Analyze Claude Code conversation logs
 *
 * Parses ~/.claude/projects/ JSONL files to extract user message patterns,
 * tool usage, session durations, and common interaction styles.
 *
 * Supports scanning multiple project directories (for lw/a1–a15 agent slots).
 *
 * Usage:
 *   crux sys usage-patterns                    Analyze recent sessions (7 days)
 *   crux sys usage-patterns --since=2026-03-01 Custom date range
 *   crux sys usage-patterns --all              All sessions, no date filter
 *   crux sys usage-patterns --dir=/home/you    Override home directory
 *   crux sys usage-patterns --json             JSON output
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createLogger } from '../lib/output.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

interface CommandOptions extends BaseOptions {
  since?: string;
  all?: boolean;
  dir?: string;
  json?: boolean;
  ci?: boolean;
}

// ---------------------------------------------------------------------------
// JSONL parsing types
// ---------------------------------------------------------------------------

interface JournalEntry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  entrypoint?: string;
  gitBranch?: string;
  cwd?: string;
  version?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string; // tool_use name
  input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

interface SessionSummary {
  sessionId: string;
  projectDir: string;
  firstMessage: string;
  lastTimestamp: string;
  userMessageCount: number;
  assistantMessageCount: number;
  toolUses: Record<string, number>;
  entrypoint: string;
  gitBranch: string;
  userMessages: string[];
  durationMinutes: number;
}

interface PatternReport {
  sessionsAnalyzed: number;
  dateRange: { from: string; to: string };
  totalUserMessages: number;
  totalAssistantMessages: number;
  avgMessagesPerSession: number;
  avgSessionDurationMinutes: number;
  entrypointDistribution: Record<string, number>;
  branchDistribution: Record<string, number>;
  toolUsageRanked: Array<{ tool: string; count: number }>;
  topMessagePatterns: Array<{ pattern: string; count: number; examples: string[] }>;
  sessionsByDay: Record<string, number>;
  sessionsByHour: Record<string, number>;
  longestSessions: Array<{ sessionId: string; minutes: number; branch: string; firstMessage: string }>;
  shortSessions: number;
  slashCommandUsage: Record<string, number>;
  questionVsDirective: { questions: number; directives: number };
}

// ---------------------------------------------------------------------------
// JSONL file discovery
// ---------------------------------------------------------------------------

function findJournalFiles(baseDir: string): Array<{ path: string; projectDir: string }> {
  const claudeDir = join(baseDir, '.claude', 'projects');
  if (!existsSync(claudeDir)) return [];

  const files: Array<{ path: string; projectDir: string }> = [];

  try {
    for (const entry of readdirSync(claudeDir)) {
      const entryPath = join(claudeDir, entry);
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) {
        if (entry.endsWith('.jsonl')) {
          files.push({ path: entryPath, projectDir: 'unknown' });
        }
        continue;
      }

      for (const file of readdirSync(entryPath)) {
        if (file.endsWith('.jsonl')) {
          files.push({ path: join(entryPath, file), projectDir: entry });
        }
      }
    }
  } catch {
    // Permission errors etc.
  }

  return files;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

function parseJournalFile(filePath: string, projectDir: string, since: Date | null): SessionSummary | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let sessionId = basename(filePath, '.jsonl');
  let firstTimestamp = '';
  let lastTimestamp = '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  const toolUses: Record<string, number> = {};
  let entrypoint = '';
  let gitBranch = '';
  const userMessages: string[] = [];

  for (const line of lines) {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.sessionId) sessionId = entry.sessionId;
    if (entry.timestamp) {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }

    if (entry.type === 'user' && entry.message?.role === 'user') {
      userMessageCount++;
      if (entry.entrypoint) entrypoint = entry.entrypoint;
      if (entry.gitBranch) gitBranch = entry.gitBranch;

      const text = extractText(entry.message.content);
      if (text.length > 0) {
        userMessages.push(text);
      }
    }

    if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
      assistantMessageCount++;

      const msgContent = entry.message.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type === 'tool_use' && block.name) {
            toolUses[block.name] = (toolUses[block.name] || 0) + 1;
          }
        }
      }
    }
  }

  // Apply date filter: skip if the session ended before the cutoff
  if (since && lastTimestamp) {
    const sessionEnd = new Date(lastTimestamp);
    if (sessionEnd < since) return null;
  }

  // Skip empty sessions
  if (userMessageCount === 0) return null;

  const durationMinutes = firstTimestamp && lastTimestamp
    ? Math.round((new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()) / 60000)
    : 0;

  return {
    sessionId,
    projectDir,
    firstMessage: firstTimestamp,
    lastTimestamp,
    userMessageCount,
    assistantMessageCount,
    toolUses,
    entrypoint,
    gitBranch,
    userMessages,
    durationMinutes,
  };
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join(' ')
      .trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Pattern analysis
// ---------------------------------------------------------------------------

function analyzePatterns(sessions: SessionSummary[]): PatternReport {
  const totalUserMessages = sessions.reduce((s, x) => s + x.userMessageCount, 0);
  const totalAssistantMessages = sessions.reduce((s, x) => s + x.assistantMessageCount, 0);

  // Entrypoint distribution
  const entrypointDist: Record<string, number> = {};
  for (const s of sessions) {
    const ep = s.entrypoint || 'unknown';
    entrypointDist[ep] = (entrypointDist[ep] || 0) + 1;
  }

  // Branch distribution (top 15)
  const branchDist: Record<string, number> = {};
  for (const s of sessions) {
    const branch = s.gitBranch || 'unknown';
    branchDist[branch] = (branchDist[branch] || 0) + 1;
  }

  // Tool usage aggregation
  const toolTotals: Record<string, number> = {};
  for (const s of sessions) {
    for (const [tool, count] of Object.entries(s.toolUses)) {
      toolTotals[tool] = (toolTotals[tool] || 0) + count;
    }
  }
  const toolUsageRanked = Object.entries(toolTotals)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  // Sessions by day of week
  const sessionsByDay: Record<string, number> = {};
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const s of sessions) {
    if (s.firstMessage) {
      const day = days[new Date(s.firstMessage).getDay()];
      sessionsByDay[day] = (sessionsByDay[day] || 0) + 1;
    }
  }

  // Sessions by hour
  const sessionsByHour: Record<string, number> = {};
  for (const s of sessions) {
    if (s.firstMessage) {
      const hour = new Date(s.firstMessage).getHours().toString().padStart(2, '0');
      sessionsByHour[`${hour}:00`] = (sessionsByHour[`${hour}:00`] || 0) + 1;
    }
  }

  // Date range
  const timestamps = sessions
    .map((s) => s.firstMessage)
    .filter(Boolean)
    .sort();
  const dateRange = {
    from: timestamps[0]?.slice(0, 10) || 'unknown',
    to: timestamps[timestamps.length - 1]?.slice(0, 10) || 'unknown',
  };

  // Longest sessions
  const longestSessions = sessions
    .filter((s) => s.durationMinutes > 0)
    .sort((a, b) => b.durationMinutes - a.durationMinutes)
    .slice(0, 5)
    .map((s) => ({
      sessionId: s.sessionId.slice(0, 8),
      minutes: s.durationMinutes,
      branch: s.gitBranch,
      firstMessage: s.userMessages[0]?.slice(0, 80) || '(empty)',
    }));

  // Short sessions (< 2 messages)
  const shortSessions = sessions.filter((s) => s.userMessageCount <= 2).length;

  // Slash command usage
  const slashCommands: Record<string, number> = {};
  for (const s of sessions) {
    for (const msg of s.userMessages) {
      const match = msg.match(/^\/([\w-]+)/);
      if (match) {
        slashCommands[`/${match[1]}`] = (slashCommands[`/${match[1]}`] || 0) + 1;
      }
    }
  }

  // Classify all user messages
  const allUserMessages = sessions.flatMap((s) => s.userMessages).filter((m) => m.length > 0);

  // Questions vs directives
  let questions = 0;
  let directives = 0;
  for (const msg of allUserMessages) {
    if (msg.match(/\?(\s|$)/) || msg.match(/^(how|what|why|where|when|can|does|is|are|should|would|could)\b/i)) {
      questions++;
    } else {
      directives++;
    }
  }

  // Top message patterns (categorized)
  const patternBuckets: Record<string, { count: number; examples: string[] }> = {};
  for (const msg of allUserMessages) {
    const category = categorizeMessage(msg);
    if (!patternBuckets[category]) {
      patternBuckets[category] = { count: 0, examples: [] };
    }
    patternBuckets[category].count++;
    if (patternBuckets[category].examples.length < 3) {
      patternBuckets[category].examples.push(msg.slice(0, 120));
    }
  }

  const topMessagePatterns = Object.entries(patternBuckets)
    .map(([pattern, data]) => ({ pattern, count: data.count, examples: data.examples }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const durations = sessions.map((s) => s.durationMinutes).filter((d) => d > 0);
  const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  return {
    sessionsAnalyzed: sessions.length,
    dateRange,
    totalUserMessages,
    totalAssistantMessages,
    avgMessagesPerSession: sessions.length > 0 ? Math.round(totalUserMessages / sessions.length) : 0,
    avgSessionDurationMinutes: avgDuration,
    entrypointDistribution: entrypointDist,
    branchDistribution: sortedTop(branchDist, 15),
    toolUsageRanked,
    topMessagePatterns,
    sessionsByDay,
    sessionsByHour,
    longestSessions,
    shortSessions,
    slashCommandUsage: slashCommands,
    questionVsDirective: { questions, directives },
  };
}

function categorizeMessage(msg: string): string {
  const lower = msg.toLowerCase().trim();

  if (lower.match(/^\//)) return 'slash-command';
  if (lower.match(/^(fix|debug|resolve|diagnose)\b/)) return 'bug-fix-request';
  if (lower.match(/^(add|create|implement|build|write|make)\b/)) return 'feature-request';
  if (lower.match(/^(update|change|modify|edit|rename|move|refactor)\b/)) return 'modification-request';
  if (lower.match(/^(delete|remove|clean|drop)\b/)) return 'removal-request';
  if (lower.match(/^(test|check|verify|validate|run)\b/)) return 'verification-request';
  if (lower.match(/^(show|list|find|search|look|where|what)\b/)) return 'information-query';
  if (lower.match(/^(how|why|explain|help|can you|does|is there)\b/)) return 'question';
  if (lower.match(/^(commit|push|ship|deploy|merge|pr)\b/)) return 'git-workflow';
  if (lower.match(/^(review|improve|polish|simplify)\b/)) return 'review-request';
  if (lower.match(/^(y|yes|no|ok|sure|go ahead|lgtm|do it|sounds good)\b/)) return 'confirmation';
  if (msg.length < 20) return 'short-response';
  return 'other';
}

function sortedTop(record: Record<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatReport(report: PatternReport, c: ReturnType<typeof createLogger>['colors']): string {
  let out = '';

  out += `${c.bold}${c.blue}═══ Claude Code Usage Patterns ═══${c.reset}\n`;
  out += `${c.dim}Date range: ${report.dateRange.from} → ${report.dateRange.to}${c.reset}\n\n`;

  // Summary stats
  out += `${c.bold}Summary${c.reset}\n`;
  out += `  Sessions analyzed:    ${report.sessionsAnalyzed}\n`;
  out += `  User messages:        ${report.totalUserMessages}\n`;
  out += `  Assistant messages:   ${report.totalAssistantMessages}\n`;
  out += `  Avg messages/session: ${report.avgMessagesPerSession}\n`;
  out += `  Avg session duration: ${report.avgSessionDurationMinutes}min\n`;
  out += `  Short sessions (≤2 msgs): ${report.shortSessions}\n`;
  out += `  Questions vs directives: ${report.questionVsDirective.questions}q / ${report.questionVsDirective.directives}d\n\n`;

  // Entrypoints
  out += `${c.bold}Entrypoints${c.reset}\n`;
  for (const [ep, count] of Object.entries(report.entrypointDistribution)) {
    out += `  ${ep}: ${count}\n`;
  }
  out += '\n';

  // Activity by hour
  out += `${c.bold}Activity by Hour${c.reset}\n`;
  const hours = Object.entries(report.sessionsByHour).sort((a, b) => a[0].localeCompare(b[0]));
  const maxHourCount = Math.max(...hours.map(([, v]) => v), 1);
  for (const [hour, count] of hours) {
    const bar = '█'.repeat(Math.ceil((count / maxHourCount) * 20));
    out += `  ${hour} ${c.dim}${bar}${c.reset} ${count}\n`;
  }
  out += '\n';

  // Activity by day
  out += `${c.bold}Activity by Day${c.reset}\n`;
  const maxDayCount = Math.max(...Object.values(report.sessionsByDay), 1);
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    const count = report.sessionsByDay[day] || 0;
    const bar = '█'.repeat(Math.ceil((count / maxDayCount) * 20));
    out += `  ${day.padEnd(10)} ${c.dim}${bar}${c.reset} ${count}\n`;
  }
  out += '\n';

  // Tool usage
  out += `${c.bold}Top Tools Used${c.reset}\n`;
  for (const { tool, count } of report.toolUsageRanked.slice(0, 15)) {
    out += `  ${tool.padEnd(25)} ${count}\n`;
  }
  out += '\n';

  // Message patterns
  out += `${c.bold}Message Patterns${c.reset}\n`;
  for (const { pattern, count, examples } of report.topMessagePatterns) {
    out += `  ${c.yellow}${pattern}${c.reset}: ${count}\n`;
    for (const ex of examples.slice(0, 2)) {
      out += `    ${c.dim}"${ex}"${c.reset}\n`;
    }
  }
  out += '\n';

  // Slash commands
  if (Object.keys(report.slashCommandUsage).length > 0) {
    out += `${c.bold}Slash Commands${c.reset}\n`;
    const sorted = Object.entries(report.slashCommandUsage).sort((a, b) => b[1] - a[1]);
    for (const [cmd, count] of sorted) {
      out += `  ${cmd.padEnd(25)} ${count}\n`;
    }
    out += '\n';
  }

  // Branch activity
  out += `${c.bold}Top Branches${c.reset}\n`;
  for (const [branch, count] of Object.entries(report.branchDistribution)) {
    out += `  ${branch.slice(0, 50).padEnd(52)} ${count}\n`;
  }
  out += '\n';

  // Longest sessions
  if (report.longestSessions.length > 0) {
    out += `${c.bold}Longest Sessions${c.reset}\n`;
    for (const s of report.longestSessions) {
      out += `  ${s.minutes}min [${s.branch}] "${s.firstMessage}"\n`;
    }
    out += '\n';
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

async function analyze(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const homeDir = (options.dir as string) || homedir();
  const since = options.all
    ? null
    : options.since
      ? new Date(options.since as string)
      : (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })();

  const journalFiles = findJournalFiles(homeDir);

  if (journalFiles.length === 0) {
    return {
      output: `${c.yellow}No Claude Code journal files found in ${homeDir}/.claude/projects/${c.reset}\n` +
        `This command reads ~/.claude/projects/*/*.jsonl files.\n` +
        `Use --dir= to specify the home directory if your slots are elsewhere.\n`,
      exitCode: 1,
    };
  }

  const sessions: SessionSummary[] = [];
  for (const { path, projectDir } of journalFiles) {
    const summary = parseJournalFile(path, projectDir, since);
    if (summary) {
      sessions.push(summary);
    }
  }

  if (sessions.length === 0) {
    const sinceStr = since ? since.toISOString().slice(0, 10) : 'all time';
    return {
      output: `${c.yellow}No sessions with messages found since ${sinceStr}${c.reset}\n` +
        `Found ${journalFiles.length} journal files but none had qualifying messages.\n`,
      exitCode: 0,
    };
  }

  const report = analyzePatterns(sessions);

  if (options.json) {
    return { output: JSON.stringify(report, null, 2) + '\n', exitCode: 0 };
  }

  return { output: formatReport(report, c), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: analyze,
};

export function getHelp(): string {
  return `
Usage Patterns — Analyze Claude Code conversation logs

Parses ~/.claude/projects/ JSONL files to surface patterns in how you
use Claude Code: message styles, tool usage, session timing, slash
commands, and more.

Commands:
  (default)    Analyze sessions

Options:
  --since=DATE   Only include sessions after DATE (default: 7 days ago)
  --all          No date filter — analyze all sessions
  --dir=PATH     Override home directory (for scanning lw/a* slots)
  --json         JSON output
  --ci           CI-compatible output

Note on agent slots:
  Each lw/a* slot has its own ~/.claude/projects/ directory.
  To scan a specific slot:  --dir=/path/to/lw/a3
  To scan all slots, run once per slot or write a wrapper.

Examples:
  crux sys usage-patterns                     # Last 7 days
  crux sys usage-patterns --since=2026-03-01  # Since March 1st
  crux sys usage-patterns --all               # Everything
  crux sys usage-patterns --all --json        # JSON export
`;
}
