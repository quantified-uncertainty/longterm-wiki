/**
 * Gate Triage — LLM-assisted check skipping for the pre-push gate
 *
 * Reads the git diff, categorizes changed files, and optionally asks Haiku
 * which gate checks can be safely skipped. Conservative by design:
 * - Deterministic `canSkipBuildData()` for the most impactful skip
 * - LLM triage only suggests skipping clearly irrelevant checks
 * - 3-second hard timeout; any error → run everything
 * - Disabled in CI (always runs full gate)
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { createClient, callClaude, MODELS, parseJsonResponse } from '../lib/anthropic.ts';

// ── File categories ──────────────────────────────────────────────────────────

export interface FileCategories {
  mdxContent: string[];
  yamlData: string[];
  appTs: string[];
  buildScripts: string[];
  cruxTs: string[];
  wikiServerTs: string[];
  config: string[];
  other: string[];
}

const CONFIG_PATTERNS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  /^tsconfig/,
  '.eslintrc',
  'next.config',
  'vitest.config',
  'tailwind.config',
  'postcss.config',
];

function isConfigFile(file: string): boolean {
  const basename = file.split('/').pop() || '';
  return CONFIG_PATTERNS.some(p =>
    typeof p === 'string' ? basename.startsWith(p) : p.test(basename)
  );
}

/**
 * Categorize changed files into buckets for triage decisions.
 * Pure function — no I/O, no LLM.
 */
export function categorizeFiles(files: string[]): FileCategories {
  const cats: FileCategories = {
    mdxContent: [],
    yamlData: [],
    appTs: [],
    buildScripts: [],
    cruxTs: [],
    wikiServerTs: [],
    config: [],
    other: [],
  };

  for (const f of files) {
    if (isConfigFile(f)) {
      cats.config.push(f);
    } else if (f.startsWith('content/docs/') && f.endsWith('.mdx')) {
      cats.mdxContent.push(f);
    } else if (f.startsWith('data/') && f.endsWith('.yaml')) {
      cats.yamlData.push(f);
    } else if (f.startsWith('apps/web/scripts/')) {
      cats.buildScripts.push(f);
    } else if (f.startsWith('apps/web/src/') && /\.tsx?$/.test(f)) {
      cats.appTs.push(f);
    } else if (f.startsWith('crux/') && /\.tsx?$/.test(f)) {
      cats.cruxTs.push(f);
    } else if (f.startsWith('apps/wiki-server/') && /\.tsx?$/.test(f)) {
      cats.wikiServerTs.push(f);
    } else {
      cats.other.push(f);
    }
  }

  return cats;
}

// ── Deterministic build-data skip ────────────────────────────────────────────

/**
 * Can we skip the build-data step?
 *
 * Returns true only when:
 * - No MDX, YAML, app TS, build script, or config files changed
 * - database.json already exists on disk
 *
 * This means only pure crux/, wiki-server/, or other changes skip build-data.
 */
export function canSkipBuildData(categories: FileCategories): boolean {
  const hasDataRelevantChanges =
    categories.mdxContent.length > 0 ||
    categories.yamlData.length > 0 ||
    categories.appTs.length > 0 ||
    categories.buildScripts.length > 0 ||
    categories.config.length > 0;

  if (hasDataRelevantChanges) return false;

  const dbPath = join(PROJECT_ROOT, 'apps/web/src/data/database.json');
  return existsSync(dbPath);
}

// ── LLM triage ───────────────────────────────────────────────────────────────

export interface TriageResult {
  /** Map of step ID → reason for skipping */
  skip: Record<string, string>;
  /** Whether the LLM was actually called (false if fallback) */
  llmCalled: boolean;
  /** Duration of the triage call in ms */
  durationMs: number;
}

