#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Visual Review Pipeline
 *
 * Renders and reviews visuals using:
 * 1. Static syntax analysis (always runs)
 * 2. Mermaid CLI rendering validation (if available)
 * 3. Puppeteer screenshot + AI quality review (if --screenshot flag)
 *
 * Usage:
 *   crux visual review <page-id>                    # Static analysis only
 *   crux visual review <page-id> --screenshot        # Full screenshot + AI review
 *   crux visual review <page-id> --fix               # Show fix suggestions
 *   crux visual review --verbose                     # Review all pages with visuals
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, execSync } from 'child_process';
import { parseCliArgs } from '../lib/cli.ts';
import { createClient, callClaude, MODELS } from '../lib/anthropic.ts';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, isCI } from '../lib/output.ts';
import {
  type VisualType,
  VISUAL_DETECTION_PATTERNS,
  type VisualReviewResult,
  type SyntaxIssue,
} from './visual-types.ts';
import { VISUAL_REVIEW_SYSTEM_PROMPT } from './visual-prompts.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(PROJECT_ROOT, '.claude/temp/visual-review');
const SCREENSHOT_DIR = path.join(TEMP_DIR, 'screenshots');

// ============================================================================
// Visual extraction from MDX
// ============================================================================

interface ExtractedVisual {
  type: VisualType;
  code: string;
  line: number;
  raw: string;
}

