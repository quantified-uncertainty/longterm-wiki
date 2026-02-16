/**
 * API-Direct Mode for Page Creator
 *
 * Provides alternatives to the three Claude CLI subprocess calls
 * (synthesis, validation loop, review) using the Anthropic API directly.
 *
 * This enables the page creation pipeline to work in environments where
 * the `claude` CLI cannot be spawned (e.g., web sandbox sessions).
 *
 * Issue: https://github.com/quantified-uncertainty/longterm-wiki/issues/161
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, MODELS, parseJsonResponse } from '../../lib/anthropic.ts';
import { getSynthesisPrompt } from './synthesis.ts';
import { CRITICAL_RULES, QUALITY_RULES } from '../../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Retry an async fn with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 2, label = 'API call' }: { maxRetries?: number; label?: string } = {}
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const isRetryable =
        error.message.includes('timeout') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('socket hang up') ||
        error.message.includes('overloaded') ||
        error.message.includes('529') ||
        error.message.includes('rate_limit');
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt + 1) * 1000;
      console.log(`[retry] ${label} failed (${error.message.slice(0, 80)}), retrying in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

/** Start a heartbeat timer that logs every `intervalSec` seconds. Returns a stop function. */
function startHeartbeat(phase: string, intervalSec = 30): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    process.stderr.write(`[${timestamp}] [${phase}] … still running (${elapsed}s)\n`);
  }, intervalSec * 1000);
  return () => clearInterval(timer);
}

/** Stream a Claude API call and return the final message. */
async function streamingCreate(
  client: Anthropic,
  params: Parameters<typeof client.messages.create>[0]
): Promise<Anthropic.Messages.Message> {
  const stream = client.messages.stream(params as any);
  return await stream.finalMessage();
}

