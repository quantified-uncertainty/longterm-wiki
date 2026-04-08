/**
 * Codebase Analysis Module
 *
 * Searches the codebase for patterns and reads relevant files to provide
 * context for internal-reference page creation. Used when --type=internal-reference
 * is passed to the page creator pipeline.
 */

import fs from 'fs';
import { execFileSync } from 'child_process';
import type { ResearchPhaseContext } from './types.ts';

type CodebaseAnalysisContext = ResearchPhaseContext;

interface CodebaseAnalysisResult {
  [key: string]: unknown;
  success: boolean;
  grepMatches: number;
  filesRead: number;
  contextLength: number;
}

interface GrepMatchSummary {
  pattern: string;
  files: GrepFileMatch[];
}

const MAX_CONTEXT_CHARS = 20_000;
const MAX_LINES_PER_FILE = 100;

interface GrepFileMatch {
  file: string;
  /** First matching line number (1-based), or null if unknown */
  firstLine: number | null;
}

/**
 * Run ripgrep against the codebase for a single pattern.
 * Returns matching files with the first hit line number for context-aware reading.
 * Uses execFileSync with an args array to avoid command injection.
 */
function runGrep(pattern: string, searchDir: string, root: string): GrepFileMatch[] {
  try {
    // --line-number gives us "file:line:match" format so we know where to read
    const result = execFileSync(
      'rg',
      [pattern, searchDir, '--line-number', '--no-heading'],
      { cwd: root, encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    // Parse rg output: each line is "file:lineNum:matchText"
    const fileFirstLine = new Map<string, number>();
    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      // Format: "path/to/file:123:matched text..."
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const secondColon = line.indexOf(':', colonIdx + 1);
      if (secondColon === -1) continue;
      const file = line.slice(0, colonIdx);
      const lineNum = parseInt(line.slice(colonIdx + 1, secondColon), 10);
      if (!fileFirstLine.has(file)) {
        fileFirstLine.set(file, lineNum);
      }
    }
    return [...fileFirstLine.entries()].map(([file, firstLine]) => ({ file, firstLine }));
  } catch {
    // rg exits with code 1 when no matches found — not an error
    return [];
  }
}

/**
 * Resolve glob patterns to file paths.
 * Returns absolute paths of matching files.
 * Uses execFileSync with an args array to avoid command injection.
 */
function resolveGlobs(patterns: string[], root: string): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    try {
      const result = execFileSync(
        'find',
        [root, '-path', root + '/' + pattern, '-type', 'f'],
        { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const matches = result.trim().split('\n').filter(Boolean);
      files.push(...matches);
    } catch {
      // Pattern didn't match anything
    }
  }
  return [...new Set(files)];
}

/**
 * Read up to maxLines lines from a file, centered around `centerLine` if provided.
 * When centerLine is given, reads a window around the grep hit so the relevant
 * context is included rather than always reading from the top.
 */
function readFileRegion(filePath: string, maxLines: number, centerLine?: number | null): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    if (lines.length <= maxLines) {
      // File fits entirely — return it all
      return content;
    }

    let startLine: number;
    if (centerLine && centerLine > 1) {
      // Center the window around the grep hit
      const halfWindow = Math.floor(maxLines / 2);
      startLine = Math.max(0, centerLine - 1 - halfWindow);
      // Ensure we don't go past the end
      if (startLine + maxLines > lines.length) {
        startLine = Math.max(0, lines.length - maxLines);
      }
    } else {
      startLine = 0;
    }

    const endLine = Math.min(startLine + maxLines, lines.length);
    const slice = lines.slice(startLine, endLine).join('\n');

    const prefixNote = startLine > 0 ? `... (skipped lines 1-${startLine})\n` : '';
    const suffixNote = endLine < lines.length ? `\n... (${lines.length - endLine} more lines)` : '';
    return prefixNote + slice + suffixNote;
  } catch {
    return null;
  }
}

/**
 * Truncate a section to `maxLen` characters while ensuring code fences stay balanced.
 * If truncation would cut off a closing ``` fence, the fence is appended so downstream
 * markdown parsers don't see a dangling open block.
 */
