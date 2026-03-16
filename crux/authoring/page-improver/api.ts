/**
 * LLM/API layer for the page-improver pipeline.
 *
 * Two execution paths:
 *   1. CLI mode (default): spawns `claude -p --print` subprocess, billed via
 *      Claude Code subscription. Web search handled by Claude's native tool.
 *   2. API-direct mode: calls Anthropic SDK directly, billed via ANTHROPIC_API_KEY.
 *      Used when --api-direct is set, or inside a Claude Code SDK session.
 *
 * The CLI path was added to avoid $5-8/page API costs during batch loops.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  createLlmClient, runLlmAgent, streamingCreate, extractText,
  startHeartbeat, withRetry, type ToolHandler, isOpenRouterMode, streamLlmCall,
} from '../../lib/llm.ts';
import { MODELS } from '../../lib/anthropic.ts';
import { shouldUseApiDirect } from '../../lib/claude-cli.ts';
import type { RunAgentOptions } from './types.ts';
import { ROOT, SCRY_PUBLIC_KEY, log } from './utils.ts';

// ── Anthropic client (lazy singleton) ────────────────────────────────────────

let _client: ReturnType<typeof createLlmClient> | null = null;
function getClient() {
  if (!_client) _client = createLlmClient();
  return _client;
}

// ── Re-export for pipeline.ts ────────────────────────────────────────────────

export { startHeartbeat };

// Track which mode we're using (set by pipeline.ts)
let _useApiDirect: boolean | null = null;

/** Set whether to use API-direct mode. Called once at pipeline start. */
export function setApiDirectMode(explicit?: boolean): void {
  _useApiDirect = shouldUseApiDirect(explicit);
  log('api', _useApiDirect
    ? 'Using API-direct mode (Anthropic SDK — billed via ANTHROPIC_API_KEY)'
    : 'Using CLI mode (claude subprocess — billed via Claude Code subscription)');
}

function isApiDirect(): boolean {
  if (_useApiDirect === null) {
    _useApiDirect = shouldUseApiDirect();
  }
  return _useApiDirect;
}

// ── Tool implementations ─────────────────────────────────────────────────────

export async function executeWebSearch(query: string): Promise<string> {
  // In OpenRouter mode, web_search_20250305 tool isn't available.
  // Fall back to a plain LLM call that asks for known information.
  if (isOpenRouterMode()) {
    return streamLlmCall(getClient(), `Research this topic and provide the most relevant facts, developments, and sources you know about: "${query}". Include specific dates, numbers, and URLs where possible.`, {
      model: MODELS.sonnet,
      maxTokens: 4000,
      retryLabel: 'web_search_fallback',
    });
  }

  const response = await withRetry(
    () => streamingCreate(getClient(), {
      model: MODELS.sonnet,
      max_tokens: 4000,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any],
      messages: [{
        role: 'user',
        content: `Search for: "${query}". Return the top 5 most relevant results with titles, URLs, and brief descriptions.`
      }]
    }),
    { label: 'web_search' }
  );

  return extractText(response);
}

const VALID_SCRY_TABLES = new Set(['mv_eaforum_posts', 'mv_lesswrong_posts']);

export async function executeScrySearch(query: string, table: string = 'mv_eaforum_posts'): Promise<string> {
  if (!VALID_SCRY_TABLES.has(table)) {
    return `SCRY search error: invalid table "${table}" — must be one of: ${[...VALID_SCRY_TABLES].join(', ')}`;
  }
  const sql = `SELECT title, uri, snippet, original_author, original_timestamp::date as date
    FROM scry.search('${query.replace(/'/g, "''")}', '${table}')
    WHERE title IS NOT NULL AND kind = 'post'
    LIMIT 10`;

  try {
    const response = await fetch('https://api.exopriors.com/v1/scry/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SCRY_PUBLIC_KEY}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
      signal: AbortSignal.timeout(30000),
    });
    return await response.text();
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return `SCRY search error: ${error.message}`;
  }
}

// ── Tool handler registry ────────────────────────────────────────────────────

/** Build tool handlers for the page-improver agent. */
function buildToolHandlers(): Record<string, ToolHandler> {
  return {
    web_search: async (input) => executeWebSearch(String(input.query)),
    scry_search: async (input) => executeScrySearch(String(input.query), input.table ? String(input.table) : undefined),
    read_file: async (input) => {
      const resolvedPath = path.resolve(String(input.path));
      if (!resolvedPath.startsWith(ROOT)) {
        return 'Access denied: path must be within project root';
      }
      return fs.readFileSync(resolvedPath, 'utf-8');
    },
  };
}

// ── CLI-based agent execution ────────────────────────────────────────────────

const CLI_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Run a prompt through the Claude CLI subprocess.
 * Bills via Claude Code subscription, not ANTHROPIC_API_KEY.
 *
 * Uses --allowedTools WebSearch for phases that need web access.
 */
async function runAgentViaCli(
  prompt: string,
  options: RunAgentOptions = {},
): Promise<string> {
  const {
    model = MODELS.sonnet,
    tools = [],
  } = options;

  // Map SDK model IDs to CLI model names
  const cliModel = model.includes('haiku') ? 'haiku'
    : model.includes('opus') ? 'opus'
    : 'sonnet';

  // Determine which tools to allow. If the phase declared web_search/scry_search
  // tools, enable WebSearch in the CLI.
  const hasWebTools = tools.some(t =>
    'name' in t && (t.name === 'web_search' || t.name === 'scry_search'),
  );
  const allowedTools = hasWebTools
    ? 'WebSearch,WebFetch'
    : '';

  // Budget per phase call (generous but bounded)
  const budgetUsd = cliModel === 'haiku' ? '0.50' : '3.00';

  return new Promise((resolve, reject) => {
    // Unset CLAUDECODE to allow spawning Claude inside a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const args = [
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--model', cliModel,
      '--max-budget-usd', budgetUsd,
    ];
    if (allowedTools) {
      args.push('--allowedTools', allowedTools);
    }

    const claude = spawn('claude', args, {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error(`CLI agent timed out after ${CLI_TIMEOUT_MS / 1000}s`));
    }, CLI_TIMEOUT_MS);

    claude.stdin.write(prompt);
    claude.stdin.end();

    let stdout = '';
    claude.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    let stderr = '';
    claude.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    claude.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn claude subprocess: ${err.message}`));
    });

    claude.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else if (code === 0) {
        // Empty output — likely a budget or tool issue
        reject(new Error(`Claude CLI returned empty output${stderr ? `\nstderr: ${stderr.slice(-1000)}` : ''}`));
      } else {
        reject(new Error(`Claude CLI exited with code ${code}${stderr ? `\nstderr: ${stderr.slice(-1000)}` : ''}`));
      }
    });
  });
}

// ── Agent execution ──────────────────────────────────────────────────────────

/**
 * Run Claude with the appropriate backend.
 * - CLI mode (default): spawns `claude` subprocess, billed via subscription.
 * - API-direct mode: uses Anthropic SDK, billed via ANTHROPIC_API_KEY.
 */
export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  if (!isApiDirect()) {
    return runAgentViaCli(prompt, options);
  }

  // API-direct path (original behavior)
  const {
    model = MODELS.sonnet,
    maxTokens = 16000,
    tools = [],
    systemPrompt = ''
  } = options;

  return runLlmAgent(getClient(), prompt, {
    model,
    maxTokens,
    systemPrompt,
    tools,
    toolHandlers: buildToolHandlers(),
    retryLabel: 'runAgent',
    heartbeatPhase: 'api',
    onRetry: (msg) => log('retry', msg),
  });
}
