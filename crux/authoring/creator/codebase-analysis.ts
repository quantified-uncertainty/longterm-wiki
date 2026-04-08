/**
 * Codebase Analysis Module
 *
 * Searches the codebase for patterns and reads relevant files to provide
 * context for internal-reference page creation. Used when --type=internal-reference
 * is passed to the page creator pipeline.
 */

import fs from 'fs';
import { execSync } from 'child_process';
import type { ResearchPhaseContext } from './types.ts';

type CodebaseAnalysisContext = ResearchPhaseContext;

interface CodebaseAnalysisResult {
  [key: string]: unknown;
  success: boolean;
  grepMatches: number;
  filesRead: number;
  contextLength: number;
}

interface GrepMatch {
  pattern: string;
  files: string[];
}

const MAX_CONTEXT_CHARS = 20_000;
const MAX_LINES_PER_FILE = 100;

/**
 * Run ripgrep against the codebase for a single pattern.
 * Returns the list of matching file paths (relative to ROOT).
 */
function runGrep(pattern: string, searchDir: string, root: string): string[] {
  try {
    const result = execSync(
      `rg ${JSON.stringify(pattern)} ${JSON.stringify(searchDir)} --files-with-matches -l 2>/dev/null`,
      { cwd: root, encoding: 'utf-8', timeout: 15_000 }
    );
    return result
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    // rg exits with code 1 when no matches found — not an error
    return [];
  }
}

/**
 * Resolve glob patterns to file paths using the shell.
 * Returns absolute paths of matching files.
 */
function resolveGlobs(patterns: string[], root: string): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    try {
      // Use find for glob resolution — more portable than shell globs
      const result = execSync(
        `find ${JSON.stringify(root)} -path ${JSON.stringify(root + '/' + pattern)} -type f 2>/dev/null`,
        { encoding: 'utf-8', timeout: 10_000 }
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
 * Read the first N lines of a file and return them with the file path as a header.
 */
function readFileHead(filePath: string, maxLines: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const truncated = lines.length > maxLines;
    const head = lines.slice(0, maxLines).join('\n');
    const suffix = truncated ? `\n... (${lines.length - maxLines} more lines)` : '';
    return head + suffix;
  } catch {
    return null;
  }
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

  // Collect files from grep matches
  const grepResults: GrepMatch[] = [];
  const allMatchedFiles = new Set<string>();

  for (const pattern of grepPatterns) {
    // Search in crux/ by default (the primary codebase for internal references)
    const files = runGrep(pattern, 'crux/', root);
    grepResults.push({ pattern, files });
    for (const f of files) {
      allMatchedFiles.add(f);
    }
    log('codebase-analysis', `  grep "${pattern}": ${files.length} file(s)`);
  }

  // Collect files from glob patterns
  const globFiles = resolveGlobs(fileGlobs, root);
  for (const f of globFiles) {
    // Convert absolute path to relative for consistency
    const relative = f.startsWith(root + '/') ? f.slice(root.length + 1) : f;
    allMatchedFiles.add(relative);
  }
  if (globFiles.length > 0) {
    log('codebase-analysis', `  File globs resolved: ${globFiles.length} file(s)`);
  }

  // Read files and build context
  const sections: string[] = [];
  let totalChars = 0;
  let filesRead = 0;

  // Sort files for deterministic output
  const sortedFiles = [...allMatchedFiles].sort();

  for (const relPath of sortedFiles) {
    if (totalChars >= MAX_CONTEXT_CHARS) {
      log('codebase-analysis', `  Reached ${MAX_CONTEXT_CHARS.toLocaleString()} char limit, stopping file reads`);
      break;
    }

    const absPath = relPath.startsWith('/') ? relPath : `${root}/${relPath}`;
    const content = readFileHead(absPath, MAX_LINES_PER_FILE);
    if (!content) continue;

    const section = `### ${relPath}\n\`\`\`\n${content}\n\`\`\``;
    const sectionLength = section.length;

    // If adding this section would exceed the cap, truncate it
    if (totalChars + sectionLength > MAX_CONTEXT_CHARS) {
      const remaining = MAX_CONTEXT_CHARS - totalChars;
      if (remaining > 200) {
        sections.push(section.slice(0, remaining) + '\n... (truncated)');
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
    grepResults: grepResults.map(r => ({ pattern: r.pattern, fileCount: r.files.length, files: r.files.slice(0, 20) })),
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