function truncateWithBalancedFences(section: string, maxLen: number): string {
  const truncated = section.slice(0, maxLen);
  // Count triple-backtick fences in the truncated portion
  const fenceCount = (truncated.match(/^```/gm) || []).length;
  // Odd count means an unclosed fence — append a closing one
  if (fenceCount % 2 !== 0) {
    return truncated + '\n```\n... (truncated)';
  }
  return truncated + '\n... (truncated)';
}

/**
 * Run codebase analysis: grep for patterns, read matched/specified files,
 * and produce a combined context string for synthesis.
 */
export async function runCodebaseAnalysis(
  topic: string,
  grepPatterns: string[],
  fileGlobs: string[],
  root: string,
  { log, saveResult }: CodebaseAnalysisContext,
): Promise<CodebaseAnalysisResult> {
  log('codebase-analysis', `Analyzing codebase for "${topic}"...`);
  log('codebase-analysis', `  Grep patterns: ${grepPatterns.length > 0 ? grepPatterns.join(', ') : '(none)'}`);
  log('codebase-analysis', `  File globs: ${fileGlobs.length > 0 ? fileGlobs.join(', ') : '(none)'}`);

  // Collect files from grep matches — track first hit line per file for context-aware reading
  const grepResults: GrepMatchSummary[] = [];
  // Map from relative file path → first grep hit line number (or null for glob-only files)
  const allMatchedFiles = new Map<string, number | null>();

  for (const pattern of grepPatterns) {
    // Search in crux/ by default (the primary codebase for internal references)
    const matches = runGrep(pattern, 'crux/', root);
    grepResults.push({ pattern, files: matches });
    for (const m of matches) {
      // Keep the earliest hit line across patterns
      const existing = allMatchedFiles.get(m.file);
      if (existing === undefined) {
        allMatchedFiles.set(m.file, m.firstLine);
      }
    }
    log('codebase-analysis', `  grep "${pattern}": ${matches.length} file(s)`);
  }

  // Collect files from glob patterns (no line number — read from top)
  const globFiles = resolveGlobs(fileGlobs, root);
  for (const f of globFiles) {
    // Convert absolute path to relative for consistency
    const relative = f.startsWith(root + '/') ? f.slice(root.length + 1) : f;
    if (!allMatchedFiles.has(relative)) {
      allMatchedFiles.set(relative, null);
    }
  }
  if (globFiles.length > 0) {
    log('codebase-analysis', `  File globs resolved: ${globFiles.length} file(s)`);
  }

  // Read files and build context
  const sections: string[] = [];
  let totalChars = 0;
  let filesRead = 0;

  // Sort files for deterministic output
  const sortedFiles = [...allMatchedFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [relPath, hitLine] of sortedFiles) {
    if (totalChars >= MAX_CONTEXT_CHARS) {
      log('codebase-analysis', `  Reached ${MAX_CONTEXT_CHARS.toLocaleString()} char limit, stopping file reads`);
      break;
    }

    const absPath = relPath.startsWith('/') ? relPath : `${root}/${relPath}`;
    const content = readFileRegion(absPath, MAX_LINES_PER_FILE, hitLine);
    if (!content) continue;

    const section = `### ${relPath}\n\`\`\`\n${content}\n\`\`\``;
    const sectionLength = section.length;

    // If adding this section would exceed the cap, truncate it — but keep fences balanced
    if (totalChars + sectionLength > MAX_CONTEXT_CHARS) {
      const remaining = MAX_CONTEXT_CHARS - totalChars;
      if (remaining > 200) {
        sections.push(truncateWithBalancedFences(section, remaining));
        totalChars += remaining;
        filesRead++;
      }
      break;
    }

    sections.push(section);
    totalChars += sectionLength;
    filesRead++;
  }

  const contextString = sections.length > 0
    ? sections.join('\n\n')
    : '(No matching files found in codebase)';

  log('codebase-analysis', `  Total: ${filesRead} files, ${totalChars.toLocaleString()} chars of context`);

  // Save results for synthesis to pick up
  saveResult(topic, 'codebase-analysis.json', {
    topic,
    grepPatterns,
    fileGlobs,
    grepResults: grepResults.map(r => ({ pattern: r.pattern, fileCount: r.files.length, files: r.files.slice(0, 20).map(f => f.file) })),
    filesRead,
    totalChars: totalChars,
    context: contextString,
    timestamp: new Date().toISOString(),
  });

  log('codebase-analysis', 'Saved codebase-analysis.json');

  return {
    success: true,
    grepMatches: allMatchedFiles.size,
    filesRead,
    contextLength: totalChars,
  };
}