/** Extract text from a Claude response. */
function extractText(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// API-Direct Synthesis
// ---------------------------------------------------------------------------

interface SynthesisContext {
  log: (phase: string, message: string) => void;
  ROOT: string;
  getTopicDir: (topic: string) => string;
}

/**
 * Generate a wiki article using the Anthropic API directly (no subprocess).
 * Replaces runSynthesis() from synthesis.ts when in API-direct mode.
 */
export async function runSynthesisApiDirect(
  topic: string,
  quality: string,
  { log, ROOT, getTopicDir }: SynthesisContext,
  destPath?: string | null
): Promise<{ success: boolean; model: string; budget: number }> {
  log('synthesis', `Generating article via API-direct (${quality})...`);

  const client = createClient(); // Throws if ANTHROPIC_API_KEY missing

  const model = quality === 'quality' ? MODELS.opus : MODELS.sonnet;
  const budget = quality === 'quality' ? 3.0 : 2.0;

  // Build the same prompt that the subprocess version uses
  const prompt = getSynthesisPrompt(topic, quality, {
    loadResult: (t: string, f: string) => {
      const filePath = path.join(ROOT, '.claude/temp/page-creator', t.toLowerCase().replace(/[^a-z0-9]+/g, '-'), f);
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      return f.endsWith('.json') ? JSON.parse(content) : content;
    }
  }, destPath, ROOT);

  const stopHeartbeat = startHeartbeat('synthesis', 30);
  try {
    const response = await withRetry(
      () => streamingCreate(client, {
        model,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }],
      }),
      { label: 'synthesis' }
    );

    const text = extractText(response);

    // Extract the MDX content from the response
    let mdxContent = text;

    // If the model wrapped it in a code block, extract it
    const codeBlockMatch = text.match(/```(?:mdx)?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      mdxContent = codeBlockMatch[1];
    } else if (!text.startsWith('---')) {
      // Try to find the frontmatter start
      const fmStart = text.indexOf('---\n');
      if (fmStart !== -1) {
        mdxContent = text.slice(fmStart);
      }
    }

    // Write the draft to the expected location
    const draftDir = getTopicDir(topic);
    if (!fs.existsSync(draftDir)) {
      fs.mkdirSync(draftDir, { recursive: true });
    }
    const draftPath = path.join(draftDir, 'draft.mdx');
    fs.writeFileSync(draftPath, mdxContent);

    log('synthesis', `Draft written to ${draftPath} (${mdxContent.length} chars)`);

    return { success: true, model, budget };
  } finally {
    stopHeartbeat();
  }
}

// ---------------------------------------------------------------------------
// API-Direct Validation Loop
// ---------------------------------------------------------------------------

interface ValidationLoopContext {
  log: (phase: string, message: string) => void;
  ROOT: string;
  getTopicDir: (topic: string) => string;
}

/**
 * Iteratively validate and fix a wiki article using the Anthropic API directly.
 * Replaces runValidationLoop() from validation.ts when in API-direct mode.
 *
 * Strategy:
 * 1. Read the draft
 * 2. Run programmatic validation
 * 3. If issues found, send content + issues to Claude API for fixes
 * 4. Write fixed content
 * 5. Repeat up to MAX_ITERATIONS
 */
export async function runValidationLoopApiDirect(
  topic: string,
  { log, ROOT, getTopicDir }: ValidationLoopContext
): Promise<{ success: boolean; error?: string; hasOutput?: boolean; exitCode?: number | null }> {
  log('validate', 'Starting API-direct validation loop...');

  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
  if (!fs.existsSync(draftPath)) {
    log('validate', 'No draft found, skipping validation');
    return { success: false, error: 'No draft found' };
  }

  const client = createClient(); // Throws if ANTHROPIC_API_KEY missing

  const MAX_ITERATIONS = 3;
  let content = fs.readFileSync(draftPath, 'utf-8');
  let lastIssues: string[] = [];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    log('validate', `Iteration ${iteration}/${MAX_ITERATIONS}...`);

    // Write content to draft for validation tools to check
    fs.writeFileSync(draftPath, content);

    // Run auto-fixes
    try {
      execSync('node --import tsx/esm --no-warnings crux/crux.mjs fix escaping 2>&1', {
        cwd: ROOT, stdio: 'pipe', timeout: 60000
      });
      execSync('node --import tsx/esm --no-warnings crux/crux.mjs fix markdown 2>&1', {
        cwd: ROOT, stdio: 'pipe', timeout: 60000
      });
      content = fs.readFileSync(draftPath, 'utf-8');
    } catch {
      log('validate', '  Auto-fix commands failed (non-fatal)');
    }

    // Run programmatic validation and collect issues
    const issues = collectValidationIssues(draftPath, topic, ROOT, log);

    if (issues.length === 0) {
      log('validate', `  All checks pass after iteration ${iteration}`);
      break;
    }

    // If same issues as last iteration, we're stuck
    const issuesSummary = issues.join('\n');
    if (issuesSummary === lastIssues.join('\n') && iteration > 1) {
      log('validate', '  Same issues as previous iteration — stopping');
      break;
    }
    lastIssues = issues;

    log('validate', `  Found ${issues.length} issue(s), asking Claude to fix...`);

    // Ask Claude to fix the issues
    const fixPrompt = buildFixPrompt(content, issues, ROOT);

    const stopHeartbeat = startHeartbeat('validate-fix', 30);
    try {
      const response = await withRetry(
        () => streamingCreate(client, {
          model: MODELS.sonnet,
          max_tokens: 16000,
          messages: [{ role: 'user', content: fixPrompt }],
        }),
        { label: 'validation-fix' }
      );

      const fixedText = extractText(response);

      // Extract the fixed MDX content
      let fixedContent = fixedText;
      const codeBlockMatch = fixedText.match(/```(?:mdx)?\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        fixedContent = codeBlockMatch[1];
      } else if (!fixedText.startsWith('---')) {
        const fmStart = fixedText.indexOf('---\n');
        if (fmStart !== -1) {
          fixedContent = fixedText.slice(fmStart);
        }
      }

      // Only update if the response looks like valid MDX
      if (fixedContent.startsWith('---')) {
        content = fixedContent;
        fs.writeFileSync(draftPath, content);
      } else {
        log('validate', '  Warning: Claude response did not contain valid MDX, keeping previous version');
      }
    } finally {
      stopHeartbeat();
    }
  }

  // Write final output
  const finalPath = path.join(getTopicDir(topic), 'final.mdx');
  fs.writeFileSync(finalPath, content);
  log('validate', `Final article written to ${finalPath}`);

  return { success: true, hasOutput: true, exitCode: 0 };
}