function extractVisuals(content: string): ExtractedVisual[] {
  const visuals: ExtractedVisual[] = [];

  // Extract Mermaid diagrams
  const mermaidRegex = /<(?:MermaidDiagram|Mermaid)[^>]*chart=\{`([\s\S]*?)`\}[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = mermaidRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    visuals.push({
      type: 'mermaid',
      code: match[1],
      line,
      raw: match[0],
    });
  }

  // Extract Squiggle models
  const squiggleRegex = /<SquiggleEstimate[^>]*code=\{`([\s\S]*?)`\}[^>]*\/?>/g;
  while ((match = squiggleRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    visuals.push({
      type: 'squiggle',
      code: match[1],
      line,
      raw: match[0],
    });
  }

  // Extract CauseEffectGraph (detect presence but full code is complex JSX)
  const cegRegex = /<(?:CauseEffectGraph|PageCauseEffectGraph)[^>]*>/g;
  while ((match = cegRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    visuals.push({
      type: 'cause-effect',
      code: match[0],
      line,
      raw: match[0],
    });
  }

  // Extract ComparisonTable
  const ctRegex = /<ComparisonTable[\s\S]*?\/>/g;
  while ((match = ctRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    visuals.push({
      type: 'comparison',
      code: match[0],
      line,
      raw: match[0],
    });
  }

  // Extract DisagreementMap
  const dmRegex = /<DisagreementMap[\s\S]*?\/>/g;
  while ((match = dmRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    visuals.push({
      type: 'disagreement',
      code: match[0],
      line,
      raw: match[0],
    });
  }

  return visuals;
}

// ============================================================================
// Static analysis
// ============================================================================

function analyzeMermaidSyntax(code: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const lines = code.split('\n');

  // Check diagram type
  const firstNonEmpty = lines.find((l) => l.trim() && !l.trim().startsWith('%%'));
  if (firstNonEmpty) {
    const validTypes = [
      'flowchart',
      'graph',
      'pie',
      'quadrantChart',
      'timeline',
      'stateDiagram',
      'stateDiagram-v2',
      'erDiagram',
      'classDiagram',
      'gantt',
      'xychart-beta',
      'mindmap',
      'sankey',
      'sequenceDiagram',
      'journey',
      'requirementDiagram',
      'gitGraph',
      'block-beta',
    ];
    const hasType = validTypes.some((t) =>
      firstNonEmpty.trim().toLowerCase().startsWith(t.toLowerCase()),
    );
    if (!hasType) {
      issues.push({
        severity: 'error',
        message: `Missing or invalid diagram type: "${firstNonEmpty.trim().substring(0, 30)}"`,
        line: 1,
        fix: 'Start with: flowchart TD, pie, quadrantChart, timeline, etc.',
      });
    }
  }

  // Count nodes (rough estimate)
  const nodeCount = new Set(
    code.match(/\b([A-Z][a-zA-Z0-9_]*)\s*[\[\(\{]/g)?.map((m) =>
      m.replace(/[\[\(\{]/, '').trim(),
    ) || [],
  ).size;
  if (nodeCount > 20) {
    issues.push({
      severity: 'warning',
      message: `Too many nodes (${nodeCount}). Max recommended: 15-20.`,
      fix: 'Simplify the diagram or split into multiple diagrams.',
    });
  }

  // Check for single arrows
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\w\s*->(?!>|-)(?!\|)\s*\w/.test(line)) {
      issues.push({
        severity: 'error',
        message: 'Use --> instead of -> for flowchart arrows',
        line: i + 1,
        fix: 'Replace -> with -->',
      });
    }
  }

  // Check bracket balance
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%')) continue;
    const open = (line.match(/\[/g) || []).length;
    const close = (line.match(/\]/g) || []).length;
    if (open !== close) {
      issues.push({
        severity: 'error',
        message: 'Unbalanced brackets',
        line: i + 1,
        fix: 'Ensure all [ have matching ]',
      });
    }
  }

  // Check subgraph balance
  const subgraphOpens = (code.match(/\bsubgraph\b/g) || []).length;
  const subgraphEnds = code
    .split('\n')
    .filter((l) => l.trim() === 'end').length;
  if (subgraphOpens !== subgraphEnds) {
    issues.push({
      severity: 'error',
      message: `Subgraph mismatch: ${subgraphOpens} subgraph(s) but ${subgraphEnds} end(s)`,
      fix: 'Add missing "end" statements for subgraphs',
    });
  }

  return issues;
}

function analyzeSquiggleSyntax(code: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];

  // Check for point values in mixture()
  const mixtureRegex = /mixture\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mixtureRegex.exec(code)) !== null) {
    const args = match[1];
    // Look for bare numbers not in "X to Y" patterns
    const bareNumbers = args.match(/(?<!\w)(\d+(?:\.\d+)?(?:e\d+)?)(?!\s*to\b)/g);
    if (bareNumbers && bareNumbers.length > 0) {
      issues.push({
        severity: 'warning',
        message:
          'Point values in mixture() create jagged spikes. Use ranges like "X to Y" instead.',
        fix: 'Replace bare numbers with ranges: 500e9 → 400e9 to 650e9',
      });
    }
  }

  // Check line count
  const lineCount = code.split('\n').filter((l) => l.trim()).length;
  if (lineCount > 30) {
    issues.push({
      severity: 'warning',
      message: `Model is ${lineCount} lines (recommended max: 30). Consider splitting.`,
      fix: 'Split into multiple SquiggleEstimate components.',
    });
  }

  return issues;
}

function analyzeVisualSyntax(visual: ExtractedVisual): SyntaxIssue[] {
  switch (visual.type) {
    case 'mermaid':
      return analyzeMermaidSyntax(visual.code);
    case 'squiggle':
      return analyzeSquiggleSyntax(visual.code);
    default:
      return [];
  }
}

// ============================================================================
// Puppeteer screenshot (optional)
// ============================================================================

async function takeScreenshot(
  pageId: string,
  visualIndex: number,
): Promise<string | null> {
  // Check if puppeteer is available
  try {
    execSync('node -e "require(\'puppeteer\')"', {
      stdio: 'pipe',
      cwd: PROJECT_ROOT,
    });
  } catch {
    console.warn(
      'Puppeteer not installed. Install with: pnpm add -D puppeteer',
    );
    console.warn(
      'Falling back to static analysis only.\n',
    );
    return null;
  }

  // Check if dev server is running
  try {
    execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:3001', {
      stdio: 'pipe',
    });
  } catch {
    console.warn(
      'Dev server not running on port 3001. Start with: pnpm dev',
    );
    console.warn(
      'Falling back to static analysis only.\n',
    );
    return null;
  }

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const screenshotPath = path.join(
    SCREENSHOT_DIR,
    `${pageId}-visual-${visualIndex}.png`,
  );

  // Use a small Node script to take the screenshot
  const screenshotScript = `
    const puppeteer = require('puppeteer');
    (async () => {
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 800 });
      await page.goto('http://localhost:3001/${pageId}', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      // Wait for visuals to render
      await page.waitForTimeout(3000);
      await page.screenshot({ path: '${screenshotPath}', fullPage: true });
      await browser.close();
    })();
  `;

  const result = spawnSync('node', ['-e', screenshotScript], {
    encoding: 'utf-8',
    timeout: 60000,
    cwd: PROJECT_ROOT,
  });

  if (result.status !== 0) {
    console.warn(`Screenshot failed: ${result.stderr || 'unknown error'}`);
    return null;
  }

  return fs.existsSync(screenshotPath) ? screenshotPath : null;
}

// ============================================================================
// AI quality review
// ============================================================================

async function reviewWithAI(
  visual: ExtractedVisual,
  pageTitle: string,
): Promise<{ score: number; strengths: string[]; issues: string[]; suggestions: string[] } | null> {
  const client = createClient({ required: false });
  if (!client) return null;

  const prompt = `Review this ${visual.type} visual from the wiki page "${pageTitle}":

\`\`\`
${visual.code}
\`\`\`

Evaluate the visual for clarity, accuracy, aesthetics, and relevance.
Return ONLY a JSON object with: score (0-100), strengths (array), issues (array), suggestions (array).`;

  try {
    const result = await callClaude(client, {
      model: 'haiku',
      systemPrompt: VISUAL_REVIEW_SYSTEM_PROMPT,
      userPrompt: prompt,
      maxTokens: 1000,
      temperature: 0,
    });

    // Parse JSON response
    let cleaned = result.text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
    }

    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

// ============================================================================
// Page resolution
// ============================================================================

function findPageById(pageId: string): { filePath: string; content: string; title: string } | null {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  for (const file of files) {
    const slug = path.basename(file, path.extname(file));
    const relPath = path.relative(CONTENT_DIR_ABS, file);
    const id = relPath.replace(/\.mdx?$/, '');

    if (slug === pageId || id === pageId) {
      const content = fs.readFileSync(file, 'utf-8');
      const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      return {
        filePath: file,
        content,
        title: titleMatch?.[1] || slug,
      };
    }
  }
  return null;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const colors = getColors();
  const ci = isCI() || !!args.ci;

  const pageId = args._positional[0];
  const useScreenshot = !!args.screenshot;
  const showFix = !!args.fix;
  const verbose = !!args.verbose;

  // If no page ID, review all pages with visuals
  const pagesToReview: Array<{ filePath: string; content: string; title: string; slug: string }> = [];

  if (pageId) {
    const page = findPageById(pageId);
    if (!page) {
      console.error(`${colors.red}Error: page not found: ${pageId}${colors.reset}`);
      process.exit(1);
    }
    pagesToReview.push({ ...page, slug: pageId });
  } else {
    const files = findMdxFiles(CONTENT_DIR_ABS);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const visuals = extractVisuals(content);
      if (visuals.length > 0) {
        const slug = path.basename(file, path.extname(file));
        const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
        pagesToReview.push({
          filePath: file,
          content,
          title: titleMatch?.[1] || slug,
          slug,
        });
      }
    }
  }

  if (!ci) {
    console.log(
      `${colors.blue}Reviewing visuals in ${pagesToReview.length} page(s)...${colors.reset}\n`,
    );
  }

  let totalVisuals = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  const allResults: VisualReviewResult[] = [];

  for (const page of pagesToReview) {
    const visuals = extractVisuals(page.content);
    if (visuals.length === 0) continue;

    totalVisuals += visuals.length;
    const relPath = path.relative(PROJECT_ROOT, page.filePath);

    if (!ci) {
      console.log(
        `${colors.bold}${relPath}${colors.reset} ${colors.dim}(${visuals.length} visual${visuals.length > 1 ? 's' : ''})${colors.reset}`,
      );
    }

    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i];
      const syntaxIssues = analyzeVisualSyntax(visual);

      const errors = syntaxIssues.filter((i) => i.severity === 'error').length;
      const warnings = syntaxIssues.filter((i) => i.severity === 'warning').length;
      totalErrors += errors;
      totalWarnings += warnings;

      if (!ci) {
        const icon =
          errors > 0
            ? `${colors.red}✗`
            : warnings > 0
              ? `${colors.yellow}⚠`
              : `${colors.green}✓`;
        console.log(
          `  ${icon} [${visual.type}] line ${visual.line}${colors.reset}`,
        );

        for (const issue of syntaxIssues) {
          const issueIcon =
            issue.severity === 'error'
              ? `${colors.red}✗`
              : `${colors.yellow}⚠`;
          console.log(
            `    ${issueIcon} ${issue.message}${colors.reset}`,
          );
          if (showFix && issue.fix) {
            console.log(
              `      ${colors.cyan}Fix: ${issue.fix}${colors.reset}`,
            );
          }
        }
      }

      // AI quality review (for Mermaid and Squiggle where we have the raw code)
      let qualityReview = null;
      if (
        verbose &&
        (visual.type === 'mermaid' || visual.type === 'squiggle')
      ) {
        qualityReview = await reviewWithAI(visual, page.title);
        if (qualityReview && !ci) {
          console.log(
            `    ${colors.dim}AI Score: ${qualityReview.score}/100${colors.reset}`,
          );
          if (qualityReview.issues.length > 0) {
            for (const issue of qualityReview.issues) {
              console.log(`    ${colors.yellow}  → ${issue}${colors.reset}`);
            }
          }
        }
      }

      // Screenshot (if requested and this is a specific page)
      let screenshotPath: string | null = null;
      if (useScreenshot && pageId) {
        screenshotPath = await takeScreenshot(page.slug, i);
        if (screenshotPath && !ci) {
          console.log(
            `    ${colors.dim}Screenshot: ${path.relative(PROJECT_ROOT, screenshotPath)}${colors.reset}`,
          );
        }
      }

      allResults.push({
        pageId: page.slug,
        visualIndex: i,
        type: visual.type,
        syntaxIssues,
        qualityReview: qualityReview || undefined,
        screenshotPath: screenshotPath || undefined,
      });
    }

    if (!ci) console.log();
  }

  // Summary
  if (!ci) {
    console.log(`${colors.bold}Summary:${colors.reset}`);
    console.log(`  ${colors.dim}Pages: ${pagesToReview.length}${colors.reset}`);
    console.log(`  ${colors.dim}Visuals: ${totalVisuals}${colors.reset}`);
    if (totalErrors > 0) {
      console.log(`  ${colors.red}Errors: ${totalErrors}${colors.reset}`);
    }
    if (totalWarnings > 0) {
      console.log(
        `  ${colors.yellow}Warnings: ${totalWarnings}${colors.reset}`,
      );
    }
    if (totalErrors === 0 && totalWarnings === 0) {
      console.log(
        `  ${colors.green}All visuals passed static analysis${colors.reset}`,
      );
    }
    if (!showFix && (totalErrors > 0 || totalWarnings > 0)) {
      console.log(
        `\n${colors.dim}Run with --fix for fix suggestions${colors.reset}`,
      );
    }
    if (!verbose) {
      console.log(
        `${colors.dim}Run with --verbose for AI quality review${colors.reset}`,
      );
    }
  }

  if (ci) {
    console.log(
      JSON.stringify({
        pages: pagesToReview.length,
        visuals: totalVisuals,
        errors: totalErrors,
        warnings: totalWarnings,
        results: allResults,
      }),
    );
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
