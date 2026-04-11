/**
 * Transcript Parser — parse Claude Code JSONL session transcripts.
 *
 * Extracts structured session metadata: title, summary, model info,
 * and timestamps from the JSONL transcript file.
 *
 * JSONL format: one JSON object per line, with types:
 *   - "user": user messages
 *   - "assistant": assistant responses with model/usage
 *   - "system": system events
 *   - "queue-operation": task queue events
 *   - "progress": progress indicators
 *   - "last-prompt": session end marker
 */

import * as fs from 'fs';
import * as path from 'path';
import { scrubSecrets } from './secret-scrubber.ts';

/** Parsed transcript result. */
export interface TranscriptResult {
  /** Session ID from the JSONL filename (UUID). */
  sessionId: string;
  /** First user message text, truncated to 200 chars (used as title fallback). */
  title: string | null;
  /** Summary from the final assistant message (last text block). */
  summary: string | null;
  /** Primary model used (most frequent). */
  model: string | null;
  /** ISO timestamp of first event. */
  startedAt: string | null;
  /** ISO timestamp of last event. */
  endedAt: string | null;
  /** Duration in minutes. */
  durationMinutes: number | null;
  /** Git branch detected from system messages. */
  branch: string | null;
  /** Total line count in the transcript. */
  lineCount: number;
}

/**
 * Extract text content from a message's content field.
 * Claude Code messages have content as either a string or an array of content blocks.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      }
    }
  }
  return textParts.join('\n');
}

/**
 * Check if a user message is a real user input (not a system/command injection).
 */
function isRealUserMessage(text: string): boolean {
  if (!text.trim()) return false;
  if (text.includes('<local-command-caveat>')) return false;
  if (text.trim().startsWith('<command-name>')) return false;
  if (text.trim().startsWith('<command-message>')) return false;
  // Skip slash-command triggers (e.g. "/maintain-pr-patrol")
  if (/^\/[a-z]/.test(text.trim())) return false;
  if (text.trim().length < 5) return false;
  return true;
}

/**
 * Parse a JSONL transcript file into structured session metadata.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @returns Parsed transcript result
 */
export function parseTranscript(filePath: string): TranscriptResult {
  const sessionId = path.basename(filePath, '.jsonl');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());

  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantText: string | null = null;
  let branch: string | null = null;
  const modelCounts: Record<string, number> = {};

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = parsed.timestamp as string | undefined;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    const type = parsed.type as string;

    if (type === 'user' && firstUserMessage === null) {
      const msg = parsed.message as Record<string, unknown> | undefined;
      if (msg) {
        const text = extractTextContent(msg.content);
        if (isRealUserMessage(text)) {
          firstUserMessage = text.slice(0, 200).trim();
        }
      }
    }

    if (type === 'assistant') {
      const msg = parsed.message as Record<string, unknown> | undefined;
      if (msg) {
        const text = extractTextContent(msg.content);
        if (text.trim()) {
          lastAssistantText = text;
        }
        const model = msg.model as string | undefined;
        if (model && model !== '<synthetic>') {
          modelCounts[model] = (modelCounts[model] ?? 0) + 1;
        }
      }
    }

    if (type === 'system' && !branch) {
      const gitBranch = parsed.gitBranch as string | undefined;
      if (gitBranch) branch = gitBranch;
    }
  }

  // Determine primary model (most frequent)
  let primaryModel: string | null = null;
  let maxModelCount = 0;
  for (const [model, cnt] of Object.entries(modelCounts)) {
    if (cnt > maxModelCount) {
      maxModelCount = cnt;
      primaryModel = model;
    }
  }

  // Compute duration
  let durationMinutes: number | null = null;
  if (firstTimestamp && lastTimestamp) {
    const startMs = new Date(firstTimestamp).getTime();
    const endMs = new Date(lastTimestamp).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs > startMs) {
      durationMinutes = Math.round((endMs - startMs) / 60000);
    }
  }

  // Build summary from last assistant message (truncated)
  let summary: string | null = null;
  if (lastAssistantText) {
    const scrubbed = scrubSecrets(lastAssistantText);
    // Take the last meaningful portion (up to 2000 chars)
    summary = scrubbed.slice(-2000).trim();
    if (summary.length === 0) summary = null;
  }

  // Title: scrub first user message
  let title: string | null = null;
  if (firstUserMessage) {
    title = scrubSecrets(firstUserMessage);
  }

  return {
    sessionId,
    title,
    summary,
    model: primaryModel,
    startedAt: firstTimestamp,
    endedAt: lastTimestamp,
    durationMinutes,
    branch,
    lineCount: lines.length,
  };
}

/**
 * Find the most recent JSONL transcript file for a given project directory.
 *
 * Claude Code stores transcripts at:
 *   ~/.claude/projects/<slug>/<sessionId>.jsonl
 *
 * where <slug> is the project directory path with / replaced by -.
 *
 * @param projectDir - Absolute path to the project directory
 * @returns Path to the most recent .jsonl file, or null if none found
 */
export function findLatestTranscript(projectDir: string): string | null {
  // Claude Code derives the slug from the absolute project path
  const slug = projectDir.replace(/\//g, '-');
  const claudeDir = path.join(
    process.env.HOME ?? '~',
    '.claude',
    'projects',
    slug,
  );

  if (!fs.existsSync(claudeDir)) return null;

  const entries = fs.readdirSync(claudeDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      name: f,
      path: path.join(claudeDir, f),
      mtime: fs.statSync(path.join(claudeDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return entries.length > 0 ? entries[0].path : null;
}