/**
 * Collect validation issues by running programmatic checks.
 */
function collectValidationIssues(
  filePath: string,
  topic: string,
  ROOT: string,
  log: (phase: string, msg: string) => void
): string[] {
  const issues: string[] = [];
  const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const NODE_TSX = 'node --import tsx/esm --no-warnings';

  // Check critical rules
  for (const rule of CRITICAL_RULES) {
    try {
      const result = execSync(
        `${NODE_TSX} crux/crux.mjs validate unified --rules=${rule} --ci 2>&1 | grep -i "${topicSlug}" || true`,
        { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }
      );
      const errorCount = (result.match(/error/gi) || []).length;
      if (errorCount > 0) {
        issues.push(`[CRITICAL] ${rule}: ${errorCount} error(s)\n${result.trim()}`);
        log('validate', `  ✗ ${rule}: ${errorCount} error(s)`);
      } else {
        log('validate', `  ✓ ${rule}`);
      }
    } catch {
      log('validate', `  ? ${rule}: check failed`);
    }
  }

  // Check quality rules
  for (const rule of QUALITY_RULES.slice(0, 5)) { // Check most important quality rules
    try {
      const result = execSync(
        `${NODE_TSX} crux/crux.mjs validate unified --rules=${rule} --ci 2>&1 | grep -i "${topicSlug}" || true`,
        { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }
      );
      const warningCount = (result.match(/warning/gi) || []).length;
      if (warningCount > 0) {
        issues.push(`[QUALITY] ${rule}: ${warningCount} warning(s)\n${result.trim()}`);
      }
    } catch {
      // Quality rule failures are non-fatal
    }
  }

  // Check for common content issues
  const content = fs.readFileSync(filePath, 'utf-8');

  // Check for unescaped dollar signs
  const bodyContent = content.replace(/^---[\s\S]*?---/, ''); // Strip frontmatter
  const unescapedDollar = bodyContent.match(/(?<!\\)\$\d/g);
  if (unescapedDollar) {
    issues.push(`[CRITICAL] Unescaped dollar signs found: ${unescapedDollar.length} instance(s)`);
  }

  // Check for undefined footnotes
  const footnoteRefs = bodyContent.match(/\[\^\d+\]/g) || [];
  const footnoteDefinitions = bodyContent.match(/^\[\^\d+\]:/gm) || [];
  const refNums = new Set(footnoteRefs.map(r => r.match(/\d+/)![0]));
  const defNums = new Set(footnoteDefinitions.map(d => d.match(/\d+/)![0]));
  const orphanRefs = [...refNums].filter(n => !defNums.has(n));
  if (orphanRefs.length > 0) {
    issues.push(`[QUALITY] Footnote references without definitions: [^${orphanRefs.join('], [^')}]`);
  }

  // Check for fake/undefined URLs
  const fakeUrlPatterns = /\[.*?\]\((?:undefined|example\.com|\/posts\/example)/g;
  const fakeUrls = bodyContent.match(fakeUrlPatterns);
  if (fakeUrls) {
    issues.push(`[CRITICAL] Fake/undefined URLs found: ${fakeUrls.length} instance(s)`);
  }

  return issues;
}

/**
 * Build a prompt asking Claude to fix validation issues in the content.
 */
function buildFixPrompt(content: string, issues: string[], ROOT: string): string {
  // Load path registry for EntityLink validation
  let entityIds = '';
  try {
    const registryPath = path.join(ROOT, 'app/src/data/pathRegistry.json');
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      entityIds = Object.keys(registry).slice(0, 100).join(', ');
    }
  } catch {
    // Non-fatal
  }

  return `# Fix Validation Issues in Wiki Article

## Current Content
\`\`\`mdx
${content}
\`\`\`

## Validation Issues Found
${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n\n')}

## Fix Instructions

Fix ALL the issues listed above. Specific fix guidance:

1. **Dollar signs**: Escape as \\$ (e.g., \\$100M not $100M)
2. **Comparison operators**: Use "less than" or \\< instead of bare < before numbers
3. **EntityLinks**: Use only valid IDs. Known IDs include: ${entityIds.slice(0, 500) || '(check pathRegistry.json)'}
   - If an EntityLink ID doesn't exist, REMOVE the EntityLink and use plain text instead
4. **Footnote citations**: Ensure all [^N] references have matching [^N]: definitions
   - If no real URL available, use text-only: [^1]: Source name - description
   - NEVER use fake URLs like "example.com" or "undefined"
5. **Frontmatter**: Ensure valid YAML with required fields (title, description, importance, lastEdited, ratings)
6. **Import statement**: Must include all used components from '@components/wiki'
7. **Markdown lists**: Numbered lists starting at N>1 need blank line before
8. **Consecutive bold labels**: Lines like "**Label:** text" need blank line between them

## Output

Output the COMPLETE fixed MDX file content. Include all frontmatter and content.
Start your response with "---" (the frontmatter delimiter).
Do NOT wrap in markdown code blocks.`;
}

