#!/usr/bin/env node

/**
 * Validate that large diffs have an agent checklist.
 *
 * If `git diff main...HEAD` shows >200 lines or >3 files changed and
 * `.claude/wip-checklist.md` does not exist, the gate fails.
 *
 * This catches "quick fix sessions" that are actually large changes
 * shipped without any checklist or self-review.
 *
 * Usage: npx tsx crux/validate/validate-checklist-required.ts
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import { getDiffStats } from './diff-utils.ts';

const FILES_THRESHOLD = 3;
const LINES_THRESHOLD = 200;
const CHECKLIST_PATH = join(PROJECT_ROOT, '.claude', 'wip-checklist.md');

export interface ChecklistRequiredResult {
  passed: boolean;
  warnings: number;
  filesChanged: number;
  linesChanged: number;
  thresholdExceeded: boolean;
  checklistExists: boolean;
  reason?: string;
}

export function runCheck(): ChecklistRequiredResult {
  const c = getColors();
  console.log(`${c.blue}Checking checklist requirement for large diffs...${c.reset}\n`);

  const { files, lines } = getDiffStats();
  const thresholdExceeded = files > FILES_THRESHOLD || lines > LINES_THRESHOLD;
  const checklistExists = existsSync(CHECKLIST_PATH);

  console.log(`${c.dim}  Diff size: ${files} files changed, ${lines} lines changed${c.reset}`);
  console.log(`${c.dim}  Thresholds: >${FILES_THRESHOLD} files or >${LINES_THRESHOLD} lines${c.reset}`);
  console.log(`${c.dim}  Checklist: ${checklistExists ? 'exists' : 'not found'}${c.reset}`);

  if (!thresholdExceeded) {
    console.log(`\n${c.green}Diff within thresholds — checklist not required${c.reset}`);
    return {
      passed: true,
      warnings: 0,
      filesChanged: files,
      linesChanged: lines,
      thresholdExceeded: false,
      checklistExists,
    };
  }

  if (checklistExists) {
    console.log(`\n${c.green}Large diff has agent checklist — OK${c.reset}`);
    return {
      passed: true,
      warnings: 0,
      filesChanged: files,
      linesChanged: lines,
      thresholdExceeded: true,
      checklistExists: true,
    };
  }

  const reason = `Large diff (${files} files, ${lines} lines) without agent checklist. Run \`pnpm crux agent-checklist init "Task" --type=X\` or use --force to override.`;
  console.log(`\n${c.red}FAIL: ${reason}${c.reset}`);
  console.log(`${c.dim}  Fix: run /agent-session-start before making large changes${c.reset}`);

  return {
    passed: false,
    warnings: 0,
    filesChanged: files,
    linesChanged: lines,
    thresholdExceeded: true,
    checklistExists: false,
    reason,
  };
}

if (process.argv[1]?.includes('validate-checklist-required')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