/** Step descriptions for the Haiku prompt */
const STEP_DESCRIPTIONS: Record<string, string> = {
  'test': 'Run vitest tests (apps/web/ test files). Relevant when app TS, crux TS, or test files change.',
  'unified-blocking': 'MDX syntax, frontmatter schema, numeric IDs, EntityLink, pipeline artifacts. Relevant when MDX content or YAML data changes.',
  'yaml-schema': 'YAML entity schema validation. Relevant when YAML data files change.',
  'typecheck': 'TypeScript type check for apps/web/. Relevant when app TS files, config, or package.json change.',
  'typecheck-crux': 'TypeScript type check for crux/. Relevant when crux TS files change.',
  'returning-guard': 'Drizzle .returning() guard for wiki-server. Relevant when wiki-server TS files change.',
  'mdx-compile': 'MDX compilation smoke-test. Relevant when MDX content or app components change.',
  'typecheck-crux-baseline': 'Crux TypeScript baseline check. Relevant when crux TS files change.',
};

const SYSTEM_PROMPT = `You are a CI triage assistant. Given a summary of changed files in a git push, decide which gate checks can be safely SKIPPED.

Available checks and when they're relevant:
${Object.entries(STEP_DESCRIPTIONS).map(([id, desc]) => `- "${id}": ${desc}`).join('\n')}

Rules:
- Be CONSERVATIVE. Only skip a check when the changed files clearly cannot affect it.
- When in doubt, do NOT skip.
- If config files changed (package.json, tsconfig, etc.), do NOT skip any checks.
- If "other" files changed, do NOT skip any checks.

Respond with a JSON object: { "skip": { "<step-id>": "<one-line reason>" } }
Only include steps you want to skip. Empty "skip" object means run everything.`;

const TRIAGE_TIMEOUT_MS = 3000;
const MAX_SKIPPABLE = 5; // Safety cap: never skip more than this many checks

/**
 * Ask Haiku which gate checks can be skipped based on changed files.
 *
 * Graceful fallback: returns empty skip set on any error, timeout, or missing API key.
 */
export async function triageGateChecks(
  changedFiles: string[],
  allStepIds: string[],
  categories?: FileCategories,
): Promise<TriageResult> {
  const start = Date.now();

  const cats = categories ?? categorizeFiles(changedFiles);

  // Build a compact summary (keeps token count low, ~200 tokens)
  const summary = Object.entries(cats)
    .filter(([, files]) => files.length > 0)
    .map(([cat, files]) => `${cat}: ${files.length} file${files.length > 1 ? 's' : ''}`)
    .join('\n');

  if (!summary) {
    // No files changed — skip nothing (shouldn't happen, but be safe)
    return { skip: {}, llmCalled: false, durationMs: Date.now() - start };
  }

  // If config or other files changed, skip nothing (deterministic fast path)
  if (cats.config.length > 0 || cats.other.length > 0) {
    return { skip: {}, llmCalled: false, durationMs: Date.now() - start };
  }

  // Try to call Haiku with a hard timeout
  try {
    const client = createClient({ required: false });
    if (!client) {
      return { skip: {}, llmCalled: false, durationMs: Date.now() - start };
    }

    const userPrompt = `Changed files summary:\n${summary}\n\nTotal files: ${changedFiles.length}`;

    const llmPromise = callClaude(client, {
      model: MODELS.haiku,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 500,
      temperature: 0,
    });

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), TRIAGE_TIMEOUT_MS)
    );

    const result = await Promise.race([llmPromise, timeoutPromise]);

    if (!result) {
      // Timeout
      return { skip: {}, llmCalled: true, durationMs: Date.now() - start };
    }

    // Parse and validate the response
    const parsed = parseJsonResponse(result.text) as { skip?: Record<string, string> };

    if (!parsed || typeof parsed.skip !== 'object') {
      return { skip: {}, llmCalled: true, durationMs: Date.now() - start };
    }

    // Filter: only keep known step IDs, cap at MAX_SKIPPABLE
    const validSkips: Record<string, string> = {};
    const stepIdSet = new Set(allStepIds);
    let count = 0;

    for (const [id, reason] of Object.entries(parsed.skip)) {
      if (count >= MAX_SKIPPABLE) break;
      if (stepIdSet.has(id) && typeof reason === 'string') {
        validSkips[id] = reason;
        count++;
      }
    }

    return { skip: validSkips, llmCalled: true, durationMs: Date.now() - start };
  } catch {
    // Any error → fallback to running everything
    return { skip: {}, llmCalled: false, durationMs: Date.now() - start };
  }
}