// ---------------------------------------------------------------------------
// API-Direct Review
// ---------------------------------------------------------------------------

interface ReviewContext {
  ROOT: string;
  getTopicDir: (topic: string) => string;
  log: (phase: string, message: string) => void;
}

/**
 * Run a critical review using the Anthropic API directly (no subprocess).
 * Replaces runReview() from deployment.ts when in API-direct mode.
 */
export async function runReviewApiDirect(
  topic: string,
  { ROOT, getTopicDir, log }: ReviewContext
): Promise<{ success: boolean; error?: string }> {
  log('review', 'Running API-direct critical review...');

  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
  if (!fs.existsSync(draftPath)) {
    return { success: false, error: 'No draft found for review' };
  }

  const client = createClient(); // Throws if ANTHROPIC_API_KEY missing

  const draftContent = fs.readFileSync(draftPath, 'utf-8');

  const reviewPrompt = `# Critical Review: ${topic}

You are a skeptical editor doing a final quality check on this wiki article.

## Article Content
\`\`\`mdx
${draftContent.slice(0, 30000)}
\`\`\`

## HIGH PRIORITY - Logical Issues

1. **Section-content contradictions**: Does the content within a section contradict its heading?
2. **Self-contradicting quotes**: Are quotes used in contexts that contradict their meaning?
3. **Temporal artifacts**: Does the text expose when research was conducted?

## STANDARD CHECKS

4. **Uncited claims** - Major facts without footnote citations
5. **Missing topics** - Important aspects not covered based on the title
6. **One-sided framing** - Only positive or negative coverage
7. **Vague language** - "significant", "many experts" without specifics

## Output

Return a JSON object with your findings:
{
  "logicalIssues": ["list of logical contradictions found"],
  "temporalArtifacts": ["list of temporal references to remove"],
  "uncitedClaims": ["list of major uncited claims"],
  "missingTopics": ["important topics not covered"],
  "framingIssues": ["one-sided framing problems"],
  "overallAssessment": "brief summary of article quality"
}

If you find logicalIssues or temporalArtifacts, also output the fixed content sections.`;

  const stopHeartbeat = startHeartbeat('review', 30);
  try {
    const response = await withRetry(
      () => streamingCreate(client, {
        model: MODELS.sonnet,
        max_tokens: 4000,
        messages: [{ role: 'user', content: reviewPrompt }],
      }),
      { label: 'review' }
    );

    const text = extractText(response);

    // Write review results
    const reviewPath = path.join(getTopicDir(topic), 'review.json');
    try {
      const review = parseJsonResponse(text) as Record<string, unknown>;
      fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2));
      log('review', `Review written to ${reviewPath}`);

      // If temporal artifacts or logical issues found, log summary
      const hasIssues = ((review.logicalIssues as unknown[])?.length > 0) || ((review.temporalArtifacts as unknown[])?.length > 0);
      if (hasIssues) {
        log('review', `Found issues: ${(review.logicalIssues as unknown[])?.length || 0} logical, ${(review.temporalArtifacts as unknown[])?.length || 0} temporal`);
      }
    } catch {
      fs.writeFileSync(reviewPath, JSON.stringify({ raw: text }, null, 2));
    }

    return { success: true };
  } finally {
    stopHeartbeat();
  }
}
