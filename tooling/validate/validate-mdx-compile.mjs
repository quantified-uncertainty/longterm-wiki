#!/usr/bin/env node
/**
 * MDX Compilation Validator
 *
 * Actually compiles MDX files to catch JSX syntax errors BEFORE the full Astro build.
 * This catches errors that regex-based validators miss:
 * - Unescaped < in tables/prose (JSX parsing errors)
 * - Invalid JSX syntax
 * - Malformed component usage
 *
 * Usage:
 *   node scripts/validate/validate-mdx-compile.mjs           # Check all MDX files
 *   node scripts/validate/validate-mdx-compile.mjs --quick   # Check only changed files (git)
 *   node scripts/validate/validate-mdx-compile.mjs --file path/to/file.mdx  # Check specific file
 *   node scripts/validate/validate-mdx-compile.mjs --ci      # CI mode (exit 1 on error)
 */

import { readFileSync, statSync } from 'fs';
import { relative } from 'path';
import { execSync } from 'child_process';
import { compile } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import remarkMath from 'remark-math';

// Use shared libraries
import { findMdxFiles } from '../lib/file-utils.mjs';
import { createLogger, formatPath, createProgress } from '../lib/output.mjs';
import { CONTENT_DIR } from '../lib/content-types.js';

const args = process.argv.slice(2);
const QUICK_MODE = args.includes('--quick');
const fileArg = args.find(a => a.startsWith('--file='));
const SPECIFIC_FILE = fileArg ? fileArg.replace('--file=', '') : null;

const log = createLogger();
const c = log.colors;

/**
 * Get changed MDX files from git (for quick mode)
 */
function getChangedMdxFiles() {
  try {
    // Get files changed vs main branch OR staged/unstaged changes
    const diffOutput = execSync(
      'git diff --name-only HEAD -- "*.mdx" && git diff --cached --name-only -- "*.mdx"',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!diffOutput) return [];

    // Git returns paths relative to repo root — content lives at content/docs/
    return diffOutput
      .split('\n')
      .filter(f => f && f.endsWith('.mdx'))
      .map(f => f.trim())
      .filter(f => f.startsWith('content/'))  // Only content MDX files
      .filter(f => {
        try {
          statSync(f);
          return true;
        } catch {
          return false;  // File doesn't exist (was deleted)
        }
      });
  } catch {
    // If git fails, return empty (will fall back to all files)
    return [];
  }
}

/**
 * Extract a helpful snippet around an error position
 */
function getErrorSnippet(content, line, column) {
  const lines = content.split('\n');
  const lineIndex = line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }

  return {
    context: lines.slice(Math.max(0, lineIndex - 1), lineIndex + 2).join('\n'),
  };
}

/**
 * Parse error message to extract position info
 */
function parseErrorPosition(error) {
  const posMatch = error.message?.match(/(?:at |position |\()?(\d+):(\d+)/i);
  if (posMatch) {
    return { line: parseInt(posMatch[1], 10), column: parseInt(posMatch[2], 10) };
  }
  if (error.line && error.column) {
    return { line: error.line, column: error.column };
  }
  return null;
}

/**
 * Provide helpful fix suggestions based on error type
 */
function getSuggestion(error, content, pos) {
  const msg = error.message?.toLowerCase() || '';

  if (msg.includes('unexpected character') && pos) {
    const lines = content.split('\n');
    const line = lines[pos.line - 1] || '';
    const afterError = line.slice(pos.column - 1);

    if (/<\d/.test(afterError.slice(0, 5))) {
      return {
        issue: 'Unescaped < before number (parsed as JSX tag)',
        fix: 'Replace < with &lt; or use words like "under", "less than"',
        example: '<100ms → Under 100ms  OR  &lt;100ms',
      };
    }

    if (/<\$/.test(afterError.slice(0, 5))) {
      return {
        issue: 'Unescaped < before dollar sign',
        fix: 'Replace < with &lt; or rephrase',
        example: '<$100 → Under $100  OR  &lt;$100',
      };
    }
  }

  if (msg.includes('unclosed') || msg.includes('expected closing')) {
    return {
      issue: 'Unclosed JSX element',
      fix: 'Ensure all JSX tags are properly closed',
      example: '<Mermaid chart={...} />  (note the self-closing />)',
    };
  }

  return null;
}

/**
 * Compile a single MDX file and catch errors
 */
async function validateFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');

  try {
    await compile(content, {
      development: false,
      remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkMath],
      recmaPlugins: [],
    });
    return { success: true };
  } catch (error) {
    const pos = parseErrorPosition(error);
    const snippet = pos ? getErrorSnippet(content, pos.line, pos.column) : null;
    const suggestion = getSuggestion(error, content, pos);

    return {
      success: false,
      error: { message: error.message, position: pos, snippet, suggestion },
    };
  }
}

/**
 * Main execution
 */
async function main() {
  log.heading('MDX Compilation Validator');
  console.log();

  // Determine which files to check
  let files;

  if (SPECIFIC_FILE) {
    files = [SPECIFIC_FILE];
    log.dim(`Checking specific file: ${SPECIFIC_FILE}`);
  } else if (QUICK_MODE) {
    files = getChangedMdxFiles();
    if (files.length === 0) {
      log.success('No changed MDX files to check');
      return;
    }
    log.dim(`Quick mode: checking ${files.length} changed files`);
  } else {
    files = findMdxFiles(CONTENT_DIR);
    log.dim(`Checking ${files.length} MDX files...`);
  }
  console.log();

  const errors = [];
  const progress = createProgress(files.length, 'Compiling');

  for (const file of files) {
    progress.update();
    const result = await validateFile(file);

    if (!result.success) {
      errors.push({ file: formatPath(file), ...result.error });
    }
  }
  progress.done();

  // Report results
  if (errors.length === 0) {
    console.log(`${c.green}${c.bold}✓ All ${files.length} MDX files compile successfully${c.reset}\n`);
    process.exit(0);
  }

  console.log(`${c.red}${c.bold}✗ Found ${errors.length} MDX compilation error(s)${c.reset}\n`);

  for (const err of errors) {
    console.log(`${c.red}${c.bold}${err.file}${c.reset}`);
    if (err.position) {
      log.dim(`  Line ${err.position.line}, Column ${err.position.column}`);
    }
    console.log(`  ${c.yellow}${err.message}${c.reset}`);

    if (err.snippet) {
      log.dim('\n  Context:');
      console.log(`  ${c.dim}${err.snippet.context.split('\n').map(l => '  ' + l).join('\n')}${c.reset}`);
    }

    if (err.suggestion) {
      console.log(`\n  ${c.blue}Issue:${c.reset} ${err.suggestion.issue}`);
      console.log(`  ${c.green}Fix:${c.reset} ${err.suggestion.fix}`);
      log.dim(`  Example: ${err.suggestion.example}`);
    }
    console.log();
  }

  console.log(`${c.red}${c.bold}Summary: ${errors.length} file(s) have compilation errors${c.reset}`);
  log.dim('These errors will cause the Next.js build to fail.');
  log.dim('Fix the issues above before committing.\n');

  process.exit(1);
}

main().catch(err => {
  console.error('Validator error:', err);
  process.exit(1);
});
